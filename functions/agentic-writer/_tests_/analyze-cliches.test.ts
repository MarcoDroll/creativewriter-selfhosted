/**
 * Deno tests for the `/analyze-cliches` route (`agentic-writer/router.ts`).
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/agentic-writer/_tests_/analyze-cliches.test.ts
 *
 * The last uncovered route in this function, and the reason is a fact about the TEST, not
 * about the route's security model. **In production every phase endpoint is authenticated
 * exactly the same way** — `handleRequest` runs `extractAuthFromRequest` before it
 * dispatches to any of them. But the five phase handlers were extracted into exported
 * functions, so `phase-handlers.test.ts` calls them directly and never passes through that
 * check. `/analyze-cliches` is handled inline in the router, so there is nothing to call
 * below the auth gate: the way in is to sign a real token.
 *
 * That makes this the only file here exercising `extractAuthFromRequest` at all, which is
 * worth having for its own sake — but do not read it as "this route is the protected one".
 *
 * **Why JWKS and not HS256, which would be three lines shorter.** This file exercises the
 * route in a *hosted* env — `withStubs` deletes `SELF_HOSTED` — and `verifySupabaseJwt`
 * takes the symmetric branch only when `SELF_HOSTED=true` **and** `JWT_SECRET` is set. So
 * on the shape being tested here JWKS is not a preference, it is the branch. The odd
 * hostname below is still load-bearing for a second reason: the JWKS cache is keyed per
 * URL (`cachedJWKSUrl`), so a distinctive `SUPABASE_URL` gets a fresh entry no matter who
 * ran first in the shared process — and re-creates another file's entry if it runs after,
 * which is self-healing.
 *
 * This note used to give a different reason: that `getSymmetricKey` cached the imported key
 * in a module-level variable, so "the first secret used in the process wins forever", making
 * HS256 a bet on file order. **That cache no longer exists** — `de2a31d7` deleted it,
 * because it made rotating `JWT_SECRET` a no-op until the isolate cold-started;
 * `_shared/auth.ts` documents why there is deliberately none, and
 * `_shared/_tests_/auth-symmetric.test.ts` pins it. A test wanting the symmetric branch may
 * now take it freely, and `local-provider-config.test.ts` does.
 *
 * The JWKS document itself is served by the same `fetch` stub that serves PostgREST and
 * the model, which is the point: one seam, three upstreams.
 */

import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { exportJWK, generateKeyPair, SignJWT } from 'npm:jose@6';
import { handleRequest } from '../router.ts';

/** Unique per test file — see the JWKS note above. */
const SUPABASE_URL = 'http://agentic-analyze-cliches.test:54321';
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const KID = 'analyze-cliches-test-key';

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
 * the Authorization header, and this route allows only 5 requests a minute, so reusing one
 * token across the file would start answering 429 partway down.
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

function analyzeRequest(token: string | null, body: Record<string, unknown>): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-API-Key': 'sk-or-test' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return new Request(`${SUPABASE_URL}/agentic-writer/analyze-cliches`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** One scene, so `analyzeCliches` does not short-circuit on "no content" before the model. */
const SCENES = [{ id: 'scene-1', content: '<p>Her heart pounded as shadows danced.</p>' }];

interface ClichePhraseRow { phrase: string; category: string; description: string | null }

interface StubOptions {
  /** Rows `cliche_phrases` answers with. Empty means the text-match pass finds nothing. */
  clichePhrases?: ClichePhraseRow[];
  /** `stories.settings.language`, which decides the analyzer prompt's language line. */
  language?: string;
}

/** The body of the last request that reached the *model*, for asserting what we sent it. */
let lastModelRequest: { messages?: { role: string; content: string }[] } | null = null;

/**
 * Serve all three upstreams off one stub, routed by URL: the JWKS document, PostgREST,
 * and the model. `model` is a thunk so a test can throw instead of answering.
 */
async function withStubs(
  model: () => Response,
  fn: () => Promise<void>,
  opts: StubOptions = {},
): Promise<void> {
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

  lastModelRequest = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/.well-known/jwks.json')) return Promise.resolve(json({ keys: [PUBLIC_JWK] }));
    // `.single()` wants an object; every other read is a list.
    if (url.includes('/rest/v1/stories')) {
      return Promise.resolve(json({ settings: { language: opts.language ?? 'en' } }));
    }
    if (url.includes('/rest/v1/scenes')) return Promise.resolve(json(SCENES));
    if (url.includes('/rest/v1/cliche_phrases')) return Promise.resolve(json(opts.clichePhrases ?? []));
    if (url.includes('/rest/v1/rpc/')) return Promise.resolve(json(null));
    if (url.includes('/rest/v1/')) return Promise.resolve(json([]));
    lastModelRequest = init?.body ? JSON.parse(String(init.body)) : null;
    try {
      return Promise.resolve(model());
    } catch (err) {
      return Promise.reject(err);
    }
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

/** A completion whose content is the JSON array the analyzer expects. */
const modelFound = (phrases: string[]) => () => json({
  choices: [{ message: { content: JSON.stringify(phrases.map(p => ({ phrase: p, category: 'repetition' }))) } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

const upstream = (status: number, body: string) => () => new Response(body, { status });
const abortError = () => new DOMException('The signal has been aborted', 'AbortError');

interface ErrorBody { error: string; code?: string }

Deno.test('/analyze-cliches refuses an unsigned request', async () => {
  await withStubs(modelFound([]), async () => {
    const response = await handleRequest(analyzeRequest(null, { storyId: 's1', model: 'openrouter:m' }));
    assertEquals(response.status, 401);
    assertEquals(((await response.json()) as ErrorBody).code, 'auth-required');
  });
});

Deno.test('/analyze-cliches refuses a token it cannot verify', async () => {
  // Well-formed enough to slice, wrong enough to fail the signature check. The router runs
  // this same gate for the phase endpoints too — this is simply the only place a test
  // reaches it, because every other test enters below it.
  await withStubs(modelFound([]), async () => {
    const response = await handleRequest(
      analyzeRequest('not.a.jwt', { storyId: 's1', model: 'openrouter:m' }),
    );
    assertEquals(response.status, 401);
    assertEquals(((await response.json()) as ErrorBody).code, 'auth-required');
  });
});

Deno.test('/analyze-cliches refuses a token signed with the wrong key', async () => {
  // The realistic "cannot verify" case, and a stronger claim than the one above: this
  // token parses, names a `kid` the JWKS document does advertise, and still fails —
  // so the gate is doing crypto, not just decoding.
  await withStubs(modelFound([]), async () => {
    const forged = await mintToken('user-forged', foreignKey);
    const response = await handleRequest(analyzeRequest(forged, { storyId: 's1', model: 'openrouter:m' }));
    assertEquals(response.status, 401);
    assertEquals(((await response.json()) as ErrorBody).code, 'auth-required');
  });
});

Deno.test('/analyze-cliches completes with a signed token', async () => {
  // The one that proves the other cases fail where they claim to: without a success path,
  // a 502 could just as well be something upstream of the model call.
  await withStubs(modelFound(['heart pounded', 'shadows danced']), async () => {
    const response = await handleRequest(
      analyzeRequest(await mintToken('user-ok'), { storyId: 's1', model: 'openrouter:m' }),
    );
    assertEquals(response.status, 200);
    const body = await response.json() as { success: boolean; count: number; categories: number };
    assertEquals(body.success, true);
    assertEquals(body.count, 2);
    assertEquals(body.categories, 1);
  });
});

Deno.test('/analyze-cliches counts text matches too, and they outrank the LLM duplicate', async () => {
  // The other half of the analyzer, which the LLM-only case above cannot see:
  // `textMatchCliches` scans the scene text for the global phrase list, and `mergeResults`
  // keeps the text-match entry when the model names the same phrase. Observable in the
  // response because the two entries then carry two different categories.
  await withStubs(modelFound(['heart pounded', 'shadows danced']), async () => {
    const response = await handleRequest(
      analyzeRequest(await mintToken('user-textmatch'), { storyId: 's1', model: 'openrouter:m' }),
    );
    assertEquals(response.status, 200);
    const body = await response.json() as { count: number; categories: number };
    assertEquals(body.count, 2);
    // 'heart pounded' kept its text-match category; only 'shadows danced' is the LLM's.
    assertEquals(body.categories, 2);
  }, {
    clichePhrases: [{ phrase: 'heart pounded', category: 'emotion_telling', description: null }],
  });
});

Deno.test('/analyze-cliches builds the prompt from the story row it actually read', async () => {
  // Guards the `stories` read itself: `language` falls back to 'en' whenever the row is
  // missing or unparsed, so an 'en' assertion could not tell the two apart. A German story
  // must produce a German instruction.
  await withStubs(modelFound([]), async () => {
    await handleRequest(
      analyzeRequest(await mintToken('user-de'), { storyId: 's1', model: 'openrouter:m' }),
    );
    const system = lastModelRequest?.messages?.[0]?.content ?? '';
    assertStringIncludes(system, 'German');
  }, { language: 'de' });
});

Deno.test('/analyze-cliches relays a rejected key as 502 + api-key-invalid', async () => {
  // The `UpstreamError` arm added to this catch — the only place it is exercised.
  await withStubs(upstream(401, 'invalid api key'), async () => {
    const response = await handleRequest(
      analyzeRequest(await mintToken('user-401'), { storyId: 's1', model: 'openrouter:m' }),
    );
    assertEquals(response.status, 502);
    const body = await response.json() as ErrorBody;
    assertEquals(body.code, 'api-key-invalid');
    assertStringIncludes(body.error, 'Analyzer model error (401)');
  });
});

Deno.test('/analyze-cliches answers 504 + provider-timeout, not 500', async () => {
  await withStubs(() => { throw abortError(); }, async () => {
    const response = await handleRequest(
      analyzeRequest(await mintToken('user-timeout'), { storyId: 's1', model: 'openrouter:m' }),
    );
    assertEquals(response.status, 504);
    assertEquals(((await response.json()) as ErrorBody).code, 'provider-timeout');
  });
});

Deno.test('/analyze-cliches still validates its body after authenticating', async () => {
  // Auth first, then the request checks — and these stay uncoded, because "model is
  // required" names the field and no translated generic sentence improves on it.
  await withStubs(modelFound([]), async () => {
    const response = await handleRequest(
      analyzeRequest(await mintToken('user-nomodel'), { storyId: 's1' }),
    );
    assertEquals(response.status, 400);
    const body = await response.json() as ErrorBody;
    assertEquals(body.error, 'model is required');
    assertEquals(body.code, undefined);
  });
});
