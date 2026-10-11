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
 * itself; the spent-budget answer sits behind Stripe and the usage table, so it is covered
 * through the helper every one of its five call sites uses.
 */

import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { exportJWK, generateKeyPair, SignJWT } from 'npm:jose@6';
import { budgetExhaustedResponse, configErrorResponse, handlePlan, handleRequest } from '../router.ts';
import { ModelProviderConfigError } from '../../_shared/model-calling.ts';
import { resetHostedInstanceCacheForTests } from '../../_shared/stripe-helpers.ts';
import type { PlanRequestBody } from '../../_shared/agentic-writer-types.ts';

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
