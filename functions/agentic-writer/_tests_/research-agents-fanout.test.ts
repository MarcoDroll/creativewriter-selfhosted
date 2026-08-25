/**
 * Deno tests for `runResearchAgents`' fan-out policy (research-agent.ts).
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/agentic-writer/_tests_/research-agents-fanout.test.ts
 *
 * This is the behaviourally significant half of the coded-error change and the easiest
 * thing in it to get wrong. The rule has two sides and both are load-bearing:
 *
 *   - **Partial failure must still return the survivors.** These tasks fan out with a
 *     plain `.map()`, so `Promise.all` rejects on the first failure and DISCARDS every
 *     sibling's already-resolved brief — turning "one fewer brief" into "the research
 *     phase kills the run". That is why `Promise.allSettled` is not a stylistic choice.
 *   - **Total failure must stop pretending.** The per-agent swallow this replaced
 *     answered HTTP 200 with `briefCount: 0` for a rejected API key.
 *
 * Tasks run concurrently, so `fetch` is routed by the task focus carried in the request
 * body rather than by call order. `globalThis.fetch` is ASSIGNED and restored in a
 * `finally`, like its neighbours — and `SELF_HOSTED` with it, because
 * `stripe/_tests_/self-hosted-lockdown.test.ts` sets it at module scope and the whole
 * suite shares one process.
 */

import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { runResearchAgents } from '../research-agent.ts';
import { UpstreamError } from '../../_shared/api-errors.ts';
import type { ResearchTask } from '../planner.ts';

const SLOT = 'openrouter:test/model';

const TASKS: ResearchTask[] = [
  { focus: 'alpha', entities: [], scenes: [] },
  { focus: 'beta', entities: [], scenes: [] },
];

/** A 200 whose completion is a one-line brief. */
function briefResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/**
 * Answer each task by its focus. The focus is in the user message
 * (`Research task: <focus>`), which is the only way to tell concurrent tasks apart.
 */
async function withRoutedFetch(
  answer: (focus: string) => Response,
  fn: () => Promise<void>,
): Promise<void> {
  const realFetch = globalThis.fetch;
  const savedSelfHosted = Deno.env.get('SELF_HOSTED');
  globalThis.fetch = (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: Array<{ content?: string }>;
    };
    const content = body.messages?.map(m => m.content ?? '').join('\n') ?? '';
    const focus = /Research task: (\S+)/.exec(content)?.[1] ?? '';
    return Promise.resolve(answer(focus));
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    if (savedSelfHosted === undefined) Deno.env.delete('SELF_HOSTED');
    else Deno.env.set('SELF_HOSTED', savedSelfHosted);
  }
}

function run() {
  return runResearchAgents(
    SLOT,
    TASKS,
    new Map(),
    '',
    { codexEntries: [], scenes: [] },
    'sk-x',
  );
}

Deno.test('one agent failing costs exactly one brief — the survivors still arrive', async () => {
  await withRoutedFetch(
    focus => focus === 'beta'
      ? new Response('{"error":"too many"}', { status: 429 })
      : briefResponse('alpha brief'),
    async () => {
      const briefs = await run();
      assertEquals(briefs.length, 1);
      assertEquals(briefs[0].focus, 'alpha');
      assertEquals(briefs[0].brief, 'alpha brief');
    },
  );
});

Deno.test('every agent failing on a throttle rethrows rather than answering 0 briefs', async () => {
  await withRoutedFetch(() => new Response('{"error":"too many"}', { status: 429 }), async () => {
    const err = await assertRejects(() => run(), UpstreamError);
    assertEquals(err.code, 'rate-limited');
  });
});

Deno.test('every agent failing on a rejected key rethrows', async () => {
  await withRoutedFetch(() => new Response('invalid api key', { status: 401 }), async () => {
    const err = await assertRejects(() => run(), UpstreamError);
    assertEquals(err.code, 'api-key-invalid');
  });
});

Deno.test('a hard failure is found wherever it sits, not only at index 0', async () => {
  // Total failure is NOT homogeneous: the tasks share one rate-limit budget, so one
  // hitting 429 while a sibling's content trips a 400 is ordinary. An earlier version
  // inspected `failures[0]` alone, so whether the rejected key happened to be the first
  // task decided between reporting it and answering 200 with `briefCount: 0`.
  await withRoutedFetch(
    focus => focus === 'alpha'
      ? new Response('model exploded', { status: 500 })   // soft, and first in task order
      : new Response('invalid api key', { status: 401 }), // hard, and second
    async () => {
      const err = await assertRejects(() => run(), UpstreamError);
      assertEquals(err.code, 'api-key-invalid');
    },
  );
});

Deno.test('a total failure the author cannot act on still degrades quietly', async () => {
  // A 500 from a flaky model is `provider-message`, which is NOT in the hard set: the
  // draft is still worth running without research. Only the two remedy-carrying codes
  // and a timeout escalate.
  await withRoutedFetch(() => new Response('model exploded', { status: 500 }), async () => {
    assertEquals((await run()).length, 0);
  });
});

Deno.test('an empty-but-successful brief counts as a success, not a total failure', async () => {
  // `runResearchAgent` RESOLVES with an empty brief when a model answers with nothing.
  // That must not be mistaken for "every agent failed" and turned into a rethrow.
  await withRoutedFetch(
    focus => focus === 'beta'
      ? briefResponse('')
      : new Response('{"error":"too many"}', { status: 429 }),
    async () => {
      const briefs = await run();
      assertEquals(briefs.length, 1);
      assertEquals(briefs[0].brief, '');
    },
  );
});

Deno.test('no tasks is not a failure', async () => {
  await withRoutedFetch(() => briefResponse('unused'), async () => {
    const briefs = await runResearchAgents(
      SLOT, [], new Map(), '', { codexEntries: [], scenes: [] }, 'sk-x',
    );
    assertEquals(briefs.length, 0);
  });
});
