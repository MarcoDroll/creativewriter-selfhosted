/**
 * Deno tests for the self-hosted premium lockdown.
 *
 * Run locally with:
 *   deno test --allow-env --allow-net supabase/functions/stripe/_tests_/self-hosted-lockdown.test.ts
 *
 * Run in CI via the "Test (Edge Functions / Deno)" step in ci.yml's
 * lint-and-test job. They exist as a regression guard for the contract that, on
 * self-hosted (SELF_HOSTED=true), `validateJwtAndGetSubscription` returns `tier: 'none'`
 * unless a valid license key is presented — regardless of whether
 * `subscription_cache` has matching rows or Stripe is configured.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { SignJWT } from 'npm:jose@6';

const JWT_SECRET = 'self-hosted-lockdown-test-secret-min-32-chars-x';
const ISSUER = 'https://test.example.com/auth/v1';
const SUPABASE_URL = 'https://test.example.com';

// Set env vars BEFORE importing stripe-helpers (module-level Stripe init reads env).
Deno.env.set('SELF_HOSTED', 'true');
Deno.env.set('JWT_SECRET', JWT_SECRET);
Deno.env.set('SUPABASE_URL', SUPABASE_URL);
Deno.env.set('SUPABASE_PUBLIC_URL', SUPABASE_URL);
// Intentionally NOT setting STRIPE_API_KEY — confirms self-hosted guard runs
// before the getStripe() call (which would otherwise return null on self-hosted
// without the key, then fall to `tier: 'none'` anyway via the no-stripe path).

const { validateJwtAndGetSubscription } = await import('../../_shared/stripe-helpers.ts');

async function makeUserJwt(opts: { sub: string; email: string }): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return await new SignJWT({ email: opts.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setSubject(opts.sub)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
}

function makeRequest(jwt: string, extraHeaders: Record<string, string> = {}): Request {
  return new Request('https://test.example.com/stripe/verify', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${jwt}`,
      ...extraHeaders,
    },
  });
}

Deno.test('self-hosted: no license key → tier: none even with valid JWT', async () => {
  const jwt = await makeUserJwt({ sub: 'user-1', email: 'alice@example.com' });
  const result = await validateJwtAndGetSubscription(makeRequest(jwt), {});

  if (result instanceof Response) {
    throw new Error(`Expected JwtValidationResult, got Response status ${result.status}`);
  }
  assertEquals(result.valid, false);
  assertEquals(result.tier, 'none');
  assertEquals(result.email, 'alice@example.com');
  assertEquals(result.userId, 'user-1');
  // No subData — confirms we did not reach the Stripe / subscription_cache code path.
  assertEquals(result.subData, undefined);
});

Deno.test('self-hosted: invalid license-key header → falls through to lockdown, tier: none', async () => {
  const jwt = await makeUserJwt({ sub: 'user-2', email: 'bob@example.com' });
  const result = await validateJwtAndGetSubscription(
    makeRequest(jwt, { 'X-License-Key': 'not-a-real-jwt' }),
    {},
  );

  if (result instanceof Response) {
    throw new Error(`Expected JwtValidationResult, got Response status ${result.status}`);
  }
  assertEquals(result.valid, false);
  assertEquals(result.tier, 'none');
  assertEquals(result.email, 'bob@example.com');
});

// Tests for the positive license-key paths (header and LICENSE_KEY env var)
// would require signing a JWT with the production Ed25519 private key, which is
// not available in this repo. They are exercised end-to-end by the verification
// steps in PR docs (manual paste of a real key on a self-hosted instance).
//
// Tests for `handleWebhook` and `handlePortal*` returning 410 on self-hosted are
// not included here because those route handlers are defined inside
// `Deno.serve(...)` in `index.ts` and are not exported. Importing index.ts
// starts the server. Exercising them currently requires either a small
// dispatcher refactor (export the request handler) or an integration test that
// makes HTTP calls against a running edge runtime. The plan covers these via
// the manual verification steps (forged webhook POST returns 410).
