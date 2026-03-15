import { SupabaseClient } from 'npm:@supabase/supabase-js@2';

const MAX_SCENE_TEXT_LENGTH = 15000;

interface AnalysisOutput {
  entities: string[];
  scenes: string[];
  focus: string[];
}

interface CodexEntry {
  title: string;
  content: string;
  metadata: Record<string, unknown> | null;
  story_role: string | null;
}

interface SceneResult {
  title: string;
  content: string;
}

/**
 * Parse the structured JSON output from the analyze step.
 * Handles malformed JSON gracefully.
 */
export function parseAnalysisOutput(raw: string): AnalysisOutput {
  try {
    // Try to extract JSON from the response (may have markdown code fences)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[Research] No JSON found in analysis output');
      return { entities: [], scenes: [], focus: [] };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      entities: Array.isArray(parsed.entities) ? parsed.entities.slice(0, 5) : [],
      scenes: Array.isArray(parsed.scenes) ? parsed.scenes.slice(0, 3) : [],
      focus: Array.isArray(parsed.focus) ? parsed.focus.slice(0, 3) : [],
    };
  } catch (err) {
    console.error('[Research] Failed to parse analysis output:', err);
    return { entities: [], scenes: [], focus: [] };
  }
}

/**
 * Case-insensitive name matching (matches title or aliases in metadata).
 * Same logic as frontend AiToolExecutorService.nameMatches.
 */
function nameMatches(entry: CodexEntry, searchName: string): boolean {
  const lower = searchName.toLowerCase();
  if (entry.title.toLowerCase().includes(lower) || lower.includes(entry.title.toLowerCase())) {
    return true;
  }
  // Check aliases in metadata
  const aliases = (entry.metadata as { aliases?: string[] })?.aliases;
  if (Array.isArray(aliases)) {
    return aliases.some(alias =>
      alias.toLowerCase().includes(lower) || lower.includes(alias.toLowerCase())
    );
  }
  return false;
}

/**
 * Run the research phase: query DB for codex entries and scenes.
 * Uses user-scoped client (RLS enforces ownership).
 */
export async function runResearch(
  analysisJson: AnalysisOutput,
  storyId: string,
  userClient: SupabaseClient
): Promise<string> {
  const { entities, scenes: sceneTitles } = analysisJson;

  let matchedEntries: CodexEntry[] = [];
  let matchedScenes: SceneResult[] = [];

  // 1. Get story's codex_id
  const { data: story } = await userClient
    .from('stories')
    .select('codex_id')
    .eq('id', storyId)
    .single();

  // 2. Look up codex entries by name/alias matching
  if (story?.codex_id && entities.length > 0) {
    const { data: allEntries } = await userClient
      .from('codex_entries')
      .select('title, content, metadata, story_role')
      .eq('codex_id', story.codex_id);

    if (allEntries) {
      matchedEntries = allEntries.filter((entry: CodexEntry) =>
        entities.some(name => nameMatches(entry, name))
      );
    }
  }

  // 3. Look up scene content by title matching
  if (sceneTitles.length > 0) {
    const { data: allScenes } = await userClient
      .from('scenes')
      .select('title, content')
      .eq('story_id', storyId);

    if (allScenes) {
      matchedScenes = allScenes
        .filter((scene: SceneResult) =>
          sceneTitles.some(title =>
            scene.title.toLowerCase().includes(title.toLowerCase()) ||
            title.toLowerCase().includes(scene.title.toLowerCase())
          )
        )
        .map((scene: SceneResult) => ({
          title: scene.title,
          content: scene.content?.length > MAX_SCENE_TEXT_LENGTH
            ? scene.content.substring(0, MAX_SCENE_TEXT_LENGTH) + '...[truncated]'
            : scene.content,
        }));
    }
  }

  // 4. Format as context XML
  return formatResearchResults(matchedEntries, matchedScenes);
}

function formatResearchResults(entries: CodexEntry[], scenes: SceneResult[]): string {
  if (entries.length === 0 && scenes.length === 0) {
    return '';
  }

  let xml = '<research-context>\n';

  if (entries.length > 0) {
    xml += '<codex-entries>\n';
    for (const entry of entries) {
      xml += `<entry title="${escapeXml(entry.title)}"`;
      if (entry.story_role) xml += ` role="${escapeXml(entry.story_role)}"`;
      xml += `>\n${entry.content}\n</entry>\n`;
    }
    xml += '</codex-entries>\n';
  }

  if (scenes.length > 0) {
    xml += '<referenced-scenes>\n';
    for (const scene of scenes) {
      xml += `<scene title="${escapeXml(scene.title)}">\n${scene.content}\n</scene>\n`;
    }
    xml += '</referenced-scenes>\n';
  }

  xml += '</research-context>';
  return xml;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
