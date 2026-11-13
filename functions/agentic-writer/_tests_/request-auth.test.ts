/**
 * Deno tests for `handleRequest`'s **auth gate** (`agentic-writer/router.ts`).
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/agentic-writer/_tests_/request-auth.test.ts
 *
 * This was `analyze-cliches.test.ts` until the cliché-index build moved into the browser and
 * that route was deleted. It was **retargeted rather than deleted**, because it is the only
 * file in this suite that exercises `extractAuthFromRequest` and the JWKS asymmetric branch at
 * all — `_shared/_tests_/auth-symmetric.test.ts` covers the *symmetric* branch, and the five
 * phase tests call `handleX` directly and so enter *below* the gate. Deleting it would have
 * silently dropped asymmetric-auth coverage for every endpoint.
 *
 * **The gate is not special to any one route.** `handleRequest` runs it before it dispatches to
 * any phase endpoint, so `/plan` is as good a subject as the deleted one was — the route here
 * is a vehicle for reaching the gate, not the thing under test. The cliché-specific cases (text
 * matching, the analyzer prompt's language line, the Venice key header) went with the route.
 *
 * **Why JWKS and not HS256, which would be three lines shorter.** This file exercises the
 * hosted env — `withStubs` deletes `SELF_HOSTED` — and `verifySupabaseJwt` takes the symmetric
 * branch only when `SELF_HOSTED=true` **and** `JWT_SECRET` is set. So on the shape being tested
 * here JWKS is not a preference, it is the branch, and "simplifying" this to HS256 would make it
 * pass or fail on file order: two stripe test files already mint HS256 tokens with different
 * secrets in the same process. The odd hostname below is still load-bearing for a second
 * reason: the JWKS cache is keyed per URL (`cachedJWKSUrl`), so a distinctive `SUPABASE_URL`
 * gets a fresh entry no matter who ran first in the shared process — and re-creates another
 * file's entry if it runs after, which is self-healing.
 *
 * The JWKS document itself is served by the same `fetch` stub that serves the model, which is
 * the point: one seam, two upstreams.
 */

import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { exportJWK, generateKeyPair, SignJWT } from 'npm:jose@6';
import { handleRequest } from '../router.ts';

/** Unique per test file — see the JWKS note above. */
const SUPABASE_URL = 'http://agentic-request-auth.test:54321';
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const KID = 'request-auth-test-key';

// **ES256, not RS256, and it is not arbitrary.** This runs at import time, so its cost is
// paid by every `deno test supabase/functions/` run whether these tests are selected or
// not — and RSA-2048 keygen measures ~145ms against ES256's ~0.2ms, which dominated what
// this file cost the suite (the end-to-end delta is noisier than that figure: ~0.1–0.25s
// on a ~1.4s suite). `_shared/auth.ts` restricts no algorithms — it matches the JWKS key
// by `kid` — and hosted Supabase's own signing keys are ECC, so this is the cheaper *and*
// the more representative choice.
const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
const PUBLIC_JWK = { ...(await exportJWK(publicKey)), alg: 'ES256', kid: KID, use: 'sig' };

/** A key the JWKS document never advertises — for the wrongly-signed case below. */
const { privateKey: foreignKey } = await generateKeyPair('ES256', { extractable: true });

/**
 * A valid token. `subject` varies per test on purpose: the rate limiter keys on a hash of
 * the Authorization header, so reusing one token across the file would share a single
 * 50-per-60s bucket.
 */
// `typeof privateKey`, not `CryptoKey`: jose hands back node:crypto's webcrypto flavour,
// which is structurally a different type from the global one under `deno check`.
function mintToken(subject: string, key: typeof privateKey = privateKey): Promise<string> {
  return new SignJWT({ email: `${subject}@test.local` })
    .setProtectedHeader({ alg: 'ES256', kid: KID })
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}

/** The body fields `validateCommonBody` needs, so a 400 here is never a validation accident. */
const COMMON = {
  pipelineRequestId: 'request-auth-test',
  storyId: 's1',
  messages: [{ role: 'user', content: 'write something' }],
  researchContext: '',
  preset: 'balanced' as const,
  wordCount: 400,
};

/** An `openrouter:` slot short-circuits the budget path before it can reach Stripe or a JWT. */
const MODELS = { writing: 'openrouter:test/model' };

function planRequest(token: string | null, body: Record<string, unknown>): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-API-Key': 'sk-or-test' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return new Request(`${SUPABASE_URL}/agentic-writer/plan`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** A minimal OpenAI-shaped completion — enough for `callModel` to return normally. */
const completion = () => json({
  choices: [{ message: { content: 'planned' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});

/**
 * Serve both upstreams off one stub, routed by URL: the JWKS document and the model.
 * `supabase-js` reads `fetch` off `globalThis` per call, so a PostgREST read would land here
 * too — nothing on this path makes one, which is why there is no arm for it.
 */
async function withStubs(fn: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const key of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SELF_HOSTED', 'SUPABASE_PUBLIC_URL']) {
    saved.set(key, Deno.env.get(key));
  }
  Deno.env.set('SUPABASE_URL', SUPABASE_URL);
  Deno.env.set('SUPABASE_ANON_KEY', 'test-anon-key');
  // The asymmetric branch is the one we signed for; SUPABASE_PUBLIC_URL would move the
  // expected issuer, so clear both rather than inherit another file's values.
  Deno.env.delete('SELF_HOSTED');
  Deno.env.delete('SUPABASE_PUBLIC_URL');

  const realFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/.well-known/jwks.json')) return Promise.resolve(json({ keys: [PUBLIC_JWK] }));
    return Promise.resolve(completion());
  };

  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

interface ErrorBody { error: string; code?: string }

Deno.test('the auth gate refuses an unsigned request', async () => {
  await withStubs(async () => {
    const response = await handleRequest(planRequest(null, { ...COMMON, models: MODELS }));
    assertEquals(response.status, 401);
    assertEquals(((await response.json()) as ErrorBody).code, 'auth-required');
  });
});

Deno.test('the auth gate refuses a token it cannot verify', async () => {
  // Well-formed enough to slice, wrong enough to fail the signature check.
  await withStubs(async () => {
    const response = await handleRequest(planRequest('not.a.jwt', { ...COMMON, models: MODELS }));
    assertEquals(response.status, 401);
    assertEquals(((await response.json()) as ErrorBody).code, 'auth-required');
  });
});

Deno.test('the auth gate refuses a token signed with the wrong key', async () => {
  // The realistic "cannot verify" case, and a stronger claim than the one above: this
  // token parses, names a `kid` the JWKS document does advertise, and still fails —
  // so the gate is doing crypto, not just decoding.
  await withStubs(async () => {
    const forged = await mintToken('user-forged', foreignKey);
    const response = await handleRequest(planRequest(forged, { ...COMMON, models: MODELS }));
    assertEquals(response.status, 401);
    assertEquals(((await response.json()) as ErrorBody).code, 'auth-required');
  });
});

Deno.test('a signed token reaches the handler', async () => {
  // The one that proves the other cases fail where they claim to: without a success path,
  // a 401 could just as well be something upstream of the gate refusing everything.
  await withStubs(async () => {
    const response = await handleRequest(
      planRequest(await mintToken('user-ok'), { ...COMMON, models: MODELS }),
    );
    assertEquals(response.status, 200);
    await response.body?.cancel();
  });
});

Deno.test('the body is validated only AFTER authenticating', async () => {
  // Auth first, then the request checks — and these stay uncoded, because "models is
  // required" names the field and no translated generic sentence improves on it.
  await withStubs(async () => {
    const response = await handleRequest(
      planRequest(await mintToken('user-nomodels'), { ...COMMON }),
    );
    assertEquals(response.status, 400);
    const body = await response.json() as ErrorBody;
    assertStringIncludes(body.error, 'models is required');
    assertEquals(body.code, undefined);
  });
});

/** A `/plan` request on a NanoGPT writer slot, with or without the author's NanoGPT key. */
function nanoGptPlan(token: string, nanoGptKey: string | null, extra: Record<string, unknown> = {}): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
  if (nanoGptKey) headers['X-NanoGPT-Key'] = nanoGptKey;
  return new Request(`${SUPABASE_URL}/agentic-writer/plan`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...COMMON, models: { writing: 'nanogpt:qwen/q3:thinking' }, ...extra }),
  });
}

Deno.test('a NanoGPT slot without X-NanoGPT-Key is a 400 naming the header', async () => {
  await withStubs(async () => {
    const response = await handleRequest(nanoGptPlan(await mintToken('user-nano-nokey'), null));
    assertEquals(response.status, 400);
    assertStringIncludes((await response.json() as ErrorBody).error, 'X-NanoGPT-Key');
  });
});

Deno.test('a NanoGPT slot sends the forwarded key, the resolved effort and the clamped budget to nano-gpt.com', async () => {
  await withStubs(async () => {
    const stub = globalThis.fetch;
    const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
    globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('https://nano-gpt.com/')) {
        calls.push({
          url,
          auth: new Headers(init?.headers).get('Authorization'),
          body: JSON.parse(String(init?.body ?? '{}')),
        });
      }
      return stub(input);
    };
    const slot = 'nanogpt:qwen/q3:thinking';
    const response = await handleRequest(nanoGptPlan(await mintToken('user-nano-ok'), 'nk-author', {
      nanoGptEfforts: { [slot]: 'low' }, nanoGptMaxOutputs: { [slot]: 2000 },
    }));
    assertEquals(response.status, 200);
    await response.body?.cancel();
    assertEquals(calls.length, 1);
    assertEquals(calls[0].auth, 'Bearer nk-author');
    assertEquals(calls[0].body['model'], 'qwen/q3:thinking');
    assertEquals(calls[0].body['reasoning_effort'], 'low');
    assertEquals(calls[0].body['max_tokens'], 2000);
  });
});

Deno.test('nanoGptEfforts and nanoGptMaxOutputs are validated like veniceEfforts', async () => {
  await withStubs(async () => {
    for (const [extra, field] of [
      [{ nanoGptEfforts: { 'nanogpt:m': 'extreme' } }, 'nanoGptEfforts'],
      [{ nanoGptMaxOutputs: { 'nanogpt:m': -1 } }, 'nanoGptMaxOutputs'],
    ] as const) {
      const response = await handleRequest(nanoGptPlan(await mintToken(`user-nano-${field}`), 'nk', extra));
      assertEquals(response.status, 400, field);
      assertStringIncludes((await response.json() as ErrorBody).error, field);
    }
  });
});

// --- The one per-slot `reasoning` map (#1064 slice 3) ---------------------------------------

/** A `/plan` on `writing`, carrying every provider key header so any slot is accepted. */
function planOn(token: string, writing: string, extra: Record<string, unknown> = {}): Request {
  return new Request(`${SUPABASE_URL}/agentic-writer/plan`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`,
      'X-API-Key': 'sk-or-test', 'X-Venice-Key': 'vk-test', 'X-NanoGPT-Key': 'nk-test',
    },
    body: JSON.stringify({ ...COMMON, models: { writing }, ...extra }),
  });
}

/**
 * Run one `/plan` and return the body of the model call it made. Called inside `withStubs`,
 * whose stub answers the model call; this only records it on the way through.
 */
async function sentBody(token: string, writing: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const stub = globalThis.fetch;
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/chat/completions')) bodies.push(JSON.parse(String(init?.body ?? '{}')));
    return stub(input);
  };
  try {
    const response = await handleRequest(planOn(token, writing, extra));
    assertEquals(response.status, 200, await response.clone().text());
    await response.body?.cancel();
  } finally {
    globalThis.fetch = stub;
  }
  assertEquals(bodies.length, 1);
  return bodies[0];
}

Deno.test('an OpenRouter :reasoning slot is sent its real id, the reasoning object and an allowance sized to it', async () => {
  await withStubs(async () => {
    const slot = 'openrouter:anthropic/claude-sonnet-4:reasoning';
    const body = await sentBody(await mintToken('user-map-or'), slot, {
      reasoning: { [slot]: { model: 'anthropic/claude-sonnet-4', reasoning: { effort: 'high' }, allowanceRatio: 4 } },
    });
    assertEquals(body['model'], 'anthropic/claude-sonnet-4');
    assertEquals(body['reasoning'], { effort: 'high' });
    assertEquals(body['max_tokens'], 1500 + 6000); // plan's 1500, plus 4 × 1500 for an 80% share
  });
});

Deno.test('an OpenRouter :reasoning slot is held to the output ceiling its entry carries (#1068)', async () => {
  await withStubs(async () => {
    const slot = 'openrouter:anthropic/claude-sonnet-4:reasoning';
    const body = await sentBody(await mintToken('user-map-or-ceiling'), slot, {
      reasoning: { [slot]: { model: 'anthropic/claude-sonnet-4', reasoning: { effort: 'high' }, allowanceRatio: 4, maxOutput: 4096 } },
    });
    assertEquals(body['max_tokens'], 4096); // 1500 + 6000 would be 7500; the model can write 4096
  });
});

Deno.test('an OpenRouter slot without an entry is sent as named, with no reasoning and no allowance', async () => {
  await withStubs(async () => {
    const body = await sentBody(await mintToken('user-map-or-plain'), 'openrouter:anthropic/claude-sonnet-4', { reasoning: {} });
    assertEquals(body['model'], 'anthropic/claude-sonnet-4');
    assertEquals('reasoning' in body, false);
    assertEquals(body['max_tokens'], 1500);
  });
});

Deno.test('a Venice slot with no entry in the map sends no reasoning_effort at all (#921)', async () => {
  await withStubs(async () => {
    const body = await sentBody(await mintToken('user-map-venice-default'), 'venice:deepseek-v4-flash', { reasoning: {} });
    assertEquals('reasoning_effort' in body, false);
  });
});

Deno.test('a client that sends no map keeps the old behaviour: a Venice slot gets medium', async () => {
  await withStubs(async () => {
    const body = await sentBody(await mintToken('user-map-legacy'), 'venice:deepseek-v4-flash');
    assertEquals(body['reasoning_effort'], 'medium');
  });
});

Deno.test('the map wins over the old per-provider fields when a client sends both', async () => {
  await withStubs(async () => {
    const slot = 'venice:deepseek-v4-flash';
    const body = await sentBody(await mintToken('user-map-wins'), slot, {
      reasoning: { [slot]: { reasoningEffort: 'low' } }, veniceEfforts: { [slot]: 'high' },
    });
    assertEquals(body['reasoning_effort'], 'low');
  });
});

Deno.test('a NanoGPT slot takes its effort and its ceiling from the map', async () => {
  await withStubs(async () => {
    const slot = 'nanogpt:qwen/q3:thinking';
    const body = await sentBody(await mintToken('user-map-nano'), slot, {
      reasoning: { [slot]: { reasoningEffort: 'low', maxOutput: 2000 } },
    });
    assertEquals(body['model'], 'qwen/q3:thinking');
    assertEquals(body['reasoning_effort'], 'low');
    assertEquals(body['max_tokens'], 2000);
  });
});

Deno.test('an included reasoner slot\'s effort passes the map check (#1064 slice 4)', async () => {
  await withStubs(async () => {
    // Keyed by a slot not in `models`, as the 400 cases below are: the map is checked entry by
    // entry, so a run on another slot reaching its model call (`sentBody` asserts the 200) is
    // what says the entry was accepted. An Included run itself needs the budget context.
    await sentBody(await mintToken('user-map-included'), 'openrouter:x/y', {
      reasoning: { 'included:deepseek-reasoner': { reasoningEffort: 'high' } },
    });
  });
});

Deno.test('a map entry that does not fit its slot is a 400 naming reasoning, with no model call', async () => {
  await withStubs(async () => {
    const or = 'openrouter:x/y:reasoning';
    const ve = 'venice:m';
    for (const [label, writing, reasoning] of [
      ['not an object', or, 'high'],
      ['an entry that is not an object', or, { [or]: 'high' }],
      ['an unknown field', or, { [or]: { model: 'x/y', temperature: 2 } }],
      ['an unknown effort', ve, { [ve]: { reasoningEffort: 'extreme' } }],
      ['an OpenRouter field on a Venice slot', ve, { [ve]: { model: 'other/model' } }],
      ['a ceiling on a Venice slot', ve, { [ve]: { maxOutput: 2000 } }],
      ['a ceiling on an OpenRouter slot that is not a positive integer', or, { [or]: { maxOutput: -5 } }],
      ['an unknown OpenRouter effort', or, { [or]: { reasoning: { effort: 'extreme' } } }],
      ['an OpenRouter none', or, { [or]: { reasoning: { effort: 'none' } } }],
      ['a reasoning object with an unknown key', or, { [or]: { reasoning: { effort: 'high', budget: 9 } } }],
      ['a negative allowance ratio', or, { [or]: { allowanceRatio: -1 } }],
      ['an allowance ratio beyond the 95% share', or, { [or]: { allowanceRatio: 20 } }],
      ['an empty model id', or, { [or]: { model: '' } }],
      ['a ceiling that is not a positive integer', 'nanogpt:m', { 'nanogpt:m': { maxOutput: 1.5 } }],
      // Keyed by a slot not in `models`. An included slot takes an effort only (#1064 slice 4),
      // and only one of DeepSeek's three real levels, which the browser rounds to.
      ['a ceiling on an included slot', or, { 'included:deepseek-reasoner': { maxOutput: 2000 } }],
      ['a level DeepSeek does not take', or, { 'included:deepseek-reasoner': { reasoningEffort: 'medium' } }],
      ['a field on a provider that takes none', or, { 'ollama:llama3': { reasoningEffort: 'low' } }],
    ] as const) {
      const stub = globalThis.fetch;
      let modelCalls = 0;
      globalThis.fetch = (input: string | URL | Request) => {
        if (String(input).includes('/chat/completions')) modelCalls++;
        return stub(input);
      };
      try {
        // A user per case: the rate limiter keys on the token, and labels of one length collided.
        const response = await handleRequest(planOn(await mintToken(`user-map-bad-${label.replaceAll(' ', '-')}`), writing, { reasoning }));
        assertEquals(response.status, 400, label);
        assertStringIncludes((await response.json() as ErrorBody).error, 'reasoning', label);
        assertEquals(modelCalls, 0, label);
      } finally {
        globalThis.fetch = stub;
      }
    }
  });
});
