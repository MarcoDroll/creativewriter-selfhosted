/**
 * Deno tests for `formatCodexStateForPrompt`.
 *
 * Run locally with:
 *   deno test supabase/functions/agentic-writer/codex-state.test.ts
 *
 * Run in CI via the "Test (Edge Functions / Deno)" step in ci.yml's
 * lint-and-test job. They exist as a regression guard for the pipeline
 * pure-formatter contract.
 */

import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  formatCodexStateForPrompt,
  type CodexCurrentStateRow,
} from './codex-state.ts';

interface TestEntry {
  id: string;
  title: string;
}

function makeRow(overrides: Partial<CodexCurrentStateRow> & { entry_id: string }): CodexCurrentStateRow {
  return {
    state: 'state',
    hooks: null,
    last_scene_id: null,
    last_scene_title: null,
    updated_at: '2026-05-01T00:00:00Z',
    ...overrides,
  };
}

Deno.test('returns empty string when there are no state rows', () => {
  const out = formatCodexStateForPrompt([], [{ id: 'e1', title: 'Aria' }]);
  assertEquals(out, '');
});

Deno.test('returns empty string when codex entry set is empty', () => {
  const rows = [makeRow({ entry_id: 'e1', state: 'wounded' })];
  const out = formatCodexStateForPrompt(rows, []);
  assertEquals(out, '');
});

Deno.test('filters out state rows whose entry_id is not in codex set', () => {
  const rows = [
    makeRow({ entry_id: 'e1', state: 'present' }),
    makeRow({ entry_id: 'e_unknown', state: 'offstage' }),
  ];
  const entries: TestEntry[] = [{ id: 'e1', title: 'Aria' }];
  const out = formatCodexStateForPrompt(rows, entries);
  assertStringIncludes(out, '[Aria]');
  assertStringIncludes(out, 'present');
  // 'offstage' belongs to e_unknown which is not in the entry set
  if (out.includes('offstage')) {
    throw new Error('expected unknown entry to be filtered out');
  }
});

Deno.test('drops rows whose last_scene_id matches excludeSceneId', () => {
  const rows = [
    makeRow({ entry_id: 'e1', state: 'kept', last_scene_id: 'scene-other' }),
    makeRow({ entry_id: 'e2', state: 'dropped', last_scene_id: 'scene-current' }),
  ];
  const entries: TestEntry[] = [
    { id: 'e1', title: 'Aria' },
    { id: 'e2', title: 'Bren' },
  ];
  const out = formatCodexStateForPrompt(rows, entries, { excludeSceneId: 'scene-current' });
  assertStringIncludes(out, 'Aria');
  assertStringIncludes(out, 'kept');
  if (out.includes('Bren') || out.includes('dropped')) {
    throw new Error('expected row with matching last_scene_id to be dropped');
  }
});

Deno.test('caps output to 30 entries when given 35 rows + 35 entries', () => {
  const rows: CodexCurrentStateRow[] = [];
  const entries: TestEntry[] = [];
  for (let i = 0; i < 35; i++) {
    rows.push(makeRow({ entry_id: `e${i}`, state: `state-${i}` }));
    entries.push({ id: `e${i}`, title: `Entry ${i}` });
  }
  const out = formatCodexStateForPrompt(rows, entries);
  // Each entry produces a `[Entry N]` header — count those.
  const headerCount = (out.match(/^\[Entry \d+\]$/gm) || []).length;
  assertEquals(headerCount, 30);
});

Deno.test('truncates the formatted block at 12_000 chars when state is oversized', () => {
  const giantState = 'x'.repeat(20_000);
  const rows = [makeRow({ entry_id: 'e1', state: giantState })];
  const entries: TestEntry[] = [{ id: 'e1', title: 'Aria' }];
  const out = formatCodexStateForPrompt(rows, entries);
  // 12_000 chars + the appended `\n...[truncated]` marker
  assertStringIncludes(out, '...[truncated]');
  // Check the truncation hard-cap: body up to 12_000 + marker length
  if (out.length > 12_000 + 32) {
    throw new Error(`expected truncation at ~12_000 chars, got ${out.length}`);
  }
});

Deno.test('does not exclude any row when excludeSceneId is undefined', () => {
  const rows = [
    makeRow({ entry_id: 'e1', state: 's1', last_scene_id: 'sceneA' }),
    makeRow({ entry_id: 'e2', state: 's2', last_scene_id: 'sceneB' }),
  ];
  const entries: TestEntry[] = [
    { id: 'e1', title: 'Aria' },
    { id: 'e2', title: 'Bren' },
  ];
  const out = formatCodexStateForPrompt(rows, entries);
  assertStringIncludes(out, 'Aria');
  assertStringIncludes(out, 'Bren');
});

Deno.test('emits hooks line only when hooks is non-empty', () => {
  const rows = [
    makeRow({ entry_id: 'e1', state: 'wounded', hooks: 'searching for the antidote' }),
    makeRow({ entry_id: 'e2', state: 'calm', hooks: '   ' }),
    makeRow({ entry_id: 'e3', state: 'tense', hooks: null }),
  ];
  const entries: TestEntry[] = [
    { id: 'e1', title: 'Aria' },
    { id: 'e2', title: 'Bren' },
    { id: 'e3', title: 'Cal' },
  ];
  const out = formatCodexStateForPrompt(rows, entries);
  assertStringIncludes(out, 'Open tensions: searching for the antidote');
  // Bren and Cal have no actionable hooks → no `Open tensions:` for them
  const hookLines = (out.match(/^Open tensions:/gm) || []).length;
  assertEquals(hookLines, 1);
});
