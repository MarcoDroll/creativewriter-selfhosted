/**
 * Deno tests for the Stripe side of account deletion (hosted#698).
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/delete-account/_tests_/stripe-cleanup.test.ts
 *
 * The bug: delete-account cancelled subscriptions on the ONE customer
 * `stripe_customers` maps. The Pricing Table makes a new customer per checkout, so
 * an author who re-purchased (public#65 ended with four customers) could delete
 * their account and keep being billed by the customers the mapping did not name.
 */

import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  cancelAndDeleteAllCustomers,
  isLiveSubscriptionStatus,
  type StripeCleanupInput,
  type StripeCleanupPort,
} from '../stripe-cleanup.ts';

interface FakeCustomer {
  email: string;
  deleted?: boolean;
  subs: { id: string; status: string }[];
}

function fakeStripe(customers: Record<string, FakeCustomer>) {
  const calls = { cancelled: [] as string[], deleted: [] as string[] };
  const port: StripeCleanupPort = {
    listCustomerIdsByEmail: (email) => Promise.resolve(
      Object.entries(customers).filter(([, c]) => c.email === email && !c.deleted).map(([id]) => id)),
    customerExists: (id) => Promise.resolve(id in customers && !customers[id].deleted),
    listSubscriptions: (id) => Promise.resolve(customers[id]?.subs ?? []),
    cancelSubscription: (id) => { calls.cancelled.push(id); return Promise.resolve(); },
    deleteCustomer: (id) => { calls.deleted.push(id); return Promise.resolve(); },
  };
  return { port, calls };
}

function input(overrides: Partial<StripeCleanupInput> & { stripe: StripeCleanupPort }): StripeCleanupInput {
  return {
    mappedCustomerId: null,
    auditCustomerIds: [],
    emails: ['author@example.com'],
    ownedByOtherUsers: () => Promise.resolve(new Set()),
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
