/**
 * Deno tests for the public prices endpoint's unit-testable seam,
 * `getConfiguredPriceIds()`.
 *
 * Run locally with:
 *   deno test --allow-env --allow-net supabase/functions/stripe/_tests_/prices.test.ts
 *
 * Run in CI via the "Test (Edge Functions / Deno)" step in ci.yml's
 * lint-and-test job. The frontend graceful-degradation safety net is
 * `pricing.service.spec.ts` (runs under `npm test`). These tests guard that
 * `getConfiguredPriceIds()` maps the
 * 4 STRIPE_*_PRICE_ID_* env vars correctly and skips any that are unset —
 * `getConfiguredPriceIds` reads env at call time, so mutating between steps is
 * safe (the module is imported once).
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

const PRICE_ENV_KEYS = [
  'STRIPE_BASIC_PRICE_ID_MONTHLY',
  'STRIPE_BASIC_PRICE_ID_YEARLY',
  'STRIPE_PREMIUM_PRICE_ID_MONTHLY',
  'STRIPE_PREMIUM_PRICE_ID_YEARLY',
];

function clearPriceEnv(): void {
  for (const key of PRICE_ENV_KEYS) Deno.env.delete(key);
}

const { getConfiguredPriceIds } = await import('../../_shared/stripe-helpers.ts');

Deno.test('getConfiguredPriceIds: all 4 set → 4 correctly mapped entries', () => {
  clearPriceEnv();
  Deno.env.set('STRIPE_BASIC_PRICE_ID_MONTHLY', 'price_basic_m');
  Deno.env.set('STRIPE_BASIC_PRICE_ID_YEARLY', 'price_basic_y');
  Deno.env.set('STRIPE_PREMIUM_PRICE_ID_MONTHLY', 'price_prem_m');
  Deno.env.set('STRIPE_PREMIUM_PRICE_ID_YEARLY', 'price_prem_y');

  assertEquals(getConfiguredPriceIds(), [
    { tier: 'basic', cycle: 'monthly', priceId: 'price_basic_m' },
    { tier: 'basic', cycle: 'yearly', priceId: 'price_basic_y' },
    { tier: 'premium', cycle: 'monthly', priceId: 'price_prem_m' },
    { tier: 'premium', cycle: 'yearly', priceId: 'price_prem_y' },
  ]);
});

Deno.test('getConfiguredPriceIds: unset vars are skipped', () => {
  clearPriceEnv();
  Deno.env.set('STRIPE_BASIC_PRICE_ID_MONTHLY', 'price_basic_m');
  Deno.env.set('STRIPE_PREMIUM_PRICE_ID_YEARLY', 'price_prem_y');

  assertEquals(getConfiguredPriceIds(), [
    { tier: 'basic', cycle: 'monthly', priceId: 'price_basic_m' },
    { tier: 'premium', cycle: 'yearly', priceId: 'price_prem_y' },
  ]);
});

Deno.test('getConfiguredPriceIds: no vars set → empty array', () => {
  clearPriceEnv();
  assertEquals(getConfiguredPriceIds(), []);
});
