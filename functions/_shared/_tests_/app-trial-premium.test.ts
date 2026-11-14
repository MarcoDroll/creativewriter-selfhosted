/**
 * Deno tests for the issue #35 "Premium Trial" invariant.
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/_shared/_tests_/app-trial-premium.test.ts
 *
 * Run in CI via the "Test (Edge Functions / Deno)" step in ci.yml's lint-and-test
 * job (which globs `supabase/functions/`).
 *
 * Context: the app-trial grant was flipped from `tier: 'basic'` to `tier: 'premium'`
 * (checkAppTrialEligibility in stripe-helpers.ts) so trial users get full Premium
 * features during their 7-day window. The load-bearing safety claim is that this
 * flip adds NO net-new CreativeWriter cost, because the included-AI budget cap is
 * keyed on `subData.status` ('app_trial' → $0.50/month), NOT on `tier`. This file
 * guards that invariant so a future refactor of resolveIncludedAiTier that starts
 * keying off `tier` (which would silently promote trials to the $5 premium cap)
 * fails CI.
 *
 * The end-to-end trial grant itself (validateJwtAndGetSubscription returning
 * tier: 'premium', and /stripe/license-key still 403-ing an app_trial user) is not
 * unit-tested here for the same reason the sibling stripe/_tests_ files document:
 * reaching the trial branch requires isGenuineHostedInstance() to be true, which
 * needs the private LICENSE_SIGNING_KEY that matches the embedded public key — that
 * key is deliberately absent from this repo. The license-key 403 is preserved
 * structurally: the flip kept `status: 'app_trial'` unchanged, and both the mint
 * block (stripe/index.ts) and the cap below key on that status, not the tier.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { resolveIncludedAiTier } from '../ai-usage.ts';
import type { JwtValidationResult } from '../types.ts';

Deno.test('resolveIncludedAiTier: premium-tier app_trial still resolves to the $0.50 app_trial cap', () => {
  // This is the exact post-flip shape returned by checkAppTrialEligibility.
  const trial: JwtValidationResult = {
    valid: true,
    tier: 'premium',
    subData: { status: 'app_trial', currentPeriodEnd: 0, cancelAtPeriodEnd: false, tier: 'premium' },
  };
  assertEquals(resolveIncludedAiTier(trial), 'app_trial');
});

Deno.test('resolveIncludedAiTier: real premium subscription resolves to the premium cap', () => {
  const paid: JwtValidationResult = {
    valid: true,
    tier: 'premium',
    subData: { status: 'active', currentPeriodEnd: 0, cancelAtPeriodEnd: false, tier: 'premium' },
  };
  assertEquals(resolveIncludedAiTier(paid), 'premium');
});

Deno.test('resolveIncludedAiTier: real basic subscription resolves to the basic cap', () => {
  const basic: JwtValidationResult = {
    valid: true,
    tier: 'basic',
    subData: { status: 'active', currentPeriodEnd: 0, cancelAtPeriodEnd: false, tier: 'basic' },
  };
  assertEquals(resolveIncludedAiTier(basic), 'basic');
});

Deno.test('resolveIncludedAiTier: invalid validation yields no included-AI allowance', () => {
  const none: JwtValidationResult = { valid: false, tier: 'none' };
  assertEquals(resolveIncludedAiTier(none), null);
});

Deno.test('resolveIncludedAiTier: tier none never gets an included-AI cap', () => {
  const none: JwtValidationResult = {
    valid: true,
    tier: 'none',
    subData: { status: 'active', currentPeriodEnd: 0, cancelAtPeriodEnd: false, tier: 'none' },
  };
  assertEquals(resolveIncludedAiTier(none), null);
});
