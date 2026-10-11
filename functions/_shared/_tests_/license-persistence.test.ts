/**
 * Deno tests for `persistSelfHostedLicenseValidation` (#187).
 *
 * Run locally with:
 *   deno test --allow-env --allow-net supabase/functions/_shared/_tests_/license-persistence.test.ts
 *
 * `validateJwtAndGetSubscription`'s own positive-license-key path cannot be exercised
 * end-to-end here for the same reason `self-hosted-lockdown.test.ts` already documents:
 * it needs a real license JWT signed with the production Ed25519 LICENSE_SIGNING_KEY,
 * which is not available in this repo. This file tests the persistence function
 * directly instead — the piece that is new here — with `globalThis.fetch` stubbed the
 * same way `agentic-writer`'s request-auth tests stub the Supabase client's own network
 * calls, since `supabase-js` reads `fetch` off `globalThis` per call.
 */

import { assertEquals, assertExists } from 'https://deno.land/std@0.224.0/assert/mod.ts';

const SUPABASE_URL = 'https://test.example.com';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Stubs env + fetch, records every call the function under test makes, restores both after. */
async function withStubs(fn: (calls: { url: string; init?: RequestInit }[]) => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
    saved.set(key, Deno.env.get(key));
  }
  Deno.env.set('SUPABASE_URL', SUPABASE_URL);
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role-key');

  const calls: { url: string; init?: RequestInit }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    return Promise.resolve(json([{}]));
  };

  try {
    await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

const { persistSelfHostedLicenseValidation } = await import('../license.ts');

Deno.test('does not touch the network for a non-premium tier', async () => {
  await withStubs(async calls => {
    await persistSelfHostedLicenseValidation('user-1', 'basic', Math.floor(Date.now() / 1000) + 3600);
    assertEquals(calls.length, 0);
  });
});

Deno.test('does not touch the network with no expiry', async () => {
  await withStubs(async calls => {
    await persistSelfHostedLicenseValidation('user-1', 'premium', undefined);
    assertEquals(calls.length, 0);
  });
});

Deno.test('upserts the row for a premium tier with an expiry', async () => {
  await withStubs(async calls => {
    const expUnixSeconds = Math.floor(Date.now() / 1000) + 3600;
    await persistSelfHostedLicenseValidation('user-42', 'premium', expUnixSeconds);

    assertEquals(calls.length, 1);
    const [{ url, init }] = calls;
    // The table name and the upsert's on-conflict target are both visible on the wire —
    // this is what proves the call reached cw_license_validations keyed by user_id,
    // not just that SOME request happened.
    assertEquals(url.includes('/rest/v1/cw_license_validations'), true);
    assertEquals(url.includes('on_conflict=user_id'), true);

    assertExists(init?.body);
    const body = JSON.parse(init!.body as string);
    assertEquals(body.user_id, 'user-42');
    assertEquals(body.tier, 'premium');
    // Converted from Unix seconds to an ISO timestamp Postgres can store as timestamptz —
    // the arithmetic this test exists to pin (a bug here would silently store a
    // millisecond-scale value 1000x too far in the future, or NaN).
    assertEquals(body.expires_at, new Date(expUnixSeconds * 1000).toISOString());
    assertExists(body.validated_at);
  });
});
