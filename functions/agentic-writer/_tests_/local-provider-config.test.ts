/**
 * Deno tests for the **operator-facing 400** an unconfigured local provider answers
 * (`agentic-writer/router.ts`).
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/agentic-writer/_tests_/local-provider-config.test.ts
 *
 * `docker/.env.example` promises operators that leaving `OLLAMA_BASE_URL` /
 * `OPENAI_COMPATIBLE_BASE_URL` unset changes nothing except that "a local slot answers 400
 * naming the variable". The *resolver* half of that is already covered
 * (`_shared/_tests_/model-calling-upstream.test.ts` — unset, whitespace-only, hosted
 * instance, invalid URL). What was not covered is the **HTTP contract**: that the endpoint
 * an operator actually hits answers 400, with that message, having called nothing upstream.
 *
 * So every test here drives `handleRequest` — the whole wired path, auth gate included —
 * rather than a handler or `validateCommonBody` (which is not exported, and deliberately:
 * the claim under test is about the endpoint, not about one private function).
 *
 * **What each case is load-bearing for**, since a file of near-identical 400 assertions
 * invites the assumption that they are interchangeable:
 *   - 1, 2 and 6 would pass without the eager-resolve loop at `router.ts:250-259`, because
 *     `handlePlan`'s backstop catch answers a byte-identical 400 (`callModel` resolves
 *     before it fetches, so `fetch` stays uncalled there too).
 *   - **Case 3 is the eager loop's reason to exist**: `/plan` only ever resolves the
 *     `writing` slot, so a broken `research` slot sails through without it — a 200.
 *   - **Case 4 pins the structural claim** in that comment: the loop runs before any SSE
 *     response is opened, which is the only reason `/draft` can answer JSON at all.
 *     Without it the operator gets a 200 `text/event-stream` carrying an error frame.
 *   - **Case 5 is the negative control.** Without a case that must *not* 400, a change
 *     making every request 400 leaves the rest of this file green.
 *
 * **Why HS256 and not the JWKS machinery in `request-auth.test.ts`.** These tests need
 * `SELF_HOSTED=true` regardless — it is what `allowedSlotProviders()` gates local slots on
 * — and `verifySupabaseJwt` takes the symmetric branch whenever that plus `JWT_SECRET` is
 * set. So the cheap branch is also the realistic self-hosted env here. (That file's stated
 * reason for avoiding HS256 — a module-level symmetric key cache — no longer exists; see
 * the note in `_shared/auth.ts` explaining why there is deliberately none.) The symmetric
 * branch checks `audience: 'authenticated'` and not the issuer, and `extractAuthFromRequest`
 * rejects a token with no `email` claim.
 *
 * FOOTGUN: `deno test … supabase/functions/` runs every test in ONE process, and
 * `stripe/_tests_/self-hosted-lockdown.test.ts` sets `SELF_HOSTED=true` at module scope. So
 * `withEnv` below sets exactly the keys it is given, **deletes** every other key it owns,
 * and restores all of them in a `finally`. Each test also mints its own JWT subject: the
 * rate limiter keys on a hash of the Authorization header, so a shared token would share
 * one 50-per-60s bucket across the file.
 */

import { assert, assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { SignJWT } from 'npm:jose@6';
import { handleRequest } from '../router.ts';

const SECRET = 'local-provider-config-test-secret-min-32-chars';
const SUPABASE_URL = 'http://agentic-local-provider.test:54321';
const OLLAMA_URL = 'http://ollama.test:11434';

const ENV_KEYS = [
  'SELF_HOSTED',
  'JWT_SECRET',
  'SUPABASE_URL',
  'SUPABASE_PUBLIC_URL',
  'OLLAMA_BASE_URL',
  'OLLAMA_API_KEY',
  'OPENAI_COMPATIBLE_BASE_URL',
  'OPENAI_COMPATIBLE_API_KEY',
] as const;

/** Run `fn` with exactly `env` set (every other key above deleted), then restore all of them. */
async function withEnv(
  env: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    saved.set(key, Deno.env.get(key));
    const value = env[key];
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

/** The self-hosted env every case starts from — auth works, no local provider configured. */
const SELF_HOSTED_BASE = { SELF_HOSTED: 'true', JWT_SECRET: SECRET, SUPABASE_URL } as const;

/**
 * A token the symmetric branch accepts. `subject` varies per test so each gets its own
 * rate-limit bucket — see the header.
 */
function mintToken(subject: string): Promise<string> {
  return new SignJWT({ email: `${subject}@test.local` })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience('authenticated')
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(SECRET));
}

function phaseRequest(
  path: string,
  token: string,
  body: Record<string, unknown>,
  apiKey?: string,
): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };
  if (apiKey) headers['X-API-Key'] = apiKey;
  return new Request(`${SUPABASE_URL}/agentic-writer${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

/**
 * The body fields every case sends. `messages` and `researchContext` are here so that a
 * regression is answered by the *config* 400 and not by a validation 400 that happens to
 * share its status — and so the mutation checks in the plan actually reach a 200.
 */
const COMMON = {
  pipelineRequestId: 'local-provider-test',
  storyId: 'story-1',
  messages: [{ role: 'user', content: 'write something' }],
  researchContext: '',
  preset: 'balanced' as const,
  wordCount: 400,
};

interface FetchCall { url: string }

/**
 * Run `fn` with `fetch` answering with `answer`, recording every call, restoring the real
 * one afterwards. Assigned rather than spied — the shape `phase-handlers.test.ts` uses.
 */
async function withFetch(
  answer: () => Response,
  fn: (calls: FetchCall[]) => Promise<void>,
): Promise<void> {
  const realFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (input: string | URL | Request) => {
    calls.push({ url: input instanceof Request ? input.url : input.toString() });
    try {
      return Promise.resolve(answer());
    } catch (err) {
      return Promise.reject(err);
    }
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** A minimal OpenAI-shaped completion — enough for `callModel` to return normally. */
const completion = () => new Response(
  JSON.stringify({
    choices: [{ message: { content: 'drafted' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
);

interface ErrorBody { error: string; code?: string }

// ---------------------------------------------------------------------------
// 1 + 2 — the promise `.env.example` makes, per provider
// ---------------------------------------------------------------------------

Deno.test('/plan: an unset OLLAMA_BASE_URL is a 400 naming the variable, with no upstream call', async () => {
  await withEnv(SELF_HOSTED_BASE, async () => {
    await withFetch(completion, async (calls) => {
      const token = await mintToken('local-cfg-ollama');
      const response = await handleRequest(
        phaseRequest('/plan', token, { ...COMMON, models: { writing: 'ollama:llama3' } }),
      );

      assertEquals(response.status, 400);
      const body = await response.json() as ErrorBody;
      assertStringIncludes(body.error, 'OLLAMA_BASE_URL');
      assertStringIncludes(body.error, 'not configured on this server');
      // Operator guidance stays UNCODED — a code would send the client down the
      // localized-provider-error path, and this message is the whole point.
      assertEquals(body.code, undefined);
      assertEquals(calls.length, 0, 'nothing should have been called upstream');
    });
  });
});

Deno.test('/plan: an unset OPENAI_COMPATIBLE_BASE_URL is a 400 naming the variable', async () => {
  await withEnv(SELF_HOSTED_BASE, async () => {
    await withFetch(completion, async (calls) => {
      const token = await mintToken('local-cfg-compat');
      const response = await handleRequest(
        phaseRequest('/plan', token, { ...COMMON, models: { writing: 'openaiCompatible:mistral' } }),
      );

      assertEquals(response.status, 400);
      const body = await response.json() as ErrorBody;
      assertStringIncludes(body.error, 'OPENAI_COMPATIBLE_BASE_URL');
      assertStringIncludes(body.error, 'not configured on this server');
      assertEquals(body.code, undefined);
      assertEquals(calls.length, 0, 'nothing should have been called upstream');
    });
  });
});

// ---------------------------------------------------------------------------
// 3 — the eager-resolve loop's reason to exist
// ---------------------------------------------------------------------------

Deno.test('/plan: a broken slot the handler never resolves is still a 400', async () => {
  // THE case for `router.ts`'s eager-resolve loop. `handlePlan` only ever calls
  // `callModel(body.models.writing, …)`, so nothing downstream ever touches `research`:
  // delete that loop and this request answers 200 with a plan, leaving the operator's
  // misconfiguration to surface later, on a different phase.
  await withEnv(SELF_HOSTED_BASE, async () => {
    await withFetch(completion, async (calls) => {
      const token = await mintToken('local-cfg-unused-slot');
      const response = await handleRequest(
        phaseRequest('/plan', token, {
          ...COMMON,
          models: { writing: 'openrouter:test/model', research: 'ollama:llama3' },
        }, 'sk-or-test'),
      );

      assertEquals(response.status, 400);
      const body = await response.json() as ErrorBody;
      assertStringIncludes(body.error, 'OLLAMA_BASE_URL');
      assertEquals(calls.length, 0, 'the OpenRouter writing slot should never have been called');
    });
  });
});

// ---------------------------------------------------------------------------
// 4 — the structural claim: JSON, not a 200 SSE stream carrying an error frame
// ---------------------------------------------------------------------------

Deno.test('/draft: a config error answers JSON, not an opened SSE stream', async () => {
  await withEnv(SELF_HOSTED_BASE, async () => {
    await withFetch(completion, async (calls) => {
      const token = await mintToken('local-cfg-draft');
      const response = await handleRequest(
        phaseRequest('/draft', token, { ...COMMON, models: { writing: 'ollama:llama3' } }),
      );

      assertEquals(response.status, 400);
      const contentType = response.headers.get('Content-Type') ?? '';
      assertStringIncludes(contentType, 'application/json');
      assert(!contentType.includes('text/event-stream'), 'the stream must not have been opened');
      const body = await response.json() as ErrorBody;
      assertStringIncludes(body.error, 'OLLAMA_BASE_URL');
      assertEquals(calls.length, 0, 'nothing should have been called upstream');
    });
  });
});

// ---------------------------------------------------------------------------
// 5 — negative control: a CONFIGURED local provider is not rejected
// ---------------------------------------------------------------------------

Deno.test('/plan: a configured OLLAMA_BASE_URL passes the gate and reaches the operator URL', async () => {
  // Without this, a change that made every request 400 would leave every other test in
  // this file green. It doubles as coverage for `handleRequest`'s
  // `body['models'] = validated.models`: only `writing` is supplied, so the defaulted
  // research/refiner/analyzer slots exist solely because the router assigns them back —
  // remove that line and `parseModelSlot(undefined)` throws outside any catch.
  await withEnv({ ...SELF_HOSTED_BASE, OLLAMA_BASE_URL: OLLAMA_URL }, async () => {
    await withFetch(completion, async (calls) => {
      const token = await mintToken('local-cfg-configured');
      const response = await handleRequest(
        phaseRequest('/plan', token, { ...COMMON, models: { writing: 'ollama:llama3' } }),
      );

      // Assert about the GATE, not about /plan succeeding: what matters is that no config
      // 400 was raised and the request left for the operator's own server.
      assertEquals(response.status, 200);
      await response.body?.cancel();
      assertEquals(calls.length, 1);
      assertEquals(calls[0].url, `${OLLAMA_URL}/v1/chat/completions`);
    });
  });
});

// ---------------------------------------------------------------------------
// 6 — a set-but-unusable base URL names the variable too
// ---------------------------------------------------------------------------

Deno.test('/plan: an invalid OLLAMA_BASE_URL is a 400 naming the variable as invalid', async () => {
  await withEnv({ ...SELF_HOSTED_BASE, OLLAMA_BASE_URL: 'ftp://evil/' }, async () => {
    await withFetch(completion, async (calls) => {
      const token = await mintToken('local-cfg-invalid');
      const response = await handleRequest(
        phaseRequest('/plan', token, { ...COMMON, models: { writing: 'ollama:llama3' } }),
      );

      assertEquals(response.status, 400);
      const body = await response.json() as ErrorBody;
      assertStringIncludes(body.error, 'OLLAMA_BASE_URL is invalid');
      assertEquals(calls.length, 0, 'nothing should have been called upstream');
    });
  });
});
