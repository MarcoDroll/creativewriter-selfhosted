/**
 * Deno tests for how the research phase reads scene prose (research.ts / agent-tools.ts).
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/agentic-writer/_tests_/research-scene-loading.test.ts
 *
 * Every research run used to `select('id, title, content')` for EVERY scene of the story —
 * the whole manuscript, per run, as Supabase egress. The contract pinned here is that
 * prose is read only for scenes a task names (one query) or a tool call asks for (once,
 * then remembered), and never in the index read.
 *
 * The fake client records each query's table, column list and filters; the assertions are
 * on those, because a passing prompt would not show an over-wide select.
 */

import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { fetchResearchData } from '../research.ts';
import { executeAgentToolCall } from '../agent-tools.ts';
import type { ResearchPlan } from '../planner.ts';

interface Query {
  table: string;
  columns: string;
  filters: Array<[string, unknown]>;
}

interface Row { id: string; title: string; content: string }

const SCENES: Row[] = [
  { id: 's1', title: 'The Harbour', content: '<p>Rain on the <b>quay</b>.</p>' },
  { id: 's2', title: 'The Duel', content: '<p>Steel rang.</p>' },
  { id: 's3', title: 'Aftermath', content: '<p>Silence.</p>' },
];

interface FakeOpts {
  scenes?: Row[];
  failSingleFor?: Set<string>;
  /** Throw (rather than return an error) on the next single read of these ids. */
  throwSingleFor?: Set<string>;
  failIn?: boolean;
}

function fakeClient(opts: FakeOpts = {}): { client: SupabaseClient; queries: Query[] } {
  const queries: Query[] = [];

  const run = (q: Query, terminal: 'many' | 'maybeSingle') => {
    queries.push(q);
    if (q.table === 'stories') return { data: { codex_id: null }, error: null };
    if (q.table !== 'scenes') return { data: [], error: null };

    const idEq = q.filters.find(([k]) => k === 'id');
    const idIn = q.filters.find(([k]) => k === 'id in');
    let rows = opts.scenes ?? SCENES;
    if (idEq) rows = rows.filter(r => r.id === idEq[1]);
    if (idIn) {
      if (opts.failIn) return { data: null, error: { message: 'uri too long' } };
      rows = rows.filter(r => (idIn[1] as string[]).includes(r.id));
    }
    if (idEq && opts.throwSingleFor?.has(idEq[1] as string)) {
      opts.throwSingleFor.delete(idEq[1] as string);
      throw new Error('socket hang up');
    }

    const project = (r: Row) => Object.fromEntries(
      q.columns.split(',').map(c => c.trim()).map(c => [c, r[c as keyof Row]]),
    );
    if (terminal === 'maybeSingle') {
      if (idEq && opts.failSingleFor?.has(idEq[1] as string)) {
        opts.failSingleFor.delete(idEq[1] as string);
        return { data: null, error: { message: 'boom' } };
      }
      return { data: rows[0] ? project(rows[0]) : null, error: null };
    }
    return { data: rows.map(project), error: null };
  };

  const builder = (table: string) => {
    const q: Query = { table, columns: '', filters: [] };
    const chain = {
      select(columns: string) { q.columns = columns; return chain; },
      eq(col: string, val: unknown) { q.filters.push([col, val]); return chain; },
      in(col: string, vals: unknown[]) { q.filters.push([`${col} in`, vals]); return chain; },
      single() { return Promise.resolve(run(q, 'maybeSingle')); },
      maybeSingle() { return Promise.resolve(run(q, 'maybeSingle')); },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(run(q, 'many')).then(resolve, reject);
      },
    };
    return chain;
  };

  return { client: { from: builder } as unknown as SupabaseClient, queries };
}

const sceneQueries = (queries: Query[]) => queries.filter(q => q.table === 'scenes');

function plan(scenes: string[]): ResearchPlan {
  return { tasks: [{ focus: 'f', entities: [], scenes }] } as unknown as ResearchPlan;
}

Deno.test('a plan that names no scene never reads any prose', async () => {
  const { client, queries } = fakeClient();
  const result = await fetchResearchData(plan([]), 'story', client);

  const reads = sceneQueries(queries);
  assertEquals(reads.length, 1);
  assertEquals(reads[0].columns, 'id, title');
  assertEquals(result.fullCache.scenes.map(s => s.id), ['s1', 's2', 's3']);
  assertEquals(result.taskDataMap.get('0')?.scenes, []);
});

Deno.test('scenes a task names arrive in ONE query, cleaned, and nothing else is read', async () => {
  const { client, queries } = fakeClient();
  const result = await fetchResearchData(plan(['duel', 'harbour']), 'story', client);

  const reads = sceneQueries(queries);
  assertEquals(reads.map(q => q.columns), ['id, title', 'id, content']);
  assertEquals(reads[1].filters.find(([k]) => k === 'id in')?.[1], ['s1', 's2']);

  const scenes = result.taskDataMap.get('0')!.scenes;
  assertEquals(scenes.map(s => s.title), ['The Harbour', 'The Duel']);
  assertEquals(scenes[0].content, 'Rain on the quay .');
});

Deno.test('the scene being written is left out of the index', async () => {
  const { client } = fakeClient();
  const result = await fetchResearchData(plan([]), 'story', client, 's2');
  assertEquals(result.fullCache.scenes.map(s => s.id), ['s1', 's3']);
});

Deno.test('get_scene_text reads a scene once, then serves it from memory', async () => {
  const { client, queries } = fakeClient();
  const { fullCache } = await fetchResearchData(plan([]), 'story', client);

  const first = await executeAgentToolCall('get_scene_text', { title: 'Aftermath' }, fullCache);
  const second = await executeAgentToolCall('get_scene_text', { title: 'aftermath' }, fullCache);

  assertEquals(first, '[Scene: Aftermath]\nSilence.');
  assertEquals(second, first);
  assertEquals(sceneQueries(queries).filter(q => q.columns === 'content').length, 1);
});

Deno.test('a scene already loaded for a task is not read again by a tool call', async () => {
  const { client, queries } = fakeClient();
  const { fullCache } = await fetchResearchData(plan(['duel']), 'story', client);
  const before = sceneQueries(queries).length;

  await executeAgentToolCall('get_scene_text', { title: 'The Duel' }, fullCache);

  assertEquals(sceneQueries(queries).length, before);
});

Deno.test('a failed scene read says so and is retried on the next ask', async () => {
  const { client } = fakeClient({ failSingleFor: new Set(['s3']) });
  const { fullCache } = await fetchResearchData(plan([]), 'story', client);

  const failed = await executeAgentToolCall('get_scene_text', { title: 'Aftermath' }, fullCache);
  assertStringIncludes(failed, 'Could not read the scene "Aftermath"');

  const retried = await executeAgentToolCall('get_scene_text', { title: 'Aftermath' }, fullCache);
  assertEquals(retried, '[Scene: Aftermath]\nSilence.');
});

Deno.test('an unknown title is reported without a query', async () => {
  const { client, queries } = fakeClient();
  const { fullCache } = await fetchResearchData(plan([]), 'story', client);
  const before = queries.length;

  const out = await executeAgentToolCall('get_scene_text', { title: 'Nowhere' }, fullCache);

  assertEquals(out, 'No scene found matching "Nowhere"');
  assertEquals(queries.length, before);
});

Deno.test('a blank planned title names no scene and reads no prose', async () => {
  const { client, queries } = fakeClient();
  const result = await fetchResearchData(plan(['', '   ']), 'story', client);

  assertEquals(sceneQueries(queries).map(q => q.columns), ['id, title']);
  assertEquals(result.taskDataMap.get('0')?.scenes, []);
});

Deno.test('a generic title preloads a bounded number of scenes; the rest stay reachable by tool', async () => {
  // Zero-padded so no title contains another: the tool's substring match takes the first hit.
  const pad = (n: number) => String(n).padStart(2, '0');
  const many: Row[] = Array.from({ length: 40 }, (_, n) => ({
    id: `m${n}`, title: `Scene ${pad(n)}`, content: `<p>Body ${pad(n)}.</p>`,
  }));
  const { client, queries } = fakeClient({ scenes: many });
  const { fullCache, taskDataMap } = await fetchResearchData(plan(['Scene']), 'story', client);

  const preload = sceneQueries(queries).find(q => q.columns === 'id, content')!;
  assertEquals((preload.filters.find(([k]) => k === 'id in')![1] as string[]).length, 12);
  assertEquals(taskDataMap.get('0')!.scenes.length, 12);

  const late = await executeAgentToolCall('get_scene_text', { title: 'Scene 39' }, fullCache);
  assertEquals(late, '[Scene: Scene 39]\nBody 39.');
  assertEquals(sceneQueries(queries).filter(q => q.columns === 'content').length, 1);
});

Deno.test('every scene read is scoped to the story', async () => {
  const { client, queries } = fakeClient();
  const { fullCache } = await fetchResearchData(plan(['harbour']), 'story-42', client);
  await executeAgentToolCall('get_scene_text', { title: 'Aftermath' }, fullCache);

  for (const q of sceneQueries(queries)) {
    assertEquals(q.filters.find(([k]) => k === 'story_id')?.[1], 'story-42');
  }
});

Deno.test('a failed batched preload falls back to reading each named scene', async () => {
  const { client } = fakeClient({ failIn: true });
  const result = await fetchResearchData(plan(['duel', 'harbour']), 'story', client);

  assertEquals(result.taskDataMap.get('0')!.scenes.map(s => s.title), ['The Harbour', 'The Duel']);
});

Deno.test('a read that throws is reported and retried, not remembered as a rejection', async () => {
  const { client } = fakeClient({ throwSingleFor: new Set(['s3']) });
  const { fullCache } = await fetchResearchData(plan([]), 'story', client);

  const failed = await executeAgentToolCall('get_scene_text', { title: 'Aftermath' }, fullCache);
  assertStringIncludes(failed, 'Could not read the scene "Aftermath"');

  const retried = await executeAgentToolCall('get_scene_text', { title: 'Aftermath' }, fullCache);
  assertEquals(retried, '[Scene: Aftermath]\nSilence.');
});
