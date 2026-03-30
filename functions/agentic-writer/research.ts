/**
 * Data-fetching utilities for the agentic writer research phase.
 * Provides DB access for codex entries, scenes, and story outline.
 */

import { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { ResearchPlan, ResearchTask } from './planner.ts';

const MAX_SCENE_TEXT_LENGTH = 15_000;

export interface CodexEntryData {
  title: string;
  content: string;
  metadata: Record<string, unknown> | null;
  story_role: string | null;
}

export interface SceneData {
  id: string;
  title: string;
  content: string;
}

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
  /** Full story data cache for agent tool lookups (avoids redundant DB queries) */
  fullCache: { codexEntries: CodexEntryData[]; scenes: SceneData[] };
}

export async function fetchResearchData(
  plan: ResearchPlan,
  storyId: string,
  userClient: SupabaseClient,
  currentSceneId?: string,
): Promise<FetchResearchResult> {
  const emptyResult: FetchResearchResult = {
    taskDataMap: new Map(),
    fullCache: { codexEntries: [], scenes: [] },
  };

  if (plan.tasks.length === 0) return emptyResult;

  // Always fetch all codex entries and scenes — agents may discover
  // entities/scenes beyond what the planner identified via tool calls.
  const [allCodexEntries, allScenes] = await Promise.all([
    fetchAllCodexEntries(storyId, userClient),
    fetchAllScenes(storyId, userClient, currentSceneId),
  ]);

  // Distribute pre-matched data to each task
  const taskDataMap = new Map<string, { codexEntries: CodexEntryData[]; scenes: SceneData[] }>();
  for (let i = 0; i < plan.tasks.length; i++) {
    const task = plan.tasks[i];
    const taskEntries = allCodexEntries.filter(entry =>
      task.entities.some(name => nameMatches(entry, name))
    );
    const taskScenes = allScenes.filter(scene =>
      task.scenes.some(title =>
        scene.title.toLowerCase().includes(title.toLowerCase()) ||
        title.toLowerCase().includes(scene.title.toLowerCase())
      )
    );
    taskDataMap.set(String(i), { codexEntries: taskEntries, scenes: taskScenes });
  }

  return {
    taskDataMap,
    fullCache: { codexEntries: allCodexEntries, scenes: allScenes },
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
    .select('title, content, metadata, story_role')
    .eq('codex_id', story.codex_id);

  if (entriesError) {
    console.warn('[Research] Failed to fetch codex entries:', entriesError.message);
    return [];
  }
  if (!entries) return [];

  return entries.map((e: CodexEntryData) => ({
    title: e.title,
    content: stripHtml(e.content || ''),
    metadata: e.metadata,
    story_role: e.story_role,
  }));
}

async function fetchAllScenes(
  storyId: string,
  userClient: SupabaseClient,
  currentSceneId?: string,
): Promise<SceneData[]> {
  const { data: scenes, error } = await userClient
    .from('scenes')
    .select('id, title, content')
    .eq('story_id', storyId);

  if (error) {
    console.warn('[Research] Failed to fetch scenes:', error.message);
    return [];
  }
  if (!scenes) return [];

  return scenes
    .filter((s: SceneData) => s.id !== currentSceneId)
    .map((s: SceneData) => {
      const cleaned = stripHtml(s.content || '');
      return {
        id: s.id,
        title: s.title,
        content: cleaned.length > MAX_SCENE_TEXT_LENGTH
          ? cleaned.substring(0, MAX_SCENE_TEXT_LENGTH) + '...[truncated]'
          : cleaned,
      };
    });
}
