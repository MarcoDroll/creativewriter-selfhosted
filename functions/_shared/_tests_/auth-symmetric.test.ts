/**
 * Deno tests for the HS256 (self-hosted) branch of `extractAuthFromRequest` (auth.ts).
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/_shared/_tests_/auth-symmetric.test.ts
 *
 * These exist for one defect: the symmetric key used to be imported into a module-level
 * variable on first use and **never invalidated**, so on a self-hosted instance rotating
 * `JWT_SECRET` did nothing until the isolate cold-started. An operator rotating after a
 * suspected leak kept accepting tokens signed with the leaked secret, with nothing in the
 * logs to say so. The rotation test below fails against that version and passes now.
 *
 * It was visible in this very suite before anyone noticed it in production terms: two
 * stripe test files mint HS256 tokens with two different secrets in one process, and
 * `hosted-trust-gate.test.ts` carries a defensive `Deno.env.delete('SELF_HOSTED')` at
 * import time to keep out of the way of the other one.
 *
 * Every test restores the four env vars it touches, so nothing here depends on — or
 * disturbs — file order.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { SignJWT } from 'npm:jose@6';
import { extractAuthFromRequest } from '../auth.ts';

const SECRET_A = 'auth-symmetric-test-secret-A-min-32-chars';
const SECRET_B = 'auth-symmetric-test-secret-B-min-32-chars';
const HEADERS = { 'Content-Type': 'application/json' };

function signWith(secret: string, email = 'author@test.local'): Promise<string> {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience('authenticated')       // the only claim the symmetric branch checks
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));
}

function bearer(token: string): Request {
  return new Request('https://example.test/whatever', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
  });
}

/** Run `fn` on a self-hosted instance whose secret is `secret`, restoring the env after. */
async function withSelfHostedSecret(secret: string, fn: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const key of ['SELF_HOSTED', 'JWT_SECRET', 'SUPABASE_URL']) saved.set(key, Deno.env.get(key));
  Deno.env.set('SELF_HOSTED', 'true');
  Deno.env.set('JWT_SECRET', secret);
  Deno.env.set('SUPABASE_URL', 'http://auth-symmetric.test:54321');
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

Deno.test('a token signed with the configured secret authenticates', async () => {
  await withSelfHostedSecret(SECRET_A, async () => {
    const result = await extractAuthFromRequest(bearer(await signWith(SECRET_A)), HEADERS);
    assert(!(result instanceof Response), 'should have authenticated');
    assertEquals(result.userId, 'user-1');
    assertEquals(result.email, 'author@test.local');
  });
});

Deno.test('rotating JWT_SECRET takes effect immediately, without a cold start', async () => {
  // THE regression. The old module-level cache kept the first imported key forever, so the
  // second half of this test used to fail: a token signed with the NEW secret was rejected
  // by an isolate still holding the old one.
  await withSelfHostedSecret(SECRET_A, async () => {
    const before = await extractAuthFromRequest(bearer(await signWith(SECRET_A)), HEADERS);
    assert(!(before instanceof Response), 'the pre-rotation token should authenticate');
  });

  await withSelfHostedSecret(SECRET_B, async () => {
    const after = await extractAuthFromRequest(bearer(await signWith(SECRET_B)), HEADERS);
    assert(!(after instanceof Response), 'the post-rotation token should authenticate');
  });
});

Deno.test('a token signed with the OLD secret stops working after rotation', async () => {
  // The other half, and the actual point of rotating: the leaked secret must stop being
  // accepted. A cache that never invalidates fails this one in the opposite direction.
  await withSelfHostedSecret(SECRET_B, async () => {
    const result = await extractAuthFromRequest(bearer(await signWith(SECRET_A)), HEADERS);
    assert(result instanceof Response, 'a token signed with the old secret must be refused');
    assertEquals(result.status, 401);
    assertEquals((await result.json()).code, 'auth-required');
  });
});

Deno.test('a token with no email claim is refused', async () => {
  // `email` is required — `AuthResult.email` feeds Stripe customer lookup, so a token
  // without one must not become a half-populated identity.
  await withSelfHostedSecret(SECRET_A, async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience('authenticated')
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(SECRET_A));

    const result = await extractAuthFromRequest(bearer(token), HEADERS);
    assert(result instanceof Response);
    assertEquals(result.status, 401);
  });
});

Deno.test('an expired token is refused', async () => {
  // Pins the default `exp` check, not jose's implementation of it: nothing else here would
  // notice if a future `jwtVerify` call acquired a `clockTolerance` or `maxTokenAge` option.
  await withSelfHostedSecret(SECRET_A, async () => {
    const token = await new SignJWT({ email: 'author@test.local' })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience('authenticated')
      .setSubject('user-1')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(SECRET_A));

    const result = await extractAuthFromRequest(bearer(token), HEADERS);
    assert(result instanceof Response, 'an expired token must be refused');
    assertEquals(result.status, 401);
  });
});

Deno.test('a token for the wrong audience is refused', async () => {
  // `audience: 'authenticated'` is OUR choice — it is what separates a user token from
  // Supabase's own `anon`/`service_role` keys, which are HS256 JWTs signed with the SAME
  // secret. Drop the check and a leaked anon key would authenticate as a user.
  await withSelfHostedSecret(SECRET_A, async () => {
    const token = await new SignJWT({ email: 'author@test.local' })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience('anon')
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(SECRET_A));

    const result = await extractAuthFromRequest(bearer(token), HEADERS);
    assert(result instanceof Response, 'a non-authenticated audience must be refused');
    assertEquals(result.status, 401);
  });
});

Deno.test('a missing Authorization header is refused before any crypto runs', async () => {
  await withSelfHostedSecret(SECRET_A, async () => {
    const result = await extractAuthFromRequest(
      new Request('https://example.test/whatever', { method: 'POST' }),
      HEADERS,
    );
    assert(result instanceof Response);
    assertEquals(result.status, 401);
    assertEquals((await result.json()).code, 'auth-required');
  });
});
