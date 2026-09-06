/**
 * Deno tests for the phase handlers' ERROR LADDERS (`agentic-writer/router.ts`).
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/agentic-writer/_tests_/phase-handlers.test.ts
 *
 * These exist because the catch blocks in those handlers were rewritten four times in
 * two days — coded errors, then the 504 fix, then the watchdog's own code, then the split
 * into two budget codes — with nothing exercising them. Every claim about "which arm
 * answers what" was a claim about code nobody had run. The classifier had unit tests; the
 * ladder that consumes it had none.
 *
 * **What makes this possible without a server, a DB or Stripe:**
 *   - `router.ts` exports the handlers, and `index.ts` is now a shim that does nothing but
 *     `Deno.serve(handleRequest)`. Importing a module that calls `Deno.serve` at top level
 *     binds a port as an import side effect, which is why the split had to come first.
 *   - Every model slot here is `openrouter:`, so `setupBudgetContext` short-circuits before
 *     it can reach Stripe or a JWT (`usesIncluded` is false), and `checkBudgetBetweenSteps`
 *     answers true without a query.
 *   - `globalThis.fetch` is ASSIGNED and restored in a `finally`, never spied.
 *
 * Two gaps this file claimed on its first pass turned out to be cheaper to close than
 * stated, and review said so; both are now covered, by the same one tool:
 *   - **`/research` does reach Supabase first, but that is not an obstacle.** `supabase-js`
 *     reads `fetch` off `globalThis` per call rather than capturing it at import, so the
 *     stub already here intercepts PostgREST too — routing by URL is the whole trick.
 *   - **The `wd.fired` arms** need no 145-second wait. Each handler does
 *     `const phaseStart = Date.now()` immediately before `setupPhaseWatchdog(…, phaseStart)`,
 *     so a one-shot `Date.now` that answers "146 seconds ago" once leaves the watchdog with
 *     no budget at all. Same assign-and-restore shape as the `fetch` stub.
 *
 * **These tests enter below the auth gate**, and that is a property of the tests, not of
 * the endpoints: `handleRequest` runs `extractAuthFromRequest` for every phase endpoint
 * before dispatching, and calling an exported handler directly skips it.
 * `checkApiKeyForOpenRouter`'s `request.headers.get('Authorization')!` is safe in
 * production only because of that gate — which is why these requests still carry a header,
 * even though nothing here verifies it.
 *
 * **The config-error test below is the HOSTED branch**, and the two are easy to confuse:
 * `withFetch` deletes `SELF_HOSTED`, so an `ollama:` slot is refused as "only available on
 * self-hosted" — a different throw from the unset-base-URL one an operator meets. The
 * self-hosted half, including the router-level 400 that keeps `/draft` from degrading into
 * an SSE error frame, lives in `local-provider-config.test.ts`, which drives
 * `handleRequest` with a signed token rather than entering below the gate.
 *
 * **Where the auth gate itself is covered:** `request-auth.test.ts`, which drives
 * `handleRequest` with a signed ES256 token and serves the JWKS document off the same kind of
 * stub — a second upstream, not a different tool. It points at `/plan` purely as a vehicle;
 * the gate belongs to `handleRequest`, not to any one route. (It used to point at
 * `/analyze-cliches`, which was handled inline in the router and so had nothing to call below
 * the gate; that route was deleted when the cliché-index build moved into the browser.)
 */

import { assert, assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  handleAnalyze,
  handleDraft,
  handlePlan,
  handleRefine,
  handleResearch,
} from '../router.ts';
import { PHASE_BUDGET_MS, PHASE_SAFETY_MARGIN_MS } from '../../_shared/phase-watchdog.ts';
import type {
  AnalyzeRequestBody,
  DraftRequestBody,
  PlanRequestBody,
  RefineRequestBody,
  ResearchRequestBody,
} from '../../_shared/agentic-writer-types.ts';

const SLOT = 'openrouter:test/model';
const HEADERS = { 'Content-Type': 'application/json' };

const MODELS = { writing: SLOT, research: SLOT, refiner: SLOT, analyzer: SLOT };

/** A request carrying the two headers every handler reads off it. */
function phaseRequest(): Request {
  return new Request('https://example.test/agentic-writer/plan', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer jwt-token', 'X-API-Key': 'sk-or-test' },
  });
}

const COMMON = {
  pipelineRequestId: 'test-pipeline',
  storyId: 'story-1',
  models: MODELS,
  preset: 'balanced' as const,
  wordCount: 400,
};

const MESSAGES = [{ role: 'user', content: 'write something' }];

/**
 * Run `fn` with `fetch` answering with `answer`, restoring the real one afterwards.
 *
 * `answer` is a thunk so a test can *throw* instead of resolving — that is how a timeout
 * (a raw `DOMException`, which no classifier ever wraps) and a transport failure are
 * reached. `SELF_HOSTED` is saved with it because the suite shares one process and
 * `stripe/_tests_/self-hosted-lockdown.test.ts` sets it at module scope.
 */
async function withFetch(answer: () => Response, fn: () => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch;
  const savedSelfHosted = Deno.env.get('SELF_HOSTED');
  Deno.env.delete('SELF_HOSTED');
  globalThis.fetch = () => {
    try {
      return Promise.resolve(answer());
    } catch (err) {
      return Promise.reject(err);
    }
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    if (savedSelfHosted === undefined) Deno.env.delete('SELF_HOSTED');
    else Deno.env.set('SELF_HOSTED', savedSelfHosted);
  }
}

const upstream = (status: number, body: string) => () => new Response(body, { status });

/** URL + Authorization of the last upstream call, for asserting WHICH key went WHERE. */
let lastUpstream: { url: string; auth: string | null } | null = null;

/**
 * As {@link withFetch}, but records the outgoing request instead of ignoring it.
 *
 * Needed because the interesting property of a mixed-provider pipeline is not the response
 * — it is that the Venice call carried the Venice key and never the OpenRouter one.
 */
async function withRecordedFetch(fn: () => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch;
  const savedSelfHosted = Deno.env.get('SELF_HOSTED');
  Deno.env.delete('SELF_HOSTED');
  lastUpstream = null;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    lastUpstream = { url: input.toString(), auth: headers.get('Authorization') };
    return Promise.resolve(new Response(
      JSON.stringify({ choices: [{ message: { content: 'a plan' }, finish_reason: 'stop' }], usage: {} }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    if (savedSelfHosted === undefined) Deno.env.delete('SELF_HOSTED');
    else Deno.env.set('SELF_HOSTED', savedSelfHosted);
  }
}

/** A request carrying whichever provider keys a test wants. */
function keyedRequest(keys: { openRouter?: string; venice?: string }): Request {
  const headers: Record<string, string> = { 'Authorization': 'Bearer jwt-token' };
  if (keys.openRouter) headers['X-API-Key'] = keys.openRouter;
  if (keys.venice) headers['X-Venice-Key'] = keys.venice;
  return new Request('https://example.test/agentic-writer/plan', { method: 'POST', headers });
}
const rejects = (err: unknown) => () => { throw err; };

/** What `fetchWithTimeout` throws when its timer fires — never an UpstreamError. */
const abortError = () => new DOMException('The signal has been aborted', 'AbortError');

interface ErrorBody { error: string; code?: string }

// ---------------------------------------------------------------------------
// JSON phases — the full ladder on /plan, then the shared shape on /analyze
// ---------------------------------------------------------------------------

function planBody(): PlanRequestBody {
  return { ...COMMON, messages: MESSAGES } as unknown as PlanRequestBody;
}

Deno.test('/plan relays a rejected key as 502 + api-key-invalid', async () => {
  // 502, NOT 401: the client reads 401 as this app's session and would say "please
  // sign in" about an OpenRouter key.
  await withFetch(upstream(401, 'invalid api key'), async () => {
    const response = await handlePlan(phaseRequest(), planBody(), HEADERS);
    assertEquals(response.status, 502);
    const body = await response.json() as ErrorBody;
    assertEquals(body.code, 'api-key-invalid');
    assertStringIncludes(body.error, 'Model API error (401)');
  });
});

Deno.test('/plan sends the VENICE key to Venice, in a pipeline that also names OpenRouter', async () => {
  // The mixed-provider case the two-header design exists for: writing is Venice, refiner is
  // OpenRouter. /plan calls the WRITING slot, so it must reach api.venice.ai carrying the
  // Venice key — never the OpenRouter one, which would leak that secret to another vendor.
  const mixed = {
    ...COMMON,
    models: { writing: 'venice:venice-uncensored', research: SLOT, refiner: SLOT, analyzer: SLOT },
    messages: MESSAGES,
  } as unknown as PlanRequestBody;

  await withRecordedFetch(async () => {
    const response = await handlePlan(
      keyedRequest({ openRouter: 'sk-or-secret', venice: 'vk-secret' }), mixed, HEADERS);
    assertEquals(response.status, 200);
    assertStringIncludes(lastUpstream!.url, 'api.venice.ai');
    assertEquals(lastUpstream!.auth, 'Bearer vk-secret');
  });
});

Deno.test('/plan still sends the OPENROUTER key when the writing slot is OpenRouter', async () => {
  // The other half: the same request carries both keys, and the slot decides. Without this
  // the test above passes just as happily against a handler that always sent the Venice one.
  await withRecordedFetch(async () => {
    const response = await handlePlan(
      keyedRequest({ openRouter: 'sk-or-secret', venice: 'vk-secret' }), planBody(), HEADERS);
    assertEquals(response.status, 200);
    assertStringIncludes(lastUpstream!.url, 'openrouter.ai');
    assertEquals(lastUpstream!.auth, 'Bearer sk-or-secret');
  });
});

Deno.test('/plan refuses a venice slot with no X-Venice-Key, and does not fall back', async () => {
  const veniceBody = {
    ...COMMON,
    models: { writing: 'venice:venice-uncensored', research: SLOT, refiner: SLOT, analyzer: SLOT },
    messages: MESSAGES,
  } as unknown as PlanRequestBody;

  await withRecordedFetch(async () => {
    const response = await handlePlan(keyedRequest({ openRouter: 'sk-or-secret' }), veniceBody, HEADERS);
    assertEquals(response.status, 400);
    assertEquals((await response.json() as ErrorBody).error, 'X-Venice-Key header required for Venice models');
    assertEquals(lastUpstream, null, 'no upstream call should have been made');
  });
});

Deno.test('/plan answers 429 + rate-limited for a throttle', async () => {
  await withFetch(upstream(429, '{"error":"slow down"}'), async () => {
    const response = await handlePlan(phaseRequest(), planBody(), HEADERS);
    assertEquals(response.status, 429);
    assertEquals(((await response.json()) as ErrorBody).code, 'rate-limited');
  });
});

Deno.test('/plan answers 504 + provider-timeout, not 500, when the call times out', async () => {
  // The regression this pins: `isTimeoutError` used to pick the MESSAGE and leave the
  // status at 500, so a genuine upstream timeout was reported as a server fault.
  await withFetch(rejects(abortError()), async () => {
    const response = await handlePlan(phaseRequest(), planBody(), HEADERS);
    assertEquals(response.status, 504);
    const body = await response.json() as ErrorBody;
    assertEquals(body.code, 'provider-timeout');
    assertEquals(body.error, 'AI provider timed out');
  });
});

Deno.test('/plan leaves an unclassifiable failure as an uncoded 500', async () => {
  // A transport error is not an upstream verdict. It must NOT acquire a code, or the
  // author reads a confident reason for something we did not classify.
  await withFetch(rejects(new TypeError('connection reset')), async () => {
    const response = await handlePlan(phaseRequest(), planBody(), HEADERS);
    assertEquals(response.status, 500);
    const body = await response.json() as ErrorBody;
    assertEquals(body.error, 'Planning error');
    assertEquals(body.code, undefined);
  });
});

Deno.test('/plan answers a config error with 400 and the operator guidance', async () => {
  // `ollama:` on a non-self-hosted instance. Uncoded on purpose: the message names the
  // env var to set, which no catalog key improves on.
  await withFetch(upstream(200, '{}'), async () => {
    const body = { ...planBody(), models: { ...MODELS, writing: 'ollama:llama3' } };
    const response = await handlePlan(phaseRequest(), body as PlanRequestBody, HEADERS);
    assertEquals(response.status, 400);
    const parsed = await response.json() as ErrorBody;
    assertEquals(parsed.code, undefined);
    assertStringIncludes(parsed.error, 'only available on self-hosted');
  });
});

Deno.test('/analyze runs the same ladder', async () => {
  // The ladder is copied per handler rather than shared, so "it works on /plan" is not
  // evidence about /analyze. A clicheBlock is required or the handler short-circuits to
  // an empty 200 before it ever calls the model.
  const body = {
    ...COMMON,
    messages: MESSAGES,
    draftContent: 'a draft',
    clicheBlock: 'CLICHÉ INDEX',
  } as unknown as AnalyzeRequestBody;

  await withFetch(upstream(401, 'invalid api key'), async () => {
    const response = await handleAnalyze(phaseRequest(), body, HEADERS);
    assertEquals(response.status, 502);
    assertEquals(((await response.json()) as ErrorBody).code, 'api-key-invalid');
  });

  await withFetch(rejects(abortError()), async () => {
    const response = await handleAnalyze(phaseRequest(), body, HEADERS);
    assertEquals(response.status, 504);
    assertEquals(((await response.json()) as ErrorBody).code, 'provider-timeout');
  });
});

// ---------------------------------------------------------------------------
// SSE phases — the frame is the whole answer; the HTTP status is always 200
// ---------------------------------------------------------------------------

/** Every `data:` frame of an SSE response, parsed. `[DONE]` dropped. */
async function sseFrames(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text();
  return text
    .split('\n')
    .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map(line => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

const errorFrame = (frames: Record<string, unknown>[]) => frames.find(f => f['error']);
const summaryFrame = (frames: Record<string, unknown>[]) =>
  frames.find(f => f['summary'])?.['summary'] as Record<string, unknown> | undefined;
const contentOf = (frames: Record<string, unknown>[]) =>
  frames
    .map(f => (f['choices'] as { delta?: { content?: string } }[] | undefined)?.[0]?.delta?.content ?? '')
    .join('');

function draftBody(): DraftRequestBody {
  return { ...COMMON, messages: MESSAGES, researchContext: '' } as unknown as DraftRequestBody;
}

Deno.test('/draft reports the code on the frame, with HTTP 200 on the response', async () => {
  // The response committed as 200 before the model was ever called, so the frame's code
  // is the ONLY classification this failure will ever carry — there is no status for the
  // client to infer from.
  await withFetch(upstream(429, 'slow down'), async () => {
    const response = await handleDraft(phaseRequest(), draftBody(), HEADERS);
    assertEquals(response.status, 200);
    const frame = errorFrame(await sseFrames(response));
    assertEquals(frame?.['code'], 'rate-limited');
    assertStringIncludes(String(frame?.['error']), 'Model API error (429)');
  });
});

Deno.test('/draft still says "Draft error", uncoded, for an unclassified failure', async () => {
  await withFetch(rejects(new TypeError('connection reset')), async () => {
    const frames = await sseFrames(await handleDraft(phaseRequest(), draftBody(), HEADERS));
    const frame = errorFrame(frames);
    assertEquals(frame?.['error'], 'Draft error');
    assertEquals(frame?.['code'], undefined);
  });
});

// --- /refine: the draft fallback, and the three failures it must NOT absorb ---

const DRAFT = 'The original draft text.';

function refineBody(): RefineRequestBody {
  return {
    ...COMMON,
    messages: MESSAGES,
    draftContent: DRAFT,
    researchContext: '',
    analyzerFindings: '[voice] too passive',   // not "no findings" — see analyzerReportsClean
    codexStateBlock: '',
  } as unknown as RefineRequestBody;
}

Deno.test('/refine falls back to the draft for a failure a different model might fix', async () => {
  // The behaviour worth keeping: a model that errored oddly still yields prose, because a
  // draft beats an error.
  await withFetch(upstream(500, 'model exploded'), async () => {
    const frames = await sseFrames(await handleRefine(phaseRequest(), refineBody(), HEADERS));

    assertEquals(errorFrame(frames), undefined);
    assertEquals(contentOf(frames), DRAFT);
    assertEquals(summaryFrame(frames)?.['fellBackToDraft'], true);
    assert(frames.some(f => String(f['warning'] ?? '').includes('Refinement step failed')));
  });
});

Deno.test('/refine does NOT answer a throttle with "try a different refiner model"', async () => {
  // Three failures a different refiner model cannot fix. Before this, all three were
  // absorbed into the draft fallback and its advice, which was simply untrue.
  const cases: [() => Response | never, string][] = [
    [upstream(429, 'slow down'), 'rate-limited'],
    [upstream(401, 'invalid api key'), 'api-key-invalid'],
    [rejects(abortError()), 'provider-timeout'],
  ];

  for (const [answer, expectedCode] of cases) {
    await withFetch(answer, async () => {
      const frames = await sseFrames(await handleRefine(phaseRequest(), refineBody(), HEADERS));

      assertEquals(errorFrame(frames)?.['code'], expectedCode);
      // ...and none of the fallback happened: no draft streamed, no summary, no warning.
      assertEquals(contentOf(frames), '');
      assertEquals(summaryFrame(frames), undefined);
      assert(!frames.some(f => f['warning']), `${expectedCode} must not warn`);
    });
  }
});

// ---------------------------------------------------------------------------
// /research — the one phase that must talk to Supabase before it can fail
// ---------------------------------------------------------------------------

/**
 * Route by URL: PostgREST reads answer with an empty result set, everything else is the
 * model. `supabase-js` reads `fetch` off `globalThis` per call, so the same seam reaches
 * it — no PostgREST process, no fixture DB.
 *
 * Empty tables are enough: with no chapters the outline is `''`, with no codex rows the
 * caches are empty, and the research agents still run (their task list comes from the
 * plan, not the DB), which is the part under test.
 */
async function withResearchFetch(model: () => Response, fn: () => Promise<void>): Promise<void> {
  const savedUrl = Deno.env.get('SUPABASE_URL');
  const savedKey = Deno.env.get('SUPABASE_ANON_KEY');
  Deno.env.set('SUPABASE_URL', 'http://localhost:54321');
  Deno.env.set('SUPABASE_ANON_KEY', 'test-anon-key');
  try {
    await withFetch(() => new Response('[]', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }), async () => {
      const postgrestStub = globalThis.fetch;
      globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/rest/v1/')) return postgrestStub(input, init);
        try {
          return Promise.resolve(model());
        } catch (err) {
          return Promise.reject(err);
        }
      };
      await fn();
    });
  } finally {
    if (savedUrl === undefined) Deno.env.delete('SUPABASE_URL');
    else Deno.env.set('SUPABASE_URL', savedUrl);
    if (savedKey === undefined) Deno.env.delete('SUPABASE_ANON_KEY');
    else Deno.env.set('SUPABASE_ANON_KEY', savedKey);
  }
}

/** A plan the parser turns into two research tasks. */
const PLAN = JSON.stringify({
  research_tasks: [
    { focus: 'the protagonist', entities: ['Ada'], scenes: [] },
    { focus: 'the setting', entities: [], scenes: [] },
  ],
});

function researchBody(plan = PLAN): ResearchRequestBody {
  return { ...COMMON, plan } as unknown as ResearchRequestBody;
}

Deno.test('/research reports a total agent wipeout instead of answering 200 with no briefs', async () => {
  // The end of the chain the fan-out test starts: every agent fails on a rejected key →
  // `runResearchAgents` rethrows rather than returning [] → this handler's UpstreamError
  // arm renders it. Answering 200 with `briefCount: 0` here is the original bug.
  await withResearchFetch(upstream(401, 'invalid api key'), async () => {
    const response = await handleResearch(phaseRequest(), researchBody(), HEADERS);
    assertEquals(response.status, 502);
    assertEquals(((await response.json()) as ErrorBody).code, 'api-key-invalid');
  });
});

Deno.test('/research still answers 200 when the agents merely produced nothing useful', async () => {
  // A 500 is `provider-message`, which is NOT in the hard set: the draft is worth running
  // without research, so the phase degrades rather than failing the run.
  await withResearchFetch(upstream(500, 'model exploded'), async () => {
    const response = await handleResearch(phaseRequest(), researchBody(), HEADERS);
    assertEquals(response.status, 200);
    const body = await response.json() as { researchContext: string; metadata: { briefCount: number } };
    assertEquals(body.metadata.briefCount, 0);
    assertEquals(body.researchContext, '');
  });
});

Deno.test('/research with no plan tasks never calls a model at all', async () => {
  let modelCalled = false;
  await withResearchFetch(() => { modelCalled = true; return new Response('{}', { status: 200 }); }, async () => {
    const response = await handleResearch(phaseRequest(), researchBody('no json here'), HEADERS);
    assertEquals(response.status, 200);
    assertEquals(modelCalled, false);
  });
});

// ---------------------------------------------------------------------------
// The watchdog arms — which code each phase pairs with its own 504
// ---------------------------------------------------------------------------

/**
 * Run `fn` with the phase already out of budget.
 *
 * A **one-shot** `Date.now`: the handler's `const phaseStart = Date.now()` gets a
 * timestamp one full budget in the past, and every later call (including the watchdog's
 * own `Date.now() - phaseStartTime`) gets the real clock, so `remaining` computes to 0
 * and the timer fires on the next macrotask. One-shot rather than a fixed fake clock,
 * because a frozen clock makes `elapsed` zero and the watchdog would wait the full 145s.
 *
 * Safe only because nothing in these handlers reads `Date.now` before `phaseStart` —
 * `getCycleMonth` uses `new Date()`, which this does not touch. If that changed, these
 * tests would fail loudly rather than silently pass.
 */
async function withExhaustedBudget(fn: () => Promise<void>): Promise<void> {
  const realNow = Date.now;
  let armed = true;
  Date.now = () => {
    if (!armed) return realNow();
    armed = false;
    return realNow() - PHASE_BUDGET_MS - PHASE_SAFETY_MARGIN_MS;
  };
  try {
    // Never resolves — only the watchdog's abort ends it, which is what the real
    // wall-clock case looks like: an upstream still thinking when the budget runs out.
    await withFetch(() => new Response('unused'), async () => {
      globalThis.fetch = (_input: string | URL | Request, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(abortError()));
        });
      await fn();
    });
  } finally {
    Date.now = realNow;
  }
}

Deno.test('/plan pairs its watchdog 504 with step-too-slow', async () => {
  // Planning reads neither wordCount nor preset, so the size-driven advice would be false
  // here. This is the arm the two-code split exists for, and nothing else runs it.
  await withExhaustedBudget(async () => {
    const response = await handlePlan(phaseRequest(), planBody(), HEADERS);
    assertEquals(response.status, 504);
    const body = await response.json() as ErrorBody;
    assertEquals(body.code, 'step-too-slow');
    assertEquals(body.error, 'Planning exceeded time budget');
  });
});

Deno.test('/analyze pairs its watchdog 504 with the size-driven code instead', async () => {
  await withExhaustedBudget(async () => {
    const body = {
      ...COMMON,
      messages: MESSAGES,
      draftContent: 'a draft',
      clicheBlock: 'CLICHÉ INDEX',
    } as unknown as AnalyzeRequestBody;
    const response = await handleAnalyze(phaseRequest(), body, HEADERS);
    assertEquals(response.status, 504);
    assertEquals(((await response.json()) as ErrorBody).code, 'generation-too-long');
  });
});

Deno.test('/draft answers a watchdog timeout on the frame, and only once', async () => {
  // The SSE side: the watchdog writes the frame itself and the handler must NOT write a
  // second one on top of it — `wd.fired` returns early precisely for that.
  await withExhaustedBudget(async () => {
    const frames = await sseFrames(await handleDraft(phaseRequest(), draftBody(), HEADERS));
    const errors = frames.filter(f => f['error']);
    assertEquals(errors.length, 1);
    assertEquals(errors[0]['code'], 'generation-too-long');
    assertStringIncludes(String(errors[0]['error']), 'took too long');
  });
});

Deno.test('/refine streams the draft unrefined when the analyzer reported it clean', async () => {
  // Not an error path, but it shares the fallback's streaming loop — and a change to that
  // loop's guards would break this silently. `fetch` must never be reached.
  let called = false;
  await withFetch(() => { called = true; return new Response('{}', { status: 200 }); }, async () => {
    const body = { ...refineBody(), analyzerFindings: 'No findings.' } as RefineRequestBody;
    const frames = await sseFrames(await handleRefine(phaseRequest(), body, HEADERS));

    assertEquals(called, false);
    assertEquals(contentOf(frames), DRAFT);
    assertEquals(summaryFrame(frames)?.['skippedClean'], true);
    assertEquals(summaryFrame(frames)?.['fellBackToDraft'], false);
  });
});
