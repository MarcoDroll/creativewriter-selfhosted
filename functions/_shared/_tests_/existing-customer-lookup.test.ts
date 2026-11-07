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
import { type ExistingCustomerLookups, forCustomerSession, resolveExistingCustomer } from '../stripe-helpers.ts';

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
  const narrowed = forCustomerSession(l.impl, () => Promise.resolve(true));
  assertEquals(await resolveExistingCustomer('u1', 'a@x.test', narrowed), 'cus_mapped');
});

Deno.test('customer session: an email row is another account\'s, so it is never used', async () => {
  const l = lookups({ byEmail: 'cus_previous_owner' });
  const narrowed = forCustomerSession(l.impl, () => Promise.resolve(false));
  assertEquals(await resolveExistingCustomer('u1', 'a@x.test', narrowed), null);
  assertEquals(l.calls.includes('byEmail:a@x.test'), false);
});

Deno.test('customer session: an unmapped Stripe match is used, and nothing is written', async () => {
  const l = lookups({ inStripe: 'cus_stripe' });
  const narrowed = forCustomerSession(l.impl, () => Promise.resolve(false));
  assertEquals(await resolveExistingCustomer('u1', 'a@x.test', narrowed), 'cus_stripe');
  assertEquals(l.saved, []);
});

Deno.test('customer session: a Stripe match mapped to another account is not borrowed', async () => {
  const l = lookups({ inStripe: 'cus_other_account' });
  const asked: string[] = [];
  const narrowed = forCustomerSession(l.impl, (id) => { asked.push(id); return Promise.resolve(true); });
  assertEquals(await resolveExistingCustomer('u1', 'a@x.test', narrowed), null);
  assertEquals(asked, ['cus_other_account']);
  assertEquals(l.saved, []);
});
