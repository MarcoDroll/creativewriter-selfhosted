/**
 * Deno tests for the two agentic-writer readers of `codex_entries.metadata.aliases` (#898):
 * the research phase's `nameMatches` (which codex entries a task's entities pull in) and the
 * `get_codex_entry` tool (which entry a lookup answers with, and its `Aliases:` line).
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/agentic-writer/_tests_/codex-aliases-readers.test.ts
 *
 * Both used to read aliases only under `Array.isArray`, while every writer stores the
 * canonical comma-string. So an alias the author typed never matched and was never shown.
 * They now read through `_shared/codex-aliases.ts`, the Edge twin of the client's
 * `coerceAliases`.
 */

import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { nameMatches } from '../research.ts';
import type { CodexEntryData, StoryDataCache } from '../research.ts';
import { executeAgentToolCall } from '../agent-tools.ts';

function entry(title: string, aliases: unknown): CodexEntryData {
  return { id: title.toLowerCase(), title, content: `About ${title}.`, metadata: { aliases } };
}

function cacheOf(...codexEntries: CodexEntryData[]): StoryDataCache {
  return { codexEntries, scenes: [], loadSceneText: () => Promise.resolve(null) };
}

const lookup = (name: string, cache: StoryDataCache) =>
  executeAgentToolCall('get_codex_entry', { name }, cache);

Deno.test('a comma-string alias matches a research entity', () => {
  const geralt = entry('Geralt', 'der Hexer, Weißhaar');
  assertEquals(nameMatches(geralt, 'Weißhaar'), true);
  assertEquals(nameMatches(geralt, 'der hexer'), true);
  // The other direction: the entity names more than the alias does.
  assertEquals(nameMatches(entry('White Wolf', 'der Hexer, Weißhaar'), 'der Hexer von Riva'), true);
  assertEquals(nameMatches(geralt, 'Yennefer'), false);
});

Deno.test('the codex lookup answers by a comma-string alias and lists the aliases', async () => {
  const cache = cacheOf(entry('Yennefer', 'Yen'), entry('Geralt', 'der Hexer, Weißhaar'));
  const out = await lookup('Weißhaar', cache);
  assertStringIncludes(out, '[Geralt]');
  assertStringIncludes(out, '\nAliases: der Hexer, Weißhaar');
});

Deno.test('a legacy array with a comma inside an element still matches and is listed whole', async () => {
  const carl = entry('General', ['von Clausewitz, Karl', 'Carl']);
  assertEquals(nameMatches(carl, 'Carl'), true);
  assertEquals(nameMatches(carl, 'von Clausewitz, Karl'), true);
  const out = await lookup('Carl', cacheOf(carl));
  assertStringIncludes(out, '[General]');
  assertStringIncludes(out, '\nAliases: von Clausewitz, Karl, Carl');
});

// A blank alias is a substring of every name, so read raw it pulled the entry into every
// task and answered every lookup.
Deno.test('a blank alias does not match every name', async () => {
  assertEquals(nameMatches(entry('Geralt', 'Weißhaar, '), 'Yennefer'), false);
  assertEquals(nameMatches(entry('Geralt', ['', 'Weißhaar']), 'Yennefer'), false);
  const out = await lookup('Yennefer', cacheOf(entry('Geralt', ['', '  ', 'Weißhaar'])));
  assertEquals(out, 'No codex entry found matching "Yennefer"');
});

Deno.test('a non-string array member is skipped, not a failed lookup', async () => {
  // Titled so that only the alias can match: read raw, `42.toLowerCase()` threw.
  const ciri = entry('The Princess', [42, null, 'Ciri']);
  assertEquals(nameMatches(ciri, 'Ciri'), true);
  const out = await lookup('Ciri', cacheOf(ciri));
  assertStringIncludes(out, '[The Princess]');
  assertStringIncludes(out, '\nAliases: Ciri');
});

Deno.test('an entry with no aliases gets no Aliases line', async () => {
  for (const aliases of [undefined, '', ' , ', []]) {
    const out = await lookup('Geralt', cacheOf(entry('Geralt', aliases)));
    assertEquals(out, '[Geralt]\nAbout Geralt.');
  }
});
