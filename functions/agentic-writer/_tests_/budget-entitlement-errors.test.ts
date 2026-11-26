/**
 * Deno tests for the CODES on Deep Writer's budget and entitlement refusals
 * (`agentic-writer/router.ts`, `setupBudgetContext` and the between-phase budget checks).
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/agentic-writer/_tests_/budget-entitlement-errors.test.ts
 *
 * These refusals used to carry an English sentence and nothing else, so the client fell back
 * to its status inference and an author reading German saw "Subscription required for included
 * AI models". The client owns the wording per `code`; the contract pinned here is that each
 * refusal names the code the catalogs are keyed by, at the status the client's fallback
 * would infer for it.
 *
 * Entered below the auth gate through `handlePlan`, like `phase-handlers.test.ts`. The
 * entitlement case needs a real signed token because `setupBudgetContext` verifies the JWT
 * itself. The spent-budget answer sits behind Stripe and the usage table, so its five call sites
 * are driven through `setBudgetReadsForTests`, which stubs both reads (#407).
 */

import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { exportJWK, generateKeyPair, SignJWT } from 'npm:jose@6';
import {
  budgetExhaustedResponse,
  configErrorResponse,
  handleAnalyze,
  handleDraft,
  handlePlan,
  handleRefine,
  handleRequest,
  handleResearch,
  setBudgetReadsForTests,
} from '../router.ts';
import { ModelProviderConfigError } from '../../_shared/model-calling.ts';
import { resetHostedInstanceCacheForTests } from '../../_shared/stripe-helpers.ts';
import type { PlanRequestBody } from '../../_shared/agentic-writer-types.ts';
import type { JwtValidationResult } from '../../_shared/types.ts';

// Unique per test file: the JWKS cache is keyed per URL.
const SUPABASE_URL = 'http://agentic-budget-errors.test:54321';
const KID = 'budget-errors-test-key';
const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
const PUBLIC_JWK = { ...(await exportJWK(publicKey)), alg: 'ES256', kid: KID, use: 'sig' };

const HEADERS = { 'Content-Type': 'application/json' };
const INCLUDED = 'included:deepseek-chat';
const BODY = {
  pipelineRequestId: 'budget-errors',
  storyId: 's1',
  models: { writing: INCLUDED, research: INCLUDED, refiner: INCLUDED, analyzer: INCLUDED },
  messages: [{ role: 'user', content: 'write something' }],
  preset: 'balanced' as const,
  wordCount: 400,
} as unknown as PlanRequestBody;

interface ErrorBody { error: string; code?: string }

function mintToken(subject: string): Promise<string> {
  return new SignJWT({ email: `${subject}@test.local` })
    .setProtectedHeader({ alg: 'ES256', kid: KID })
    .setIssuer(`${SUPABASE_URL}/auth/v1`)
    .setAudience('authenticated')
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

const ENV_KEYS = [
  'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_PUBLIC_URL', 'SELF_HOSTED',
  'DEEPSEEK_API_KEY', 'LICENSE_KEY', 'LICENSE_SIGNING_KEY',
];

/** Run `fn` with exactly this environment, the JWKS document served, and everything restored. */
async function withEnv(env: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved = new Map(ENV_KEYS.map(k => [k, Deno.env.get(k)]));
  for (const k of ENV_KEYS) Deno.env.delete(k);
  Deno.env.set('SUPABASE_URL', SUPABASE_URL);
  Deno.env.set('SUPABASE_ANON_KEY', 'test-anon-key');
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  resetHostedInstanceCacheForTests();

  const realFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/.well-known/jwks.json')) {
      return Promise.resolve(new Response(JSON.stringify({ keys: [PUBLIC_JWK] }), { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected fetch in test: ${url}`));
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of saved) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    resetHostedInstanceCacheForTests();
  }
}

function request(token = 'unused'): Request {
  return new Request(`${SUPABASE_URL}/agentic-writer/plan`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
  });
}

Deno.test('included AI on a self-hosted instance is refused as self-hosted-unavailable (403)', async () => {
  await withEnv({ SELF_HOSTED: 'true', DEEPSEEK_API_KEY: 'ds-key' }, async () => {
    const response = await handlePlan(request(), BODY, HEADERS);
    assertEquals(response.status, 403);
    assertEquals(((await response.json()) as ErrorBody).code, 'self-hosted-unavailable');
  });
});

Deno.test('a server without DEEPSEEK_API_KEY answers provider-unavailable (502), not an uncoded 400', async () => {
  // A misconfigured server is not a bad request: 400 told the client "fix your input" and
  // carried no code. premium/ai/chat answers the same fault 502 provider-unavailable.
  await withEnv({}, async () => {
    const response = await handlePlan(request(), BODY, HEADERS);
    assertEquals(response.status, 502);
    const body = await response.json() as ErrorBody;
    assertEquals(body.code, 'provider-unavailable');
    assertStringIncludes(body.error, 'DEEPSEEK_API_KEY');
  });
});

Deno.test('through handleRequest, a missing DEEPSEEK_API_KEY is 502 provider-unavailable on every phase', async () => {
  // validateCommonBody resolves every slot before setupBudgetContext ever runs, so THIS is
  // the path production takes; the handlePlan spec above only reaches the backstop.
  await withEnv({}, async () => {
    const token = await mintToken('user-no-key');
    for (const phase of ['plan', 'research', 'draft', 'analyze', 'refine']) {
      const response = await handleRequest(new Request(`${SUPABASE_URL}/agentic-writer/${phase}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ ...BODY, researchContext: '' }),
      }));
      assertEquals(response.status, 502, phase);
      const body = await response.json() as ErrorBody;
      assertEquals(body.code, 'provider-unavailable', phase);
      assertStringIncludes(body.error, 'DEEPSEEK_API_KEY');
    }
  });
});

Deno.test('any other slot config error stays an uncoded 400 with its guidance', () => {
  const response = configErrorResponse(new ModelProviderConfigError('OLLAMA_BASE_URL is not set'), HEADERS);
  assertEquals(response.status, 400);
  return response.json().then((body: ErrorBody) => {
    assertEquals(body.code, undefined);
    assertEquals(body.error, 'OLLAMA_BASE_URL is not set');
  });
});

Deno.test('an account with no subscription tier is refused as subscription-required (403)', async () => {
  // No LICENSE_SIGNING_KEY: this is not a genuine hosted instance, so the subscription check
  // answers tier 'none' without touching Stripe or the database.
  await withEnv({ DEEPSEEK_API_KEY: 'ds-key' }, async () => {
    const response = await handlePlan(request(await mintToken('user-no-tier')), BODY, HEADERS);
    assertEquals(response.status, 403);
    assertEquals(((await response.json()) as ErrorBody).code, 'subscription-required');
  });
});

Deno.test('a spent monthly budget is budget-exhausted (429) and keeps the response headers', async () => {
  const response = budgetExhaustedResponse({ 'X-Test': 'kept', ...HEADERS });
  assertEquals(response.status, 429);
  assertEquals(response.headers.get('X-Test'), 'kept');
  const body = await response.json() as ErrorBody;
  assertEquals(body.code, 'budget-exhausted');
  assertEquals(body.error, 'Monthly AI budget exceeded');
});

// --- The five call sites of the spent-budget answer (#407) ---
//
// The helper's own shape (above) proved nothing about its callers: reverting one between-phase
// site to a bare `jsonResponse` left the suite green. These drive each handler through
// `setBudgetReadsForTests`, with a paid caller and a scripted series of usage reads, and pin the
// refusal at the site that makes it. The read count says which site that was: one read is the
// pre-flight in `setupBudgetContext`, two is the between-phase check after it.

const PAID: JwtValidationResult = {
  valid: true,
  email: 'paid@test.local',
  tier: 'premium',
  customerId: 'cus_budget_test',
  userId: 'user-paid',
  subData: { status: 'active', currentPeriodEnd: 0, cancelAtPeriodEnd: false, tier: 'premium' },
};
/** `premium`'s monthly budget in USD (`ai-usage.ts`): reading this much means spent. */
const SPENT = 5;

/**
 * Run `fn` with a paid caller whose usage reads answer `usage` in order (the last one repeats),
 * an `Error` entry rejecting. `reads()` is how many usage reads the handler made.
 */
async function withBudget(
  usage: Array<number | Error>,
  fn: (reads: () => number) => Promise<void>,
): Promise<void> {
  let reads = 0;
  setBudgetReadsForTests({
    validateJwtAndGetSubscription: () => Promise.resolve(PAID),
    getMonthlyUsage: () => {
      const next = usage[Math.min(reads, usage.length - 1)];
      reads++;
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  });
  try {
    await withEnv({ DEEPSEEK_API_KEY: 'ds-key' }, () => fn(() => reads));
  } finally {
    setBudgetReadsForTests(null);
  }
}

/** Every field any of the four later phases validates before its budget check. */
const PHASE_BODY = {
  ...BODY,
  plan: '',
  researchContext: '',
  draftContent: 'A draft.',
  clicheBlock: '',
  analyzerFindings: '',
};

type Handler = (r: Request, b: never, h: Record<string, string>) => Promise<Response>;
const BETWEEN_PHASE_SITES: Array<[string, Handler]> = [
  ['research', handleResearch as Handler],
  ['draft', handleDraft as Handler],
  ['analyze', handleAnalyze as Handler],
  ['refine', handleRefine as Handler],
];

async function assertBudgetExhausted(response: Response, context: string): Promise<void> {
  assertEquals(response.status, 429, context);
  const body = await response.json() as ErrorBody;
  assertEquals(body.code, 'budget-exhausted', context);
  assertEquals(body.error, 'Monthly AI budget exceeded', context);
}

Deno.test('a budget already spent at the pre-flight check is budget-exhausted (429)', async () => {
  await withBudget([SPENT], async (reads) => {
    const response = await handlePlan(request(), BODY, HEADERS);
    await assertBudgetExhausted(response, 'plan');
    assertEquals(reads(), 1, 'refused by the pre-flight read, not a later one');
  });
});

for (const [phase, handle] of BETWEEN_PHASE_SITES) {
  Deno.test(`/${phase}: a budget spent between the pre-flight and the phase is budget-exhausted (429)`, async () => {
    await withBudget([0, SPENT], async (reads) => {
      const response = await handle(request(), PHASE_BODY as never, HEADERS);
      await assertBudgetExhausted(response, phase);
      assertEquals(reads(), 2, `${phase}: refused by the between-phase read`);
    });
  });
}

Deno.test('a between-phase read that fails lets the phase run, as it always has', async () => {
  // `checkBudgetBetweenSteps` fails open on purpose: a usage table that cannot be read must not
  // stop every included run. With no Cliché block and no style message, /analyze then gives its
  // own "nothing to analyze" answer without a model call, so reaching that answer proves the
  // phase ran past the gate.
  await withBudget([0, new Error('usage table down')], async (reads) => {
    const response = await handleAnalyze(request(), PHASE_BODY as never, HEADERS);
    assertEquals(reads(), 2);
    assertEquals(response.status, 200);
    const body = await response.json() as { findings?: string; model?: string };
    assertEquals(body.findings, '');
    assertEquals(body.model, 'deepseek-chat');
  });
});
