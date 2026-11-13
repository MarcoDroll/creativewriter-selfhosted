/**
 * Deno tests for the hosted-trust gate keyed on secret possession.
 *
 * Run locally with:
 *   deno test --allow-env --allow-net supabase/functions/stripe/_tests_/hosted-trust-gate.test.ts
 *
 * Run in CI via the "Test (Edge Functions / Deno)" step in ci.yml's
 * lint-and-test job. These are the regression
 * guard for the vulnerability closed by keying the local-Postgres trust path on
 * whether this runtime actually holds the private LICENSE_SIGNING_KEY that
 * matches the embedded LICENSE_PUBLIC_KEY — instead of on the self-declared
 * `SELF_HOSTED` env flag, which an operator can simply omit or flip.
 *
 * Most cases drive the un-memoized `probeIsGenuineHostedInstance()` directly: it
 * re-reads LICENSE_SIGNING_KEY from env on every call and takes the public key
 * as a parameter, so each scenario can use a different key without fighting the
 * per-isolate memoization of `isGenuineHostedInstance()`. Exactly one end-to-end
 * case exercises the memoized public function through
 * `validateJwtAndGetSubscription()` (see the note on that test).
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { exportJWK, exportSPKI, generateKeyPair, importSPKI, SignJWT } from 'npm:jose@6';

// Neutralise any SELF_HOSTED leaked in by test-file ordering (env is
// process-global; self-hosted-lockdown.test.ts sets SELF_HOSTED='true' at
// module scope). The gate no longer reads it, but the end-to-end case below
// sets it explicitly when it needs HS256 auth.
Deno.env.delete('SELF_HOSTED');

const { LICENSE_PUBLIC_KEY } = await import('../../_shared/license-public-key.ts');
const { probeIsGenuineHostedInstance, validateJwtAndGetSubscription, resetHostedInstanceCacheForTests } =
  await import('../../_shared/stripe-helpers.ts');

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// --- Negative matrix: probe must be false for anything but the real key ---

Deno.test('probe: no LICENSE_SIGNING_KEY → false (fail closed, default-permissive path removed)', async () => {
  Deno.env.delete('LICENSE_SIGNING_KEY');
  assertEquals(await probeIsGenuineHostedInstance(), false);
});

Deno.test('probe: malformed LICENSE_SIGNING_KEY (garbage JSON) → false (fail closed)', async () => {
  Deno.env.set('LICENSE_SIGNING_KEY', '{not-valid-json');
  assertEquals(await probeIsGenuineHostedInstance(), false);
  Deno.env.delete('LICENSE_SIGNING_KEY');
});

Deno.test('probe: forged JWK — real public `x` copied from the repo, arbitrary `d` → false', async () => {
  // Simulates a self-hoster who reads the embedded public key out of their own
  // clone and hand-crafts a private JWK reusing its `x`. A shape-only or
  // `jwk.x === expectedX` check would pass here; the sign+verify round trip must
  // not, because `d` does not correspond to `x`.
  const realPublic = await importSPKI(LICENSE_PUBLIC_KEY, 'EdDSA', { extractable: true });
  const { x } = await exportJWK(realPublic); // real public component
  const randomD = new Uint8Array(32);
  crypto.getRandomValues(randomD);

  const forged = { kty: 'OKP', crv: 'Ed25519', x, d: b64url(randomD) };
  Deno.env.set('LICENSE_SIGNING_KEY', JSON.stringify(forged));
  assertEquals(await probeIsGenuineHostedInstance(), false);
  Deno.env.delete('LICENSE_SIGNING_KEY');
});

Deno.test('probe: unrelated self-generated Ed25519 keypair → false', async () => {
  // Simulates `generate-license-key.mjs --generate-keypair`: a valid, internally
  // consistent keypair that is simply not the real one.
  const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const privateJwk = await exportJWK(privateKey);
  Deno.env.set('LICENSE_SIGNING_KEY', JSON.stringify(privateJwk));
  assertEquals(await probeIsGenuineHostedInstance(), false); // checked vs the REAL embedded public key
  Deno.env.delete('LICENSE_SIGNING_KEY');
});

// --- Positive case: matching keypair → probe is true ---

Deno.test('probe: private key matching the injected public key → true', async () => {
  // The real LICENSE_PUBLIC_KEY's matching private key is not in this repo, so
  // reproduce the genuine relationship with a fresh test-only keypair and inject
  // its public half. Proves the positive path (round trip verifies) still works.
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const privateJwk = await exportJWK(privateKey);
  const publicPem = await exportSPKI(publicKey);

  Deno.env.set('LICENSE_SIGNING_KEY', JSON.stringify(privateJwk));
  assertEquals(await probeIsGenuineHostedInstance(publicPem), true);
  Deno.env.delete('LICENSE_SIGNING_KEY');
});

// --- End-to-end: the integrated early-return fires (memoized public path) ---

const JWT_SECRET = 'hosted-trust-gate-test-secret-min-32-chars-xx';
const ISSUER = 'https://test.example.com/auth/v1';
const SUPABASE_URL = 'https://test.example.com';

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

Deno.test('validateJwtAndGetSubscription: no matching signing key → tier none, DB path never reached', async () => {
  // This is the literal regression proof for the closed vulnerability: even if a
  // tampered `subscription_cache` row granted this user premium, it is never
  // consulted — the gate returns before getStripe()/getSubscriptionCache().
  // `subData === undefined` demonstrates the local-DB trust path was skipped.
  //
  // SELF_HOSTED='true' + JWT_SECRET here only makes GoTrue-style HS256 auth pass
  // OFFLINE (auth.ts selects HS256 vs JWKS on that flag). It does NOT drive the
  // trust decision — the negative-matrix tests above prove the gate is keyed on
  // key possession, not on SELF_HOSTED. LICENSE_SIGNING_KEY is deliberately
  // absent, so isGenuineHostedInstance() resolves false and the fixed gate
  // returns tier: 'none'. Reset the memoized caches first so this is
  // deterministic regardless of test/file ordering (the probe tests above use
  // the un-memoized probe, but be defensive).
  resetHostedInstanceCacheForTests();
  Deno.env.delete('LICENSE_SIGNING_KEY');
  Deno.env.set('SELF_HOSTED', 'true');
  Deno.env.set('JWT_SECRET', JWT_SECRET);
  Deno.env.set('SUPABASE_URL', SUPABASE_URL);
  Deno.env.set('SUPABASE_PUBLIC_URL', SUPABASE_URL);

  const jwt = await makeUserJwt({ sub: 'user-1', email: 'attacker@example.com' });
  const request = new Request('https://test.example.com/stripe/verify', {
    method: 'GET',
    headers: { Authorization: `Bearer ${jwt}` },
  });

  const result = await validateJwtAndGetSubscription(request, {});
  if (result instanceof Response) {
    throw new Error(`Expected JwtValidationResult, got Response status ${result.status}`);
  }
  assertEquals(result.valid, false);
  assertEquals(result.tier, 'none');
  assertEquals(result.email, 'attacker@example.com');
  assertEquals(result.userId, 'user-1');
  assertEquals(result.subData, undefined); // proves the DB trust path was never entered
});
