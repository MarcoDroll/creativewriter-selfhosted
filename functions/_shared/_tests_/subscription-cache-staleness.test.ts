/**
 * Deno tests for the `subscription_cache` staleness rule.
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/_shared/_tests_/subscription-cache-staleness.test.ts
 *
 * Run in CI via the "Test (Edge Functions / Deno)" step in ci.yml's lint-and-test
 * job (which globs `supabase/functions/`).
 *
 * Context: validateJwtAndGetSubscription() used to call Stripe only on a cache MISS.
 * A row with `status: 'none'` is a perfectly valid cache HIT, so once such a
 * placeholder existed the function answered `tier: 'none'` forever — nothing but a
 * webhook write could repair it, and the frontend "Refresh status" button only
 * clears its own client-side dedup. That is exactly the 2026-07-23 orphan incident:
 * a `none` row written five minutes before a successful payment, plus three skipped
 * webhooks, left a paying user permanently unentitled.
 *
 * The first fix re-checks Stripe when a NON-ENTITLING cached row is older than a
 * 5-minute TTL, while trusting 'active'/'trialing' rows on the fast path. Both
 * halves are load-bearing and are guarded here:
 *   - stale non-entitling → re-check, so a missed webhook degrades to a ≤5-minute
 *     delay instead of a permanent paid-with-no-entitlement state;
 *   - fresh non-entitling → NO re-check, which is what keeps this off the hot path
 *     (validateJwtAndGetSubscription also runs on every premium character-chat /
 *     beat-rewrite / portrait call).
 *
 * The second fix closes the mirror leak (revenue *leaking*, not losing): an
 * entitling row is no longer trusted unconditionally. It stays on the fast path
 * only while its `current_period_end` is current; once that is more than a 1-hour
 * grace in the past it goes stale and is re-checked, because Stripe pushes
 * `current_period_end` forward on every renewal so a healthy sub never enters that
 * window — an expired entitling row is the exact fingerprint of a missed webhook
 * (a missed cancellation being the leak). The two invariants that pull in opposite
 * directions are both guarded below:
 *   - entitling with a FUTURE (or within-grace) period end → NO re-check, so healthy
 *     paying users still make zero Stripe calls per request;
 *   - entitling more than the grace past `current_period_end` → re-check, so a
 *     missed cancellation self-heals to non-entitling on next access.
 * `current_period_end` is epoch SECONDS (BIGINT column / raw Stripe), while
 * `cachedAt` is epoch MILLISECONDS — the tests pass seconds accordingly.
 *
 * The end-to-end flow is not unit-tested here for the reason the sibling
 * app-trial-premium.test.ts documents: reaching it requires isGenuineHostedInstance()
 * to be true, which needs the private LICENSE_SIGNING_KEY deliberately absent from
 * this repo. isSubscriptionCacheStale/parseCachedAt are therefore exported as pure
 * functions precisely so the decision itself is testable.
 */

import { assert, assertEquals, assertFalse } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { isSubscriptionCacheStale, parseCachedAt } from '../stripe-helpers.ts';

const NOW = Date.parse('2026-07-23T12:00:00.000+00:00');
const TTL_MS = 5 * 60 * 1000;
const GRACE_MS = 60 * 60 * 1000;
const minutesAgo = (n: number) => NOW - n * 60 * 1000;

// `current_period_end` is stored/consumed as epoch SECONDS. These helpers build a
// seconds-since-epoch value relative to NOW so the tests read in the same units.
const nowSec = Math.floor(NOW / 1000);
const periodEndInMinutes = (n: number) => nowSec + n * 60;
const periodEndMinutesAgo = (n: number) => nowSec - n * 60;
// A far-future period end: a healthy sub whose renewal webhook keeps moving it forward.
const FUTURE_PERIOD_END = periodEndInMinutes(60 * 24 * 30);

Deno.test('entitling statuses with a current period end are never stale, at any cachedAt age', () => {
  for (const status of ['active', 'trialing']) {
    assertFalse(isSubscriptionCacheStale(status, minutesAgo(0), FUTURE_PERIOD_END, NOW), `${status} fresh`);
    assertFalse(isSubscriptionCacheStale(status, minutesAgo(60), FUTURE_PERIOD_END, NOW), `${status} 1h old`);
    assertFalse(isSubscriptionCacheStale(status, minutesAgo(60 * 24 * 365), FUTURE_PERIOD_END, NOW), `${status} 1y old`);
  }
});

Deno.test('entitling statuses with a current period end are not stale even without a cachedAt', () => {
  // Paying users keep the zero-Stripe-call fast path regardless of column state.
  assertFalse(isSubscriptionCacheStale('active', undefined, FUTURE_PERIOD_END, NOW));
  assertFalse(isSubscriptionCacheStale('trialing', undefined, FUTURE_PERIOD_END, NOW));
});

Deno.test('an entitling row whose current_period_end has passed the grace is stale (missed-webhook fingerprint)', () => {
  // > 1h past period end: a renewal or cancellation webhook was missed.
  assert(isSubscriptionCacheStale('active', minutesAgo(0), periodEndMinutesAgo(61), NOW));
  assert(isSubscriptionCacheStale('active', minutesAgo(0), periodEndMinutesAgo(60 * 24), NOW));
  // The trial-end fingerprint behaves identically.
  assert(isSubscriptionCacheStale('trialing', minutesAgo(0), periodEndMinutesAgo(61), NOW), 'trialing past grace');
});

Deno.test('an entitling row within the grace of its period end is not stale (renewal jitter must not re-check)', () => {
  assertFalse(isSubscriptionCacheStale('active', minutesAgo(0), periodEndMinutesAgo(30), NOW));
  assertFalse(isSubscriptionCacheStale('active', minutesAgo(0), periodEndMinutesAgo(59), NOW));
  // Just before the period even ends is obviously still fast-path.
  assertFalse(isSubscriptionCacheStale('active', minutesAgo(0), periodEndInMinutes(5), NOW));
});

Deno.test('the entitling-expiry grace boundary is inclusive: exactly grace past period end is stale', () => {
  const atGrace = Math.floor((NOW - GRACE_MS) / 1000); // period end whose grace elapses exactly at NOW
  assert(isSubscriptionCacheStale('active', minutesAgo(0), atGrace, NOW), 'exactly grace → stale');
  assertFalse(isSubscriptionCacheStale('active', minutesAgo(0), atGrace + 1, NOW), 'one second inside grace → not stale');
  assert(isSubscriptionCacheStale('active', minutesAgo(0), atGrace - 1, NOW), 'one second past grace → stale');
});

Deno.test('an entitling row with a malformed (0 / negative) period end keeps trust-indefinitely', () => {
  // No regression: such a row shouldn't exist for a real active sub, and we must
  // not lock anyone out over a bad column value.
  assertFalse(isSubscriptionCacheStale('active', minutesAgo(60 * 24 * 365), 0, NOW));
  assertFalse(isSubscriptionCacheStale('active', minutesAgo(0), undefined, NOW));
  assertFalse(isSubscriptionCacheStale('trialing', minutesAgo(0), -1, NOW));
});

Deno.test('a fresh non-entitling row is not stale (the hot-path rate limiter)', () => {
  assertFalse(isSubscriptionCacheStale('none', minutesAgo(0), 0, NOW));
  assertFalse(isSubscriptionCacheStale('none', minutesAgo(4), 0, NOW));
  assertFalse(isSubscriptionCacheStale('canceled', minutesAgo(1), 0, NOW));
});

Deno.test('a `none` row older than the TTL is stale (the 2026-07-23 incident case)', () => {
  assert(isSubscriptionCacheStale('none', minutesAgo(6), 0, NOW));
  assert(isSubscriptionCacheStale('none', minutesAgo(60 * 24), 0, NOW));
});

Deno.test('every other non-entitling status goes stale after the TTL', () => {
  for (const status of ['canceled', 'past_due', 'incomplete', 'incomplete_expired', 'unpaid', 'paused']) {
    assert(isSubscriptionCacheStale(status, minutesAgo(6), 0, NOW), `${status} should be stale`);
  }
});

Deno.test('non-entitling staleness ignores current_period_end (only cachedAt governs)', () => {
  // A past or future period end on a non-entitling row must not change the TTL verdict.
  assertFalse(isSubscriptionCacheStale('none', minutesAgo(1), periodEndMinutesAgo(60 * 24), NOW), 'fresh + past cpe');
  assert(isSubscriptionCacheStale('none', minutesAgo(6), FUTURE_PERIOD_END, NOW), 'stale + future cpe');
});

Deno.test('a missing or unparseable cachedAt is stale (fail toward correctness)', () => {
  assert(isSubscriptionCacheStale('none', undefined, 0, NOW));
  assert(isSubscriptionCacheStale('past_due', parseCachedAt(null), 0, NOW));
  assert(isSubscriptionCacheStale('none', parseCachedAt('not-a-timestamp'), 0, NOW));
});

Deno.test('the TTL boundary is inclusive: exactly TTL old is stale', () => {
  assertFalse(isSubscriptionCacheStale('none', NOW - TTL_MS + 1, 0, NOW));
  assert(isSubscriptionCacheStale('none', NOW - TTL_MS, 0, NOW));
  assert(isSubscriptionCacheStale('none', NOW - TTL_MS - 1, 0, NOW));
});

Deno.test('a cachedAt in the future is not stale (clock skew must not thrash Stripe)', () => {
  assertFalse(isSubscriptionCacheStale('none', NOW + 60 * 1000, 0, NOW));
});

Deno.test('parseCachedAt handles the real PostgREST TIMESTAMPTZ shape', () => {
  // 6-digit fractional seconds + explicit offset, as returned by PostgREST.
  assertEquals(
    parseCachedAt('2026-07-23T10:18:26.123456+00:00'),
    Date.parse('2026-07-23T10:18:26.123Z'),
  );
  // Non-UTC offsets must normalise to the same instant.
  assertEquals(
    parseCachedAt('2026-07-23T12:18:26.000000+02:00'),
    Date.parse('2026-07-23T10:18:26.000Z'),
  );
});

Deno.test('parseCachedAt returns undefined for absent or garbage values', () => {
  assertEquals(parseCachedAt(null), undefined);
  assertEquals(parseCachedAt(undefined), undefined);
  assertEquals(parseCachedAt(''), undefined);
  assertEquals(parseCachedAt('not-a-timestamp'), undefined);
});
