/**
 * Deno tests for the rules that decide which Stripe customer and which
 * subscription speak for a user (public#65 / hosted#697).
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/_shared/_tests_/customer-mapping-decision.test.ts
 *
 * The incident: a renewal declined, the subscription went past_due and the author
 * was locked out. They bought again through the Pricing Table, which made a second
 * Stripe customer, and the mapping moved to it. Each dunning retry on the FIRST
 * customer then arrived as a webhook for an unmapped customer, was resolved to the
 * same user by email, and moved the mapping back, locking them out again. Four
 * lockouts and three extra subscriptions in a week.
 *
 * The webhook handler itself is not reachable from a unit test (it needs Stripe's
 * signature and the admin client), so the decisions are pure functions and are
 * pinned here instead.
 */

import { assertEquals, assert, assertFalse } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  canOpenBillingPortal,
  decideCustomerMapping,
  isEntitlingStatus,
  pickSubscription,
} from '../stripe-helpers.ts';

const OLD = 'cus_old';
const NEW = 'cus_new';

Deno.test('a dunning retry on an old customer never takes over a user entitled through a newer one', () => {
  // The exact event of the incident: invoice.payment_failed for the past_due
  // customer while the mapping names the freshly bought active one.
  assertEquals(decideCustomerMapping({
    isCheckout: false,
    incomingCustomerId: OLD,
    currentCustomerId: NEW,
    currentStatus: 'active',
  }).decision, 'superseded');
});

Deno.test('every entitling status on the current customer protects the mapping', () => {
  for (const status of ['active', 'trialing', 'past_due']) {
    assertEquals(decideCustomerMapping({
      isCheckout: false, incomingCustomerId: OLD, currentCustomerId: NEW, currentStatus: status,
    }).decision, 'superseded', status);
  }
});

Deno.test('a checkout always maps: the author chose this customer just now', () => {
  assertEquals(decideCustomerMapping({
    isCheckout: true, incomingCustomerId: NEW, currentCustomerId: OLD, currentStatus: 'active',
  }).decision, 'map');
});

Deno.test('a non-checkout event maps a user with no customer, or one whose customer is known to grant nothing', () => {
  assertEquals(decideCustomerMapping({
    isCheckout: false, incomingCustomerId: NEW, currentCustomerId: null, currentStatus: undefined,
  }).decision, 'map', 'no current customer');
  for (const status of ['none', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired']) {
    assertEquals(decideCustomerMapping({
      isCheckout: false, incomingCustomerId: NEW, currentCustomerId: OLD, currentStatus: status,
    }).decision, 'map', status);
  }
});

Deno.test('a current customer with no cache row is kept: it may be the one just bought', () => {
  // The fresh customer's own webhook can land after a dunning retry on the old one.
  assertEquals(decideCustomerMapping({
    isCheckout: false, incomingCustomerId: OLD, currentCustomerId: NEW, currentStatus: undefined,
  }), { decision: 'superseded', currentCustomerId: NEW });
});

Deno.test('an event for the customer already mapped is never superseded', () => {
  assertEquals(decideCustomerMapping({
    isCheckout: false, incomingCustomerId: NEW, currentCustomerId: NEW, currentStatus: undefined,
  }).decision, 'map');
});

Deno.test('past_due is entitling; unpaid is not, but opens the portal; incomplete does neither', () => {
  assert(isEntitlingStatus('past_due'));
  assertFalse(isEntitlingStatus('unpaid'));
  assertFalse(isEntitlingStatus('incomplete'));
  for (const status of ['active', 'trialing', 'past_due', 'unpaid']) {
    assert(canOpenBillingPortal(status), status);
  }
  // incomplete: an abandoned first payment the portal cannot repair.
  for (const status of ['none', 'canceled', 'incomplete', 'incomplete_expired', 'paused', undefined]) {
    assertFalse(canOpenBillingPortal(status), String(status));
  }
});

Deno.test('an abandoned incomplete checkout does not outrank a dead subscription', () => {
  // Same rank, so Stripe's newest-first order decides — the canceled one is no better.
  assertEquals(pickSubscription([
    { id: 'abandoned', status: 'incomplete' },
    { id: 'dead', status: 'canceled' },
  ])?.id, 'abandoned');
  assertEquals(pickSubscription([
    { id: 'dead', status: 'canceled' },
    { id: 'abandoned', status: 'incomplete' },
  ])?.id, 'dead');
});

Deno.test('the newest subscription no longer hides an older active one', () => {
  // Stripe lists newest first.
  const subs = [
    { id: 'sub_3', status: 'incomplete_expired' },
    { id: 'sub_2', status: 'canceled' },
    { id: 'sub_1', status: 'active' },
  ];
  assertEquals(pickSubscription(subs)?.id, 'sub_1');
});

Deno.test('pickSubscription ranks active > trialing > past_due > unpaid > the rest', () => {
  const order = ['active', 'trialing', 'past_due', 'unpaid', 'canceled'];
  for (let i = 0; i < order.length - 1; i++) {
    const better = { id: 'better', status: order[i] };
    const worse = { id: 'worse', status: order[i + 1] };
    assertEquals(pickSubscription([worse, better])?.id, 'better', `${order[i]} over ${order[i + 1]}`);
    assertEquals(pickSubscription([better, worse])?.id, 'better', `${order[i]} over ${order[i + 1]}, reversed`);
  }
});

Deno.test('within a rank the newest subscription wins, and an empty list picks nothing', () => {
  assertEquals(pickSubscription([
    { id: 'newer', status: 'canceled' },
    { id: 'older', status: 'canceled' },
  ])?.id, 'newer');
  assertEquals(pickSubscription([]), undefined);
});
