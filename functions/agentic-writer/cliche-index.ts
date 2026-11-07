/**
 * Cliché index — the pipeline's READ side.
 *
 * The build used to live here too (`analyzeCliches`, plus its own model caller, JSON extractor,
 * text matcher and merge). It moved to the browser: `src/app/stories/services/
 * cliche-index-builder.service.ts` and `cliche-build.util.ts`. That was a **move, not a copy** —
 * nothing analysis-shaped remains on this side, so there is no duplicated pair here for
 * `check:shared-constants` to police.
 *
 * The file is named for what it now does. It was `cliche-analyzer.ts` up to the move, and a file
 * by that name containing no analyzer is a trap for the next reader.
 *
 * Exports:
 *   fetchStoryClicheIndex()      — read the index for pipeline use
 *   formatClicheIndexForPrompt() — format entries for injection into `/analyze`
 */

import { SupabaseClient } from 'npm:@supabase/supabase-js@2';

export interface ClicheIndexEntry {
  phrase: string;
  category: string;
  source: string;
  occurrence_count: number;
}

export async function fetchStoryClicheIndex(
  userClient: SupabaseClient,
  storyId: string,
): Promise<ClicheIndexEntry[]> {
  const { data, error } = await userClient
    .from('story_cliche_index')
    .select('phrase, category, source, occurrence_count')
    .eq('story_id', storyId)
    .order('category');

  if (error) {
    console.warn('[ClicheIndex] Failed to fetch cliché index:', error.message);
    return [];
  }

  return data || [];
}

export function formatClicheIndexForPrompt(entries: ClicheIndexEntry[]): string {
  if (entries.length === 0) return '';

  const byCategory = new Map<string, ClicheIndexEntry[]>();
  for (const e of entries) {
    const list = byCategory.get(e.category) || [];
    list.push(e);
    byCategory.set(e.category, list);
  }

  const lines: string[] = [
    '',
    'CLICHÉ INDEX — Avoid these phrases or close variants. Do NOT replace a cliché with another phrase from the same category.',
    '',
  ];

  for (const [category, items] of byCategory) {
    const label = category.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    lines.push(`[${label}]`);
    for (const item of items) {
      lines.push(`- "${item.phrase}"`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
