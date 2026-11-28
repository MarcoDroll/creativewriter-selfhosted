/**
 * Deno tests for blank names in the research phase's codex matching (#1200).
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/agentic-writer/_tests_/blank-names.test.ts
 *
 * `nameMatches` compares in both substring directions, and `x.includes('')` is always
 * true. So a blank planner entity put the whole codex into its research task, and an
 * untitled codex entry answered every `get_codex_entry` call that reached it first.
 */

import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { fetchResearchData } from '../research.ts';
import type { CodexEntryData, StoryDataCache } from '../research.ts';
import { executeAgentToolCall } from '../agent-tools.ts';
import type { ResearchPlan } from '../planner.ts';

interface EntryRow { id: string; title: string; content: string; metadata: Record<string, unknown> | null }

/** Answers the three reads `fetchResearchData` makes: the story's codex id, its entries, the scene index. */
function fakeClient(entries: EntryRow[]): SupabaseClient {
  const answer = (table: string) => {
    if (table === 'stories') return { data: { codex_id: 'codex-1' }, error: null };
    if (table === 'codex_entries') return { data: entries, error: null };
    return { data: [], error: null };
  };
  const builder = (table: string) => {
    const chain = {
      select() { return chain; },
      eq() { return chain; },
      in() { return chain; },
      abortSignal() { return chain; },
      single() { return Promise.resolve(answer(table)); },
      maybeSingle() { return Promise.resolve(answer(table)); },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(answer(table)).then(resolve, reject);
      },
    };
    return chain;
  };
  return { from: builder } as unknown as SupabaseClient;
}

const row = (title: string, aliases?: string): EntryRow => ({
  id: title || 'untitled',
  title,
  content: `About ${title || 'nobody'}.`,
  metadata: aliases === undefined ? null : { aliases },
});

// 'Yen  nefer' holds a double space, which a raw '  ' entity is a substring of.
const CODEX = [row('Geralt'), row('Yen  nefer'), row('Novigrad')];

async function entriesFor(entities: string[], codex: EntryRow[] = CODEX): Promise<string[]> {
  const plan = { tasks: [{ focus: 'f', entities, scenes: [] }] } as ResearchPlan;
  const { taskDataMap } = await fetchResearchData(plan, 'story', fakeClient(codex));
  return taskDataMap.get('0')!.codexEntries.map(e => e.title);
}

Deno.test('a blank entity pulls no codex entry into its task', async () => {
  assertEquals(await entriesFor(['']), []);
  assertEquals(await entriesFor(['  ']), []);
});

Deno.test('a blank entity beside a real one pulls in only the real one', async () => {
  assertEquals(await entriesFor(['', 'Geralt', '  ']), ['Geralt']);
});

Deno.test('an untitled entry is not pulled into every task', async () => {
  assertEquals(await entriesFor(['Geralt'], [row(''), row('  '), ...CODEX]), ['Geralt']);
});

function cacheOf(...codexEntries: CodexEntryData[]): StoryDataCache {
  return { codexEntries, scenes: [], loadSceneText: () => Promise.resolve(null) };
}

const lookup = (name: string, cache: StoryDataCache) =>
  executeAgentToolCall('get_codex_entry', { name }, cache);

Deno.test('get_codex_entry skips an untitled entry that comes first', async () => {
  const out = await lookup('Geralt', cacheOf(row(''), row('   '), row('Geralt')));
  assertStringIncludes(out, '[Geralt]');
  assertStringIncludes(out, 'About Geralt.');
});

Deno.test('get_codex_entry answers a blank or missing name with no entry', async () => {
  // Read raw, '  ' was a substring of 'Yen  nefer' and answered with it.
  assertEquals(await lookup('  ', cacheOf(...CODEX)), 'No name provided');
  assertEquals(await executeAgentToolCall('get_codex_entry', { name: 42 }, cacheOf(...CODEX)), 'No name provided');
});

// The tool's name comes from the model untrimmed. Compared raw, neither substring direction
// holds in either case below.
Deno.test('a padded name or title is matched trimmed', async () => {
  assertStringIncludes(await lookup('Geralt ', cacheOf(row('Novigrad'), row('Old Geralt'))), '[Old Geralt]');
  assertStringIncludes(await lookup('Geralt of Rivia', cacheOf(row('Novigrad'), row(' Geralt'))), '[ Geralt]');
});

Deno.test('an untitled entry is still found by its alias', async () => {
  const out = await lookup('White Wolf', cacheOf(row('Novigrad'), row('', 'White Wolf')));
  assertStringIncludes(out, '\nAliases: White Wolf');
  assertEquals(out.startsWith('[]'), true);
});
