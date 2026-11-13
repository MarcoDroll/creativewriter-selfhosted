/**
 * Deno tests for how one research round runs the tool calls the model asked for
 * (`runResearchAgent`, research-agent.ts).
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/agentic-writer/_tests_/research-tool-round.test.ts
 *
 * A round's calls used to run one after another, so a round asking for three unread
 * scenes paid for three reads back to back (#405). They now run together, a few at a
 * time, and the contract pinned here has three parts:
 *
 *   - the calls overlap (peak concurrency above one), bounded per agent;
 *   - the tool messages sent back keep the `tool_calls` order and ids, however the reads
 *     finish — a provider pairs a reply with its call by position as well as by id;
 *   - a call with unparseable arguments still gets its reply, beside its siblings'.
 *
 * `globalThis.fetch` is ASSIGNED and restored in a `finally`, like its neighbours, with
 * `SELF_HOSTED` saved alongside (see research-agents-fanout.test.ts for why).
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { runResearchAgent } from '../research-agent.ts';
import type { StoryDataCache } from '../research.ts';

const SLOT = 'openrouter:test/model';

interface ToolCall { id: string; title?: string; rawArguments?: string }
interface SentMessage { role: string; content?: string; tool_call_id?: string }

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Round 0 answers with `calls`, every later round with a brief. Returns the messages the
 * round after the tool calls was sent.
 */
async function runOneToolRound(calls: ToolCall[], cache: StoryDataCache): Promise<SentMessage[]> {
  const realFetch = globalThis.fetch;
  const savedSelfHosted = Deno.env.get('SELF_HOSTED');
  let round = 0;
  let followUp: SentMessage[] = [];
  globalThis.fetch = (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages: SentMessage[] };
    if (round++ === 0) {
      return Promise.resolve(json({
        choices: [{
          message: {
            content: '',
            tool_calls: calls.map(c => ({
              id: c.id,
              type: 'function',
              function: { name: 'get_scene_text', arguments: c.rawArguments ?? JSON.stringify({ title: c.title }) },
            })),
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
    }
    followUp = body.messages;
    return Promise.resolve(json({
      choices: [{ message: { content: 'the brief' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
  };
  try {
    const brief = await runResearchAgent(
      SLOT,
      { focus: 'f', entities: [], scenes: [] },
      { codexEntries: [], scenes: [] },
      '',
      cache,
      'sk-x',
    );
    assertEquals(brief.brief, 'the brief');
    return followUp;
  } finally {
    globalThis.fetch = realFetch;
    if (savedSelfHosted === undefined) Deno.env.delete('SELF_HOSTED');
    else Deno.env.set('SELF_HOSTED', savedSelfHosted);
  }
}

const tick = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Counts how many loads are in flight at once. */
function concurrencyProbe() {
  let active = 0;
  let peak = 0;
  return {
    get peak() { return peak; },
    async around<T>(work: () => Promise<T>): Promise<T> {
      active++;
      peak = Math.max(peak, active);
      try {
        return await work();
      } finally {
        active--;
      }
    },
  };
}

Deno.test('a round runs its tool calls together and answers them in the order asked', async () => {
  const probe = concurrencyProbe();
  // A is the slow read: it waits until B has started (or 50 ms, so a sequential loop fails
  // the peak assertion instead of hanging), then a beat longer, so B finishes first.
  let markBStarted!: () => void;
  const bStarted = new Promise<void>(resolve => { markBStarted = resolve; });
  const cache: StoryDataCache = {
    codexEntries: [],
    scenes: [{ id: 'a', title: 'Alpha' }, { id: 'b', title: 'Beta' }],
    loadSceneText: (id) => probe.around(async () => {
      if (id === 'b') {
        markBStarted();
        return 'beta text';
      }
      let fallback: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([bStarted, new Promise<void>(r => { fallback = setTimeout(r, 50); })]);
      clearTimeout(fallback);
      await tick(5);
      return 'alpha text';
    }),
  };

  const sent = await runOneToolRound(
    [{ id: 'A', title: 'Alpha' }, { id: 'B', title: 'Beta' }, { id: 'C', rawArguments: '{not json' }],
    cache,
  );

  assertEquals(probe.peak, 2);
  assertEquals(
    sent.filter(m => m.role === 'tool').map(m => [m.tool_call_id, m.content]),
    [
      ['A', '[Scene: Alpha]\nalpha text'],
      ['B', '[Scene: Beta]\nbeta text'],
      ['C', 'No title provided'],
    ],
  );
});

Deno.test('a round with many tool calls runs at most four at once, and answers every one', async () => {
  const probe = concurrencyProbe();
  const scenes = Array.from({ length: 6 }, (_, n) => ({ id: `s${n}`, title: `Chapter ${'IVX'[n % 3]}-${n}` }));
  const cache: StoryDataCache = {
    codexEntries: [],
    scenes,
    loadSceneText: (id) => probe.around(async () => {
      await tick(5);
      return `text of ${id}`;
    }),
  };

  const sent = await runOneToolRound(scenes.map(s => ({ id: `call-${s.id}`, title: s.title })), cache);

  assertEquals(probe.peak, 4);
  assertEquals(
    sent.filter(m => m.role === 'tool').map(m => m.tool_call_id),
    scenes.map(s => `call-${s.id}`),
  );
});
