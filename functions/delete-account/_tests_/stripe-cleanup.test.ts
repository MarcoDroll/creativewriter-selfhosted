/**
 * Deno tests for the Stripe side of account deletion (hosted#698).
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/delete-account/_tests_/stripe-cleanup.test.ts
 *
 * The first bug: delete-account cancelled subscriptions on the ONE customer
 * `stripe_customers` maps. The Pricing Table makes a new customer per checkout, so
 * an author who re-purchased (public#65 ended with four customers) could delete
 * their account and keep being billed by the customers the mapping did not name.
 *
 * The second: the fix for the first cancelled every live subscription of every
 * customer with the author's email and deleted those customers — on a Stripe account
 * that bills other products too. Only CreativeWriter's subscriptions are ours to end.
 */

import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  cancelAndDeleteAllCustomers,
  type CleanupSubscription,
  isLiveSubscriptionStatus,
  type StripeCleanupInput,
  type StripeCleanupPort,
} from '../stripe-cleanup.ts';
import type { CwCatalog } from '../../_shared/stripe-catalog.ts';

const CATALOG: CwCatalog = {
  priceIds: new Set(['price_cw_basic_m', 'price_cw_premium_y']),
  productIds: new Set(['prod_cw', 'prod_cw_legacy']),
};

const CW_ITEM = { priceId: 'price_cw_basic_m', productId: 'prod_cw' };
const FOREIGN_ITEM = { priceId: 'price_course', productId: 'prod_course' };

interface FakeSub {
  id: string;
  status: string;
  items?: CleanupSubscription['items'];
  itemsHasMore?: boolean;
}

interface FakeCustomer {
  email: string;
  deleted?: boolean;
  subs: FakeSub[];
  /** An `open` or `draft` invoice. */
  openInvoice?: boolean;
}

function fakeStripe(customers: Record<string, FakeCustomer>) {
  const calls = { cancelled: [] as string[], deleted: [] as string[], invoiceChecks: [] as string[] };
  const port: StripeCleanupPort = {
    listCustomerIdsByEmail: (email) => Promise.resolve(
      Object.entries(customers).filter(([, c]) => c.email === email && !c.deleted).map(([id]) => id)),
    customerExists: (id) => Promise.resolve(id in customers && !customers[id].deleted),
    listSubscriptions: (id) => Promise.resolve((customers[id]?.subs ?? []).map(s => ({
      id: s.id,
      status: s.status,
      // A subscription written without items is a plain CreativeWriter one.
      items: s.items ?? [CW_ITEM],
      itemsHasMore: s.itemsHasMore ?? false,
    }))),
    cancelSubscription: (id) => {
      calls.cancelled.push(id);
      // Stripe's state moves with the call, so a retry sees what the first run did.
      for (const c of Object.values(customers)) for (const s of c.subs) if (s.id === id) s.status = 'canceled';
      return Promise.resolve();
    },
    deleteCustomer: (id) => {
      calls.deleted.push(id);
      if (customers[id]) customers[id].deleted = true;
      return Promise.resolve();
    },
    hasOpenOrDraftInvoice: (id) => {
      calls.invoiceChecks.push(id);
      return Promise.resolve(customers[id]?.openInvoice ?? false);
    },
  };
  return { port, calls };
}

function input(overrides: Partial<StripeCleanupInput> & { stripe: StripeCleanupPort }): StripeCleanupInput {
  return {
    mappedCustomerId: null,
    auditCustomerIds: [],
    emails: ['author@example.com'],
    ownedByOtherUsers: () => Promise.resolve(new Set()),
    catalog: CATALOG,
    ...overrides,
  };
}

Deno.test('every customer of the account is cancelled and deleted, not only the mapped one', async () => {
  // The public#65 shape: an old past_due customer, two re-purchases, the mapping on the last.
  const { port, calls } = fakeStripe({
    cus_old: { email: 'author@example.com', subs: [{ id: 'sub_old', status: 'past_due' }] },
    cus_second: { email: 'author@example.com', subs: [{ id: 'sub_second', status: 'active' }] },
    cus_mapped: { email: 'author@example.com', subs: [{ id: 'sub_mapped', status: 'active' }] },
  });

  const result = await cancelAndDeleteAllCustomers(input({ mappedCustomerId: 'cus_mapped', stripe: port }));

  assertEquals(calls.cancelled.sort(), ['sub_mapped', 'sub_old', 'sub_second']);
  assertEquals(calls.deleted.sort(), ['cus_mapped', 'cus_old', 'cus_second']);
  assertEquals(result.skippedForeignCustomerIds, []);
});

Deno.test('a customer known only from audit_log is found even under another email', async () => {
  // A checkout where the author typed a different address: no email match, but the
  // webhook recorded it against the user.
  const { port, calls } = fakeStripe({
    cus_mapped: { email: 'author@example.com', subs: [] },
    cus_typed: { email: 'typo@example.com', subs: [{ id: 'sub_typed', status: 'active' }] },
  });

  await cancelAndDeleteAllCustomers(input({
    mappedCustomerId: 'cus_mapped', auditCustomerIds: ['cus_typed'], stripe: port,
  }));

  assertEquals(calls.cancelled, ['sub_typed']);
  assertEquals(calls.deleted.sort(), ['cus_mapped', 'cus_typed']);
});

Deno.test("an email match the mapping gives to another account is left alone", async () => {
  const { port, calls } = fakeStripe({
    cus_mine: { email: 'author@example.com', subs: [{ id: 'sub_mine', status: 'active' }] },
    cus_theirs: { email: 'author@example.com', subs: [{ id: 'sub_theirs', status: 'active' }] },
  });

  const result = await cancelAndDeleteAllCustomers(input({
    mappedCustomerId: 'cus_mine',
    ownedByOtherUsers: (ids) => Promise.resolve(new Set(ids.filter(id => id === 'cus_theirs'))),
    stripe: port,
  }));

  assertEquals(calls.cancelled, ['sub_mine']);
  assertEquals(calls.deleted, ['cus_mine']);
  assertEquals(result.skippedForeignCustomerIds, ['cus_theirs']);
});

Deno.test('the mapped customer is never offered to the ownership check', async () => {
  const asked: string[][] = [];
  const { port } = fakeStripe({ cus_mine: { email: 'author@example.com', subs: [] } });

  await cancelAndDeleteAllCustomers(input({
    mappedCustomerId: 'cus_mine',
    ownedByOtherUsers: (ids) => { asked.push(ids); return Promise.resolve(new Set()); },
    stripe: port,
  }));

  assertEquals(asked, [], 'nothing but the mapped customer, so no lookup at all');
});

Deno.test('an audit id for a customer already deleted is skipped, not an error', async () => {
  const { port, calls } = fakeStripe({
    cus_gone: { email: 'author@example.com', deleted: true, subs: [] },
  });

  await cancelAndDeleteAllCustomers(input({ auditCustomerIds: ['cus_gone'], stripe: port }));

  assertEquals(calls.deleted, []);
});

Deno.test('only subscriptions that can still charge are cancelled; the customer is deleted regardless', async () => {
  const { port, calls } = fakeStripe({
    cus_mine: {
      email: 'author@example.com',
      subs: [
        { id: 'sub_active', status: 'active' },
        { id: 'sub_unpaid', status: 'unpaid' },
        { id: 'sub_canceled', status: 'canceled' },
        { id: 'sub_expired', status: 'incomplete_expired' },
      ],
    },
  });

  await cancelAndDeleteAllCustomers(input({ mappedCustomerId: 'cus_mine', stripe: port }));

  assertEquals(calls.cancelled, ['sub_active', 'sub_unpaid']);
  assertEquals(calls.deleted, ['cus_mine']);
});

Deno.test('each address is asked once, and a customer found twice is handled once', async () => {
  const listed: string[] = [];
  const { port, calls } = fakeStripe({ cus_mine: { email: 'author@example.com', subs: [] } });
  const counting: StripeCleanupPort = {
    ...port,
    listCustomerIdsByEmail: (email) => { listed.push(email); return port.listCustomerIdsByEmail(email); },
  };

  await cancelAndDeleteAllCustomers(input({
    mappedCustomerId: 'cus_mine',
    auditCustomerIds: ['cus_mine'],
    emails: ['author@example.com', 'author@example.com', ''],
    stripe: counting,
  }));

  assertEquals(listed, ['author@example.com']);
  assertEquals(calls.deleted, ['cus_mine']);
});

Deno.test('a Stripe failure stops the cleanup, so the caller does not delete a still-billed account', async () => {
  const { port } = fakeStripe({ cus_mine: { email: 'author@example.com', subs: [{ id: 'sub_1', status: 'active' }] } });
  const failing: StripeCleanupPort = { ...port, cancelSubscription: () => Promise.reject(new Error('stripe down')) };

  await assertRejects(
    () => cancelAndDeleteAllCustomers(input({ mappedCustomerId: 'cus_mine', stripe: failing })),
    Error,
    'stripe down',
  );
});

Deno.test('live statuses are the ones that can still charge or be revived', () => {
  for (const s of ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused']) {
    assertEquals(isLiveSubscriptionStatus(s), true, s);
  }
  for (const s of ['canceled', 'incomplete_expired']) {
    assertEquals(isLiveSubscriptionStatus(s), false, s);
  }
});

Deno.test('the mapped customer is cancelled first, so its duplicates never read as a second billing customer', async () => {
  const { port, calls } = fakeStripe({
    cus_dup_a: { email: 'author@example.com', subs: [{ id: 'sub_a', status: 'active' }] },
    cus_mapped: { email: 'author@example.com', subs: [{ id: 'sub_mapped', status: 'active' }] },
    cus_dup_b: { email: 'author@example.com', subs: [{ id: 'sub_b', status: 'active' }] },
  });

  await cancelAndDeleteAllCustomers(input({
    mappedCustomerId: 'cus_mapped', auditCustomerIds: ['cus_dup_b'], stripe: port,
  }));

  assertEquals(calls.cancelled[0], 'sub_mapped');
  assertEquals(calls.deleted[0], 'cus_mapped');
  assertEquals(calls.deleted.length, 3);
});

Deno.test('an audit id the caller attributes to another user is left alone', async () => {
  // Relinked to someone else since this user's webhook recorded it.
  const { port, calls } = fakeStripe({
    cus_mine: { email: 'author@example.com', subs: [] },
    cus_relinked: { email: 'other@example.com', subs: [{ id: 'sub_theirs', status: 'active' }] },
  });

  const result = await cancelAndDeleteAllCustomers(input({
    mappedCustomerId: 'cus_mine',
    auditCustomerIds: ['cus_relinked'],
    ownedByOtherUsers: (ids) => Promise.resolve(new Set(ids.filter(id => id === 'cus_relinked'))),
    stripe: port,
  }));

  assertEquals(calls.cancelled, []);
  assertEquals(calls.deleted, ['cus_mine']);
  assertEquals(result.skippedForeignCustomerIds, ['cus_relinked']);
});

Deno.test('a retry after a partial run skips a mapped customer Stripe already deleted', async () => {
  const { port, calls } = fakeStripe({
    cus_mapped: { email: 'author@example.com', deleted: true, subs: [] },
    cus_left: { email: 'author@example.com', subs: [{ id: 'sub_left', status: 'active' }] },
  });

  await cancelAndDeleteAllCustomers(input({ mappedCustomerId: 'cus_mapped', stripe: port }));

  assertEquals(calls.cancelled, ['sub_left']);
  assertEquals(calls.deleted, ['cus_left']);
});

Deno.test('a failed ownership or email lookup aborts before anything is cancelled', async () => {
  const { port, calls } = fakeStripe({
    cus_mine: { email: 'author@example.com', subs: [{ id: 'sub_1', status: 'active' }] },
    cus_dup: { email: 'author@example.com', subs: [{ id: 'sub_2', status: 'active' }] },
  });

  await assertRejects(() => cancelAndDeleteAllCustomers(input({
    mappedCustomerId: 'cus_mine',
    ownedByOtherUsers: () => Promise.reject(new Error('db down')),
    stripe: port,
  })), Error, 'db down');
  await assertRejects(() => cancelAndDeleteAllCustomers(input({
    mappedCustomerId: 'cus_mine',
    stripe: { ...port, listCustomerIdsByEmail: () => Promise.reject(new Error('stripe down')) },
  })), Error, 'stripe down');

  assertEquals(calls.cancelled, []);
  assertEquals(calls.deleted, []);
});

// --- Only CreativeWriter's billing is touched (the prod Stripe account bills other products) ---

Deno.test('a foreign subscription on the mapped customer survives, and the customer is kept', async () => {
  const { port, calls } = fakeStripe({
    cus_mapped: {
      email: 'author@example.com',
      subs: [
        { id: 'sub_cw', status: 'active' },
        { id: 'sub_course', status: 'active', items: [FOREIGN_ITEM] },
      ],
    },
  });

  const result = await cancelAndDeleteAllCustomers(input({ mappedCustomerId: 'cus_mapped', stripe: port }));

  assertEquals(calls.cancelled, ['sub_cw']);
  assertEquals(calls.deleted, [], 'customers.del would cancel the course subscription too');
  assertEquals(result.keptCustomers, [{ customerId: 'cus_mapped', reason: 'live_subscription_not_ours' }]);
  // On the mapped customer an unknown product may be a legacy CreativeWriter price: an operator decides.
  assertEquals(result.needsReview, [
    { customerId: 'cus_mapped', subscriptionId: 'sub_course', reason: 'unknown_product_on_mapped_customer' },
  ]);
});

Deno.test('a mixed subscription is not cancelled, raises a review, and keeps its customer', async () => {
  const { port, calls } = fakeStripe({
    cus_mapped: {
      email: 'author@example.com',
      subs: [{ id: 'sub_mixed', status: 'active', items: [CW_ITEM, FOREIGN_ITEM] }],
    },
  });

  const result = await cancelAndDeleteAllCustomers(input({ mappedCustomerId: 'cus_mapped', stripe: port }));

  assertEquals(calls.cancelled, []);
  assertEquals(calls.deleted, []);
  assertEquals(result.needsReview, [{ customerId: 'cus_mapped', subscriptionId: 'sub_mixed', reason: 'mixed_items' }]);
  assertEquals(result.keptCustomers, [{ customerId: 'cus_mapped', reason: 'live_subscription_not_ours' }]);
});

Deno.test('a subscription whose item list Stripe truncated is unsure, never cancelled', async () => {
  const { port, calls } = fakeStripe({
    cus_mapped: {
      email: 'author@example.com',
      subs: [{ id: 'sub_many', status: 'active', items: [CW_ITEM], itemsHasMore: true }],
    },
  });

  const result = await cancelAndDeleteAllCustomers(input({ mappedCustomerId: 'cus_mapped', stripe: port }));

  assertEquals(calls.cancelled, []);
  assertEquals(calls.deleted, []);
  assertEquals(result.needsReview, [{ customerId: 'cus_mapped', subscriptionId: 'sub_many', reason: 'items_truncated' }]);
});

Deno.test('an email-only customer with no CreativeWriter history is never touched', async () => {
  // Someone bought a course with this address; the account never had anything to do with it.
  const { port, calls } = fakeStripe({
    cus_mapped: { email: 'author@example.com', subs: [{ id: 'sub_cw', status: 'active' }] },
    cus_course: { email: 'author@example.com', subs: [{ id: 'sub_course', status: 'active', items: [FOREIGN_ITEM] }] },
    cus_empty: { email: 'author@example.com', subs: [] },
  });

  const result = await cancelAndDeleteAllCustomers(input({ mappedCustomerId: 'cus_mapped', stripe: port }));

  assertEquals(calls.cancelled, ['sub_cw']);
  assertEquals(calls.deleted, ['cus_mapped']);
  assertEquals(result.needsReview, [], 'not ours, and not on the mapped customer: nothing to review');
  assertEquals(result.keptCustomers.sort((a, b) => a.customerId.localeCompare(b.customerId)), [
    { customerId: 'cus_course', reason: 'email_match_without_creativewriter_history' },
    { customerId: 'cus_empty', reason: 'email_match_without_creativewriter_history' },
  ]);
});

Deno.test('an email-only #698 duplicate with an old CreativeWriter subscription and no open invoice is deleted', async () => {
  const { port, calls } = fakeStripe({
    cus_mapped: { email: 'author@example.com', subs: [] },
    cus_dup: { email: 'author@example.com', subs: [{ id: 'sub_old', status: 'canceled' }] },
  });

  await cancelAndDeleteAllCustomers(input({ mappedCustomerId: 'cus_mapped', stripe: port }));

  assertEquals(calls.deleted, ['cus_mapped', 'cus_dup']);
  assertEquals(calls.invoiceChecks, ['cus_dup'], 'only an email-only match needs the invoice check');
});

Deno.test('the same duplicate with an open or draft invoice is kept', async () => {
  const { port, calls } = fakeStripe({
    cus_mapped: { email: 'author@example.com', subs: [] },
    cus_dup: { email: 'author@example.com', subs: [{ id: 'sub_old', status: 'canceled' }], openInvoice: true },
  });

  const result = await cancelAndDeleteAllCustomers(input({ mappedCustomerId: 'cus_mapped', stripe: port }));

  assertEquals(calls.deleted, ['cus_mapped']);
  assertEquals(result.keptCustomers, [{ customerId: 'cus_dup', reason: 'open_or_draft_invoice' }]);
});

Deno.test('a legacy price on a STRIPE_CW_LEGACY_PRODUCT_IDS product is cancelled', async () => {
  const { port, calls } = fakeStripe({
    cus_mapped: {
      email: 'author@example.com',
      subs: [{ id: 'sub_comp', status: 'active', items: [{ priceId: 'price_comp_2024', productId: 'prod_cw_legacy' }] }],
    },
  });

  await cancelAndDeleteAllCustomers(input({ mappedCustomerId: 'cus_mapped', stripe: port }));

  assertEquals(calls.cancelled, ['sub_comp']);
  assertEquals(calls.deleted, ['cus_mapped']);
});

Deno.test('a foreign subscription on an audit-attributed customer is kept without a review', async () => {
  const { port, calls } = fakeStripe({
    cus_audit: {
      email: 'typo@example.com',
      subs: [{ id: 'sub_cw', status: 'active' }, { id: 'sub_course', status: 'trialing', items: [FOREIGN_ITEM] }],
    },
  });

  const result = await cancelAndDeleteAllCustomers(input({ auditCustomerIds: ['cus_audit'], stripe: port }));

  assertEquals(calls.cancelled, ['sub_cw']);
  assertEquals(calls.deleted, []);
  assertEquals(result.needsReview, []);
  assertEquals(result.keptCustomers, [{ customerId: 'cus_audit', reason: 'live_subscription_not_ours' }]);
});

Deno.test('every subscription is read before anything is cancelled', async () => {
  const order: string[] = [];
  const { port } = fakeStripe({
    cus_mapped: { email: 'author@example.com', subs: [{ id: 'sub_a', status: 'active' }] },
    cus_dup: { email: 'author@example.com', subs: [{ id: 'sub_b', status: 'active' }] },
  });
  const recording: StripeCleanupPort = {
    ...port,
    listSubscriptions: (id) => { order.push(`list:${id}`); return port.listSubscriptions(id); },
    cancelSubscription: (id) => { order.push(`cancel:${id}`); return port.cancelSubscription(id); },
  };

  await cancelAndDeleteAllCustomers(input({ mappedCustomerId: 'cus_mapped', stripe: recording }));

  assertEquals(order, ['list:cus_mapped', 'list:cus_dup', 'cancel:sub_a', 'cancel:sub_b']);
});

Deno.test('a failure at deleteCustomer, then a retry, completes and cancels nothing twice', async () => {
  const { port, calls } = fakeStripe({
    cus_mapped: { email: 'author@example.com', subs: [{ id: 'sub_a', status: 'active' }] },
    cus_dup: { email: 'author@example.com', subs: [{ id: 'sub_b', status: 'active' }] },
  });
  let failOnce = true;
  const flaky: StripeCleanupPort = {
    ...port,
    deleteCustomer: (id) => {
      if (id === 'cus_dup' && failOnce) {
        failOnce = false;
        return Promise.reject(new Error('stripe hiccup'));
      }
      return port.deleteCustomer(id);
    },
  };

  await assertRejects(
    () => cancelAndDeleteAllCustomers(input({ mappedCustomerId: 'cus_mapped', stripe: flaky })),
    Error,
    'stripe hiccup',
  );
  await cancelAndDeleteAllCustomers(input({ mappedCustomerId: 'cus_mapped', stripe: flaky }));

  assertEquals(calls.cancelled.sort(), ['sub_a', 'sub_b']);
  assertEquals(calls.deleted.sort(), ['cus_dup', 'cus_mapped']);
});
