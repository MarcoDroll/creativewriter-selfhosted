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
import { consolidateResearchBriefs, runResearchAgents } from '../research-agent.ts';
import { UpstreamError } from '../../_shared/api-errors.ts';
import type { ResearchTask } from '../planner.ts';

const SLOT = 'openrouter:test/model';

const TASKS: ResearchTask[] = [
  { focus: 'alpha', entities: [], scenes: [] },
  { focus: 'beta', entities: [], scenes: [] },
];

/** A 200 whose completion is a one-line brief. */
function briefResponse(text: string, finishReason: string | null = 'stop'): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: text }, finish_reason: finishReason }],
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
    { codexEntries: [], scenes: [], loadSceneText: () => Promise.resolve(null) },
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

Deno.test('a Venice research agent sends the effort the browser resolved (#107)', async () => {
  // Research builds its own request body rather than going through `callModel`, so it has to
  // pass the level to `resolveUpstream` itself — and it runs up to five rounds at the research cap.
  const sent: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (_input: string | URL | Request, init?: RequestInit) => {
    sent.push((JSON.parse(String(init?.body ?? '{}')) as { reasoning_effort?: unknown }).reasoning_effort);
    return Promise.resolve(briefResponse('a brief'));
  };
  try {
    await runResearchAgents(
      'venice:deepseek-v4-flash-0731', [TASKS[0]], new Map(), '', { codexEntries: [], scenes: [], loadSceneText: () => Promise.resolve(null) },
      'vk', undefined, undefined, { reasoningEffort: 'low' },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(sent, ['low']);
});

Deno.test('a NanoGPT research agent sends the resolved effort and stays under the model ceiling', async () => {
  const sent: { reasoning_effort?: unknown; max_tokens?: number }[] = [];
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input));
    sent.push(JSON.parse(String(init?.body ?? '{}')));
    return Promise.resolve(briefResponse('a brief'));
  };
  try {
    await runResearchAgents(
      'nanogpt:qwen/q3:thinking', [TASKS[0]], new Map(), '', { codexEntries: [], scenes: [], loadSceneText: () => Promise.resolve(null) },
      'nk', undefined, undefined, { reasoningEffort: 'low', maxOutput: 2000 },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(urls, ['https://nano-gpt.com/api/v1/chat/completions']);
  assertEquals(sent[0].reasoning_effort, 'low');
  assertEquals(sent[0].max_tokens, 2000);
});

Deno.test('a brief cut off at max_tokens is flagged, and only that brief (#413)', async () => {
  await withRoutedFetch(
    focus => focus === 'beta' ? briefResponse('beta brief, cut mid-sen', 'length') : briefResponse('alpha brief'),
    async () => {
      const briefs = await run();
      const alpha = briefs.find(b => b.focus === 'alpha')!;
      const beta = briefs.find(b => b.focus === 'beta')!;
      assertEquals([alpha.truncated, alpha.finishReason], [false, 'stop']);
      assertEquals([beta.truncated, beta.finishReason], [true, 'length']);
      assertEquals(beta.brief, 'beta brief, cut mid-sen');
    },
  );
});

Deno.test('a null finish_reason is not a truncation (#413)', async () => {
  await withRoutedFetch(() => briefResponse('a brief', null), async () => {
    const briefs = await run();
    assertEquals(briefs.map(b => [b.truncated, b.finishReason]), [[false, null], [false, null]]);
  });
});

Deno.test('a brief that is empty because the budget went to thinking is still flagged (#413)', async () => {
  await withRoutedFetch(() => briefResponse('', 'length'), async () => {
    const briefs = await run();
    assertEquals(briefs.map(b => [b.brief, b.truncated]), [['', true], ['', true]]);
  });
});

Deno.test('only the round that produced the brief counts, not an earlier cut tool round (#413)', async () => {
  // Round 0 asks for a tool and is cut (`length`); round 1 answers cleanly. The returned brief
  // is round 1's, and it is complete — flagging it would warn about a brief that is fine.
  let calls = 0;
  const realFetch = globalThis.fetch;
  const savedSelfHosted = Deno.env.get('SELF_HOSTED');
  globalThis.fetch = () => {
    calls++;
    if (calls === 1) {
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{
          message: {
            content: '',
            tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_codex_entry', arguments: '{"name":"Ada"}' } }],
          },
          finish_reason: 'length',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return Promise.resolve(briefResponse('complete brief'));
  };
  try {
    const briefs = await runResearchAgents(
      SLOT, [TASKS[0]], new Map(), '', { codexEntries: [], scenes: [], loadSceneText: () => Promise.resolve(null) }, 'sk-x',
    );
    assertEquals(calls, 2);
    assertEquals([briefs[0].brief, briefs[0].truncated, briefs[0].finishReason], ['complete brief', false, 'stop']);
  } finally {
    globalThis.fetch = realFetch;
    if (savedSelfHosted === undefined) Deno.env.delete('SELF_HOSTED');
    else Deno.env.set('SELF_HOSTED', savedSelfHosted);
  }
});

const toolCallResponse = (content: string, finishReason: string): Response =>
  new Response(JSON.stringify({
    choices: [{
      message: {
        content,
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_codex_entry', arguments: '{"name":"Ada"}' } }],
      },
      finish_reason: finishReason,
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

const runSingleTask = (): Promise<Awaited<ReturnType<typeof runResearchAgents>>> =>
  runResearchAgents(
    SLOT, [TASKS[0]], new Map(), '', { codexEntries: [], scenes: [], loadSceneText: () => Promise.resolve(null) }, 'sk-x',
  );

type RequestBody = { messages: Array<{ role: string; content?: string }>; tools?: unknown[] };

async function withScriptedFetch(
  script: (call: number, request: RequestBody) => Response,
  body: (calls: () => number) => Promise<void>,
): Promise<void> {
  let calls = 0;
  const realFetch = globalThis.fetch;
  const savedSelfHosted = Deno.env.get('SELF_HOSTED');
  globalThis.fetch = (_url, init) => Promise.resolve(script(++calls, JSON.parse(String((init as RequestInit).body))));
  try {
    await body(() => calls);
  } finally {
    globalThis.fetch = realFetch;
    if (savedSelfHosted === undefined) Deno.env.delete('SELF_HOSTED');
    else Deno.env.set('SELF_HOSTED', savedSelfHosted);
  }
}

Deno.test('a model that asks for a tool on every round ends flagged as exhausted, not as a quiet empty brief (#415)', async () => {
  // MAX_TOOL_ROUNDS + 1 = 5 calls, the last of which still carries tool_calls and cannot be honoured.
  await withScriptedFetch(() => toolCallResponse('', 'tool_calls'), async calls => {
    const briefs = await runSingleTask();
    assertEquals(calls(), 5);
    assertEquals([briefs[0].brief, briefs[0].toolLoopExhausted, briefs[0].truncated], ['', true, false]);
  });
});

Deno.test('a pending tool call on the last round is exhausted even when the model wrote preamble beside it (#415)', async () => {
  await withScriptedFetch(() => toolCallResponse('Let me look that up.', 'stop'), async () => {
    const briefs = await runSingleTask();
    assertEquals([briefs[0].brief, briefs[0].toolLoopExhausted], ['Let me look that up.', true]);
  });
});

Deno.test('a brief answered after some tool rounds is not exhausted (#415)', async () => {
  await withScriptedFetch(
    call => call <= 2 ? toolCallResponse('', 'tool_calls') : briefResponse('complete brief'),
    async calls => {
      const briefs = await runSingleTask();
      assertEquals(calls(), 3);
      assertEquals([briefs[0].brief, briefs[0].toolLoopExhausted], ['complete brief', false]);
    },
  );
});

Deno.test('only the last round is told to stop calling tools (#417)', async () => {
  const bodies: RequestBody[] = [];
  await withScriptedFetch(
    (call, request) => {
      bodies.push(request);
      return call <= 4 ? toolCallResponse('', 'tool_calls') : briefResponse('answer');
    },
    async () => {
      const briefs = await runSingleTask();
      assertEquals(briefs[0].toolLoopExhausted, false);
      assertEquals(bodies.length, 5);
      const told = bodies.map(b => b.messages.filter(m => m.role === 'user' && /Do not call any more tools/.test(m.content ?? '')).length);
      assertEquals(told, [0, 0, 0, 0, 1]);
      assertEquals(bodies[4].messages.at(-1)?.role, 'user');
      // The instruction is a plain message; dropping `tools` instead would leave tool-shaped turns without them.
      assertEquals(bodies.map(b => Array.isArray(b.tools) && b.tools.length > 0), [true, true, true, true, true]);
    },
  );
});

Deno.test('a last round rejected with the instruction is retried once without it, keeping the work so far (#417)', async () => {
  const bodies: RequestBody[] = [];
  const hasInstruction = (b: RequestBody) => b.messages.some(m => /Do not call any more tools/.test(m.content ?? ''));
  await withScriptedFetch(
    (call, request) => {
      bodies.push(request);
      if (call <= 4) return toolCallResponse('', 'tool_calls');
      if (hasInstruction(request)) return new Response('Unexpected role user after role tool', { status: 400 });
      return toolCallResponse('Let me look that up.', 'stop');
    },
    async calls => {
      const briefs = await runSingleTask();
      assertEquals(calls(), 6);
      assertEquals(bodies.map(hasInstruction), [false, false, false, false, true, false]);
      assertEquals([briefs[0].brief, briefs[0].toolLoopExhausted], ['Let me look that up.', true]);
    },
  );
});

Deno.test('a last round that fails for another reason is not retried (#417)', async () => {
  await withScriptedFetch(
    call => call <= 4 ? toolCallResponse('', 'tool_calls') : new Response('upstream broke', { status: 500 }),
    async calls => {
      const briefs = await runSingleTask();
      assertEquals(calls(), 5);
      assertEquals(briefs.length, 0);
    },
  );
});

Deno.test('consolidation leaves out an exhausted brief but keeps the answered ones (#417)', () => {
  const brief = (focus: string, text: string, toolLoopExhausted: boolean) => ({
    focus, brief: text, inputTokens: 0, outputTokens: 0, truncated: false, finishReason: 'stop', toolLoopExhausted,
  });
  const xml = consolidateResearchBriefs([
    brief('the protagonist', 'Let me look that up.', true),
    brief('the setting', 'A harbour town.', false),
  ]);
  assertEquals(xml.includes('Let me look that up.'), false);
  assertEquals(xml.includes('A harbour town.'), true);
  assertEquals(consolidateResearchBriefs([brief('x', 'Let me look that up.', true)]), '');
});

Deno.test('an empty brief that is not a pending tool call is not exhausted (#415)', async () => {
  await withRoutedFetch(() => briefResponse('', 'stop'), async () => {
    const briefs = await run();
    assertEquals(briefs.map(b => [b.brief, b.toolLoopExhausted]), [['', false], ['', false]]);
  });
});

Deno.test('no tasks is not a failure', async () => {
  await withRoutedFetch(() => briefResponse('unused'), async () => {
    const briefs = await runResearchAgents(
      SLOT, [], new Map(), '', { codexEntries: [], scenes: [], loadSceneText: () => Promise.resolve(null) }, 'sk-x',
    );
    assertEquals(briefs.length, 0);
  });
});
