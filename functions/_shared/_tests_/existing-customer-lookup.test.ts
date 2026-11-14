/**
 * Deno tests for `resolveExistingCustomer`, the lookup behind the Pricing Table's customer
 * session (hosted#702).
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/_shared/_tests_/existing-customer-lookup.test.ts
 *
 * The endpoint runs on every Pricing Table render, for authors who mostly never buy. So the one
 * rule that matters most is that it never creates a Stripe customer: the lookups are injected,
 * and none of them can.
 */

import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  customersOwnedByOtherUsers,
  type ExistingCustomerLookups,
  forCustomerSession,
  resolveExistingCustomer,
} from '../stripe-helpers.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

function lookups(found: { byUserId?: string; byEmail?: string; inStripe?: string }, failSave = false) {
  const calls: string[] = [];
  const saved: string[] = [];
  const impl: ExistingCustomerLookups = {
    byUserId: (userId) => { calls.push(`byUserId:${userId}`); return Promise.resolve(found.byUserId ?? null); },
    byEmail: (email) => { calls.push(`byEmail:${email}`); return Promise.resolve(found.byEmail ?? null); },
    inStripeByEmail: (email) => { calls.push(`inStripe:${email}`); return Promise.resolve(found.inStripe ?? null); },
    saveMapping: (userId, _email, customerId) => {
      if (failSave) return Promise.reject(new Error('db down'));
      saved.push(`${userId}->${customerId}`);
      return Promise.resolve(true);
    },
  };
  return { impl, calls, saved };
}

Deno.test('the mapping wins, and nothing else is asked', async () => {
  const l = lookups({ byUserId: 'cus_mapped', byEmail: 'cus_email', inStripe: 'cus_stripe' });
  assertEquals(await resolveExistingCustomer('u1', 'a@x.test', l.impl), 'cus_mapped');
  assertEquals(l.calls, ['byUserId:u1']);
  assertEquals(l.saved, []);
});

Deno.test('then the email row, without asking Stripe', async () => {
  const l = lookups({ byEmail: 'cus_email', inStripe: 'cus_stripe' });
  assertEquals(await resolveExistingCustomer('u1', 'a@x.test', l.impl), 'cus_email');
  assertEquals(l.calls, ['byUserId:u1', 'byEmail:a@x.test']);
  assertEquals(l.saved, []);
});

Deno.test('then a Stripe hit, which is saved as the mapping', async () => {
  const l = lookups({ inStripe: 'cus_stripe' });
  assertEquals(await resolveExistingCustomer('u1', 'a@x.test', l.impl), 'cus_stripe');
  assertEquals(l.saved, ['u1->cus_stripe']);
});

Deno.test('a failed mapping save still returns the Stripe customer', async () => {
  const l = lookups({ inStripe: 'cus_stripe' }, true);
  assertEquals(await resolveExistingCustomer('u1', 'a@x.test', l.impl), 'cus_stripe');
});

Deno.test('no customer anywhere → null, and no mapping is written', async () => {
  const l = lookups({});
  assertEquals(await resolveExistingCustomer('u1', 'a@x.test', l.impl), null);
  assertEquals(l.calls, ['byUserId:u1', 'byEmail:a@x.test', 'inStripe:a@x.test']);
  assertEquals(l.saved, []);
});

Deno.test('a failing Stripe lookup rejects rather than reading as "no customer"', async () => {
  const l = lookups({});
  l.impl.inStripeByEmail = () => Promise.reject(new Error('stripe down'));
  await assertRejects(() => resolveExistingCustomer('u1', 'a@x.test', l.impl), Error, 'stripe down');
});

// --- forCustomerSession: the narrowing a page render gets ---

Deno.test('customer session: the mapping still wins', async () => {
  const l = lookups({ byUserId: 'cus_mapped' });
  const narrowed = forCustomerSession(l.impl, (ids) => Promise.resolve(new Set(ids)));
  assertEquals(await resolveExistingCustomer('u1', 'a@x.test', narrowed), 'cus_mapped');
});

Deno.test('customer session: an email row is another account\'s, so it is never used', async () => {
  const l = lookups({ byEmail: 'cus_previous_owner' });
  const narrowed = forCustomerSession(l.impl, () => Promise.resolve(new Set()));
  assertEquals(await resolveExistingCustomer('u1', 'a@x.test', narrowed), null);
  assertEquals(l.calls.includes('byEmail:a@x.test'), false);
});

Deno.test('customer session: an unmapped Stripe match is used, and nothing is written', async () => {
  const l = lookups({ inStripe: 'cus_stripe' });
  const narrowed = forCustomerSession(l.impl, () => Promise.resolve(new Set()));
  assertEquals(await resolveExistingCustomer('u1', 'a@x.test', narrowed), 'cus_stripe');
  assertEquals(l.saved, []);
});

Deno.test('customer session: a Stripe match mapped to another account is not borrowed', async () => {
  const l = lookups({ inStripe: 'cus_other_account' });
  const asked: string[] = [];
  const narrowed = forCustomerSession(l.impl, (ids) => { asked.push(...ids); return Promise.resolve(new Set(ids)); });
  assertEquals(await resolveExistingCustomer('u1', 'a@x.test', narrowed), null);
  assertEquals(asked, ['cus_other_account']);
  assertEquals(l.saved, []);
});

// --- Ownership: the mapping AND webhook history (audit_log) of other accounts ---

/**
 * A stand-in for the two PostgREST reads `customersOwnedByOtherUsers` makes. Each table answers
 * with its rows filtered the way the real query filters them: ids in the list, a user other than
 * the caller.
 */
function stubSupabase(tables: {
  stripe_customers?: { stripe_customer_id: string; user_id: string }[];
  audit_log?: { customer: string; user_id: string | null }[];
  failing?: 'stripe_customers' | 'audit_log';
}): SupabaseClient {
  return {
    from(table: string) {
      const filters: { ids?: string[]; notUser?: string } = {};
      const builder = {
        select: () => builder,
        in: (_col: string, ids: string[]) => { filters.ids = ids; return builder; },
        neq: (_col: string, user: string) => { filters.notUser = user; return builder; },
        not: () => builder,
        limit: () => builder,
        then(resolve: (v: unknown) => void) {
          if (tables.failing === table) return resolve({ data: null, error: { message: `${table} down` } });
          const rows = table === 'stripe_customers'
            ? (tables.stripe_customers ?? []).filter(r => filters.ids?.includes(r.stripe_customer_id))
            : (tables.audit_log ?? []).filter(r => filters.ids?.includes(r.customer) && r.user_id !== null);
          resolve({ data: rows.filter(r => r.user_id !== filters.notUser), error: null });
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

Deno.test("ownership: a customer only another account's webhook history names is theirs", async () => {
  // The audit-only shape: a superseded customer of theirs has no mapping row, but its events
  // carry their user id. The old `isMappedToAnyUser` check read the mapping alone.
  const supabase = stubSupabase({
    audit_log: [{ customer: 'cus_theirs', user_id: 'u_other' }, { customer: 'cus_mine', user_id: 'u1' }],
  });
  assertEquals(
    [...await customersOwnedByOtherUsers(supabase, 'u1', ['cus_theirs', 'cus_mine', 'cus_nobody'])],
    ['cus_theirs'],
  );
});

Deno.test("customer session: a Stripe match only another account's audit history names is not borrowed", async () => {
  const l = lookups({ inStripe: 'cus_theirs' });
  const supabase = stubSupabase({ audit_log: [{ customer: 'cus_theirs', user_id: 'u_other' }] });
  const narrowed = forCustomerSession(l.impl, (ids) => customersOwnedByOtherUsers(supabase, 'u1', ids));
  assertEquals(await resolveExistingCustomer('u1', 'a@x.test', narrowed), null);
});

Deno.test('customer session: a Stripe match nobody else owns is still used', async () => {
  const l = lookups({ inStripe: 'cus_free' });
  const supabase = stubSupabase({ stripe_customers: [{ stripe_customer_id: 'cus_free', user_id: 'u1' }] });
  const narrowed = forCustomerSession(l.impl, (ids) => customersOwnedByOtherUsers(supabase, 'u1', ids));
  assertEquals(await resolveExistingCustomer('u1', 'a@x.test', narrowed), 'cus_free');
});

Deno.test('customer session: a failed ownership lookup fails closed to "no customer", not a 500', async () => {
  for (const failing of ['stripe_customers', 'audit_log'] as const) {
    const l = lookups({ inStripe: 'cus_maybe' });
    const supabase = stubSupabase({ failing });
    const narrowed = forCustomerSession(l.impl, (ids) => customersOwnedByOtherUsers(supabase, 'u1', ids));
    assertEquals(await resolveExistingCustomer('u1', 'a@x.test', narrowed), null, failing);
  }
});

Deno.test('ownership: a failed lookup rejects, so delete-account aborts', async () => {
  await assertRejects(
    () => customersOwnedByOtherUsers(stubSupabase({ failing: 'audit_log' }), 'u1', ['cus_x']),
    Error,
    'Ownership lookup failed',
  );
});
