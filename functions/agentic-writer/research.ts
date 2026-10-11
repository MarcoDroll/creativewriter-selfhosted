/**
 * Data-fetching utilities for the agentic writer research phase.
 * Provides DB access for codex entries, scenes, and story outline.
 */

import { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { ResearchPlan } from './planner.ts';
import type { StoryDataCache } from './agent-tools.ts';

const MAX_SCENE_TEXT_LENGTH = 15_000;
/** Most scenes read up front for the tasks; the rest are fetched only if a tool call asks. */
const MAX_PRELOADED_SCENES = 12;

export interface CodexEntryData {
  id: string;
  title: string;
  content: string;
  metadata: Record<string, unknown> | null;
}

export interface SceneData {
  id: string;
  title: string;
  content: string;
}

/** A scene without its prose: what the story index holds for every scene. */
export interface SceneRef {
  id: string;
  title: string;
}

/**
 * Resolves a scene's cleaned text on demand. `null` means it could not be read (a query
 * error, or the row is gone) — distinct from `''`, a scene that is genuinely empty.
 */
export type SceneTextLoader = (sceneId: string) => Promise<string | null>;

/**
 * Case-insensitive name matching (matches title or aliases in metadata).
 * Same logic as frontend AiToolExecutorService.nameMatches.
 */
export function nameMatches(
  entry: { title: string; metadata: Record<string, unknown> | null },
  searchName: string,
): boolean {
  const lower = searchName.toLowerCase();
  if (entry.title.toLowerCase().includes(lower) || lower.includes(entry.title.toLowerCase())) {
    return true;
  }
  const aliases = (entry.metadata as { aliases?: string[] })?.aliases;
  if (Array.isArray(aliases)) {
    return aliases.some(alias =>
      alias.toLowerCase().includes(lower) || lower.includes(alias.toLowerCase())
    );
  }
  return false;
}

/**
 * Strip HTML tags, beat markers, and decode common entities to produce clean text.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[Beat:[^\]]*\]/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Fetch all raw data needed for the research agents based on the planning output.
 * Deduplicates entity/scene references across tasks, fetches in parallel.
 * Returns a map keyed by task index → { codexEntries, scenes }.
 */
export interface FetchResearchResult {
  /** Per-task data: task index → matched codex entries + scenes */
  taskDataMap: Map<string, { codexEntries: CodexEntryData[]; scenes: SceneData[] }>;
  /**
   * Story data for agent tool lookups. Codex entries are held in full; scenes are an
   * index (id + title) plus a loader, so a scene's prose is read only when a task or a
   * tool call actually names it.
   */
  fullCache: StoryDataCache;
}

export async function fetchResearchData(
  plan: ResearchPlan,
  storyId: string,
  userClient: SupabaseClient,
  currentSceneId?: string,
): Promise<FetchResearchResult> {
  const emptyResult: FetchResearchResult = {
    taskDataMap: new Map(),
    fullCache: { codexEntries: [], scenes: [], loadSceneText: () => Promise.resolve(null) },
  };

  if (plan.tasks.length === 0) return emptyResult;

  // Always fetch all codex entries and the scene index — agents may discover
  // entities/scenes beyond what the planner identified via tool calls. Scene PROSE is the
  // expensive part (a whole manuscript, read on every research run), so it is fetched only
  // for the scenes a task names, and lazily for the ones a tool call asks for later.
  const [allCodexEntries, sceneIndex] = await Promise.all([
    fetchAllCodexEntries(storyId, userClient),
    fetchSceneIndex(storyId, userClient, currentSceneId),
  ]);

  // A blank title is a substring of every scene title, so it would "name" the whole story.
  const matchesTask = (scene: SceneRef, task: { scenes: string[] }) =>
    task.scenes.some(title => {
      if (title.trim() === '') return false;
      return scene.title.toLowerCase().includes(title.toLowerCase()) ||
        title.toLowerCase().includes(scene.title.toLowerCase());
    });

  // Bounded: a generic title ("Scene") can match dozens of scenes, and the ids ride in the
  // request URL. Scenes past the cap stay reachable through get_scene_text.
  const wantedIds = new Set(
    sceneIndex
      .filter(scene => plan.tasks.some(task => matchesTask(scene, task)))
      .slice(0, MAX_PRELOADED_SCENES)
      .map(scene => scene.id),
  );

  const sceneText = createSceneTextLoader(storyId, userClient);
  await sceneText.preload([...wantedIds]);

  // Distribute pre-matched data to each task
  const taskDataMap = new Map<string, { codexEntries: CodexEntryData[]; scenes: SceneData[] }>();
  for (let i = 0; i < plan.tasks.length; i++) {
    const task = plan.tasks[i];
    const taskEntries = allCodexEntries.filter(entry =>
      task.entities.some(name => nameMatches(entry, name))
    );
    const matched = sceneIndex.filter(scene => wantedIds.has(scene.id) && matchesTask(scene, task));
    const loaded = await Promise.all(matched.map(scene => sceneText.load(scene.id)));
    const taskScenes: SceneData[] = [];
    matched.forEach((scene, n) => {
      const content = loaded[n];
      if (content !== null) taskScenes.push({ id: scene.id, title: scene.title, content });
    });
    taskDataMap.set(String(i), { codexEntries: taskEntries, scenes: taskScenes });
  }

  return {
    taskDataMap,
    fullCache: { codexEntries: allCodexEntries, scenes: sceneIndex, loadSceneText: sceneText.load },
  };
}

/**
 * Fetch story outline: chapter/scene titles and summaries.
 * Lightweight structural context for research agents.
 */
export async function fetchStoryOutline(
  storyId: string,
  userClient: SupabaseClient,
): Promise<string> {
  const { data: chapters, error: chaptersError } = await userClient
    .from('chapters')
    .select('id, title, chapter_number')
    .eq('story_id', storyId)
    .order('chapter_number', { ascending: true });

  if (chaptersError) {
    console.warn('[Research] Failed to fetch chapters for outline:', chaptersError.message);
    return '';
  }
  if (!chapters || chapters.length === 0) return '';

  const { data: scenes, error: scenesError } = await userClient
    .from('scenes')
    .select('title, summary, chapter_id, scene_number')
    .eq('story_id', storyId)
    .order('scene_number', { ascending: true });

  if (scenesError) {
    console.warn('[Research] Failed to fetch scenes for outline:', scenesError.message);
  }

  const scenesByChapter = new Map<string, Array<{ title: string; summary: string | null; scene_number: number }>>();
  for (const scene of (scenes || [])) {
    const list = scenesByChapter.get(scene.chapter_id) || [];
    list.push({ title: scene.title, summary: scene.summary, scene_number: scene.scene_number });
    scenesByChapter.set(scene.chapter_id, list);
  }

  let outline = '';
  for (const chapter of chapters) {
    outline += `Chapter ${chapter.chapter_number}: ${chapter.title}\n`;
    const chapterScenes = scenesByChapter.get(chapter.id) || [];
    for (const scene of chapterScenes) {
      outline += `  - ${scene.title}`;
      if (scene.summary) outline += `: ${scene.summary}`;
      outline += '\n';
    }
  }

  return outline.trim();
}

// --- Internal fetch helpers ---

async function fetchAllCodexEntries(
  storyId: string,
  userClient: SupabaseClient,
): Promise<CodexEntryData[]> {
  const { data: story, error: storyError } = await userClient
    .from('stories')
    .select('codex_id')
    .eq('id', storyId)
    .single();

  if (storyError) {
    console.warn('[Research] Failed to fetch story codex_id:', storyError.message);
    return [];
  }
  if (!story?.codex_id) return [];

  const { data: entries, error: entriesError } = await userClient
    .from('codex_entries')
    .select('id, title, content, metadata')
    .eq('codex_id', story.codex_id);

  if (entriesError) {
    console.warn('[Research] Failed to fetch codex entries:', entriesError.message);
    return [];
  }
  if (!entries) return [];

  return entries.map((e: CodexEntryData) => ({
    id: e.id,
    title: e.title,
    content: stripHtml(e.content || ''),
    metadata: e.metadata,
  }));
}

/** Ids and titles only — `content` is the whole manuscript and stays out of this read. */
async function fetchSceneIndex(
  storyId: string,
  userClient: SupabaseClient,
  currentSceneId?: string,
): Promise<SceneRef[]> {
  const { data: scenes, error } = await userClient
    .from('scenes')
    .select('id, title')
    .eq('story_id', storyId);

  if (error) {
    console.warn('[Research] Failed to fetch scenes:', error.message);
    return [];
  }
  if (!scenes) return [];

  return scenes.filter((s: SceneRef) => s.id !== currentSceneId);
}

function cleanSceneText(html: string | null): string {
  const cleaned = stripHtml(html || '');
  return cleaned.length > MAX_SCENE_TEXT_LENGTH
    ? cleaned.substring(0, MAX_SCENE_TEXT_LENGTH) + '...[truncated]'
    : cleaned;
}

/**
 * Reads scene prose on demand and remembers it for the rest of the run, so several tasks
 * (or tool rounds) naming the same scene cost one read. A failed read is not remembered:
 * a later ask tries again.
 */
export function createSceneTextLoader(
  storyId: string,
  userClient: SupabaseClient,
): { load: SceneTextLoader; preload: (sceneIds: string[]) => Promise<void> } {
  const texts = new Map<string, Promise<string | null>>();

  const read = async (sceneId: string): Promise<string | null> => {
    try {
      const { data, error } = await userClient
        .from('scenes')
        .select('content')
        .eq('story_id', storyId)
        .eq('id', sceneId)
        .maybeSingle();
      if (!error && data) return cleanSceneText(data.content);
      if (error) console.warn('[Research] Failed to fetch scene text:', error.message);
    } catch (err) {
      console.warn('[Research] Failed to fetch scene text:', (err as Error).message);
    }
    return null;
  };

  const load: SceneTextLoader = (sceneId) => {
    const known = texts.get(sceneId);
    if (known) return known;
    // The forget-on-failure runs in a `.then`, so it always lands after `texts.set` — even
    // when `read` fails before its first await.
    const pending = read(sceneId).then((text) => {
      if (text === null) texts.delete(sceneId);
      return text;
    });
    texts.set(sceneId, pending);
    return pending;
  };

  // One query for the scenes the plan names, instead of one per scene.
  const preload = async (sceneIds: string[]): Promise<void> => {
    const missing = sceneIds.filter(id => !texts.has(id));
    if (missing.length === 0) return;
    try {
      const { data, error } = await userClient
        .from('scenes')
        .select('id, content')
        .eq('story_id', storyId)
        .in('id', missing);
      if (error) {
        console.warn('[Research] Failed to fetch scenes:', error.message);
        return;
      }
      for (const row of (data || []) as Array<{ id: string; content: string | null }>) {
        texts.set(row.id, Promise.resolve(cleanSceneText(row.content)));
      }
    } catch (err) {
      console.warn('[Research] Failed to fetch scenes:', (err as Error).message);
    }
  };

  return { load, preload };
}
