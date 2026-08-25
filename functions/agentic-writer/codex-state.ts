/**
 * Pipeline helpers for injecting per-entry "current state" into the writer
 * model's prompt. Mirrors the cliché-block pattern in cliche-analyzer.ts —
 * read from the user-scoped Supabase client, format for prompt, return ''
 * when there's nothing to surface.
 *
 * Source table: `codex_entry_current_state` (one row per codex entry, single
 * cumulative state populated by the user via the codex modal's
 * "Track All / Latest Scenes" actions).
 */

import { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { CodexEntryData } from './research.ts';

export interface CodexCurrentStateRow {
  entry_id: string;
  state: string;
  hooks: string | null;
  last_scene_id: string | null;
  last_scene_title: string | null;
  updated_at: string;
}

const MAX_ENTRIES_IN_BLOCK = 30;
const MAX_BLOCK_CHARS = 12_000;

export async function fetchStoryCodexStates(
  userClient: SupabaseClient,
  storyId: string,
): Promise<CodexCurrentStateRow[]> {
  const { data, error } = await userClient
    .from('codex_entry_current_state')
    .select('entry_id, state, hooks, last_scene_id, last_scene_title, updated_at')
    .eq('story_id', storyId)
    .order('updated_at', { ascending: false })
    .limit(MAX_ENTRIES_IN_BLOCK);

  if (error) {
    console.warn('[CodexState] fetch failed:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Build a "CURRENT CODEX STATE" prompt block. Only entries also present in
 * `codexEntries` (the research-loaded set) are included, capped at
 * MAX_ENTRIES_IN_BLOCK. If `excludeSceneId` is provided, rows whose
 * last_scene_id matches are dropped — used by /refine to avoid anchoring on
 * the very scene's own (about-to-be-replaced) extracted state.
 */
export function formatCodexStateForPrompt(
  states: CodexCurrentStateRow[],
  codexEntries: Pick<CodexEntryData, 'id' | 'title'>[],
  opts: { excludeSceneId?: string } = {},
): string {
  if (states.length === 0 || codexEntries.length === 0) return '';
  const titleById = new Map(codexEntries.map(e => [e.id, e.title]));

  const filtered = states
    .filter(s => titleById.has(s.entry_id))
    .filter(s => !opts.excludeSceneId || s.last_scene_id !== opts.excludeSceneId)
    // Defensive: fetchStoryCodexStates already LIMITs to MAX_ENTRIES_IN_BLOCK,
    // but the formatter is a public export and may receive stubs in tests.
    .slice(0, MAX_ENTRIES_IN_BLOCK);
  if (filtered.length === 0) return '';

  const lines: string[] = [
    '',
    'CURRENT CODEX STATE — Established narrative state as of the last tracked scene. Do not contradict it (location, condition, knowledge, alliances) unless this scene explicitly changes it.',
    '',
  ];
  for (const row of filtered) {
    lines.push(`[${titleById.get(row.entry_id)}]`);
    lines.push(`State: ${row.state}`);
    if (row.hooks?.trim()) lines.push(`Open tensions: ${row.hooks}`);
    if (row.last_scene_title) lines.push(`(as of: ${row.last_scene_title})`);
    lines.push('');
  }

  let block = lines.join('\n').trimEnd();
  if (block.length > MAX_BLOCK_CHARS) {
    block = block.substring(0, MAX_BLOCK_CHARS) + '\n...[truncated]';
    console.warn('[CodexState] block truncated to', MAX_BLOCK_CHARS, 'chars');
  }
  return block;
}
