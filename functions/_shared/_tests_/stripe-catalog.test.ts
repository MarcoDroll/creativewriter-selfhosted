/**
 * Deno tests for `stripe-catalog.ts`: which Stripe prices and products are CreativeWriter's.
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/_shared/_tests_/stripe-catalog.test.ts
 *
 * The prod Stripe account bills other products. delete-account and the webhook both have to tell
 * our subscriptions from theirs, and must never guess.
 */

import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  buildCwCatalog,
  classifySubscriptionItems,
  type CwCatalog,
  legacyCwProductIds,
  requireCwCatalog,
  shouldSkipAsForeignProduct,
  type ForeignProductSkipInput,
} from '../stripe-catalog.ts';
import { eventItemRefs } from '../stripe-items.ts';
import type Stripe from 'npm:stripe@17';

const CATALOG: CwCatalog = { priceIds: new Set(['price_cw']), productIds: new Set(['prod_cw', 'prod_legacy']) };
const CW = { priceId: 'price_cw', productId: 'prod_cw' };
const OLD_CW_PRICE = { priceId: 'price_cw_2024', productId: 'prod_cw' };
const LEGACY = { priceId: 'price_comp', productId: 'prod_legacy' };
const FOREIGN = { priceId: 'price_course', productId: 'prod_course' };

const FULL_ENV: Record<string, string> = {
  STRIPE_BASIC_PRICE_ID_MONTHLY: 'price_bm',
  STRIPE_BASIC_PRICE_ID_YEARLY: 'price_by',
  STRIPE_PREMIUM_PRICE_ID_MONTHLY: 'price_pm',
  STRIPE_PREMIUM_PRICE_ID_YEARLY: 'price_py',
};
const envOf = (vars: Record<string, string>) => (k: string) => vars[k];

// --- classifySubscriptionItems ---

Deno.test('ours by configured price, by product (an older price on our product), or by a legacy product', () => {
  assertEquals(classifySubscriptionItems([CW], false, CATALOG), 'creativewriter');
  assertEquals(classifySubscriptionItems([OLD_CW_PRICE], false, CATALOG), 'creativewriter');
  assertEquals(classifySubscriptionItems([LEGACY], false, CATALOG), 'creativewriter');
});

Deno.test('foreign when no item is ours, unsure when mixed, empty or truncated', () => {
  assertEquals(classifySubscriptionItems([FOREIGN], false, CATALOG), 'foreign');
  assertEquals(classifySubscriptionItems([CW, FOREIGN], false, CATALOG), 'unsure');
  assertEquals(classifySubscriptionItems([], false, CATALOG), 'unsure');
  assertEquals(classifySubscriptionItems([CW], true, CATALOG), 'unsure');
  // An item with no readable price (a manual invoice line, or a newer API version's payload) is unread, not foreign.
  assertEquals(classifySubscriptionItems([{ priceId: null, productId: null }], false, CATALOG), 'unsure');
  assertEquals(classifySubscriptionItems([FOREIGN, { priceId: null, productId: null }], false, CATALOG), 'unsure');
});

Deno.test('there is no name match: a product called "Premium Support" is foreign', () => {
  assertEquals(classifySubscriptionItems([{ priceId: 'price_x', productId: 'prod_premium_support' }], false, CATALOG), 'foreign');
});

// --- building the catalog ---

Deno.test('the catalog is the configured prices, their products and the legacy list', async () => {
  const asked: string[] = [];
  const catalog = await buildCwCatalog(
    (priceId) => { asked.push(priceId); return Promise.resolve(priceId.startsWith('price_b') ? 'prod_basic' : 'prod_premium'); },
    envOf({ ...FULL_ENV, STRIPE_CW_LEGACY_PRODUCT_IDS: ' prod_old , ,not-a-product,prod_older' }),
  );
  assertEquals(asked.sort(), ['price_bm', 'price_by', 'price_pm', 'price_py']);
  assertEquals([...catalog!.priceIds].sort(), ['price_bm', 'price_by', 'price_pm', 'price_py']);
  assertEquals([...catalog!.productIds].sort(), ['prod_basic', 'prod_old', 'prod_older', 'prod_premium']);
});

Deno.test('the legacy list keeps product ids only', () => {
  assertEquals(legacyCwProductIds(envOf({})), []);
  assertEquals(legacyCwProductIds(envOf({ STRIPE_CW_LEGACY_PRODUCT_IDS: 'Premium,prod_a' })), ['prod_a']);
});

Deno.test('a missing price env var: no catalog, and delete-account aborts', async () => {
  for (const missing of Object.keys(FULL_ENV)) {
    const env = { ...FULL_ENV };
    delete env[missing];
    assertEquals(await buildCwCatalog(() => Promise.resolve('prod_x'), envOf(env)), null, missing);
    await assertRejects(
      () => requireCwCatalog(() => Promise.resolve('prod_x'), envOf(env)),
      Error,
      'Stripe catalog not configured',
    );
  }
});

// --- the webhook's foreign-product skip ---

function skipInput(overrides: Partial<ForeignProductSkipInput>) {
  const calls = { mapped: 0, catalog: 0 };
  const input: ForeignProductSkipInput = {
    refs: { items: [FOREIGN], hasMore: false },
    configuredPriceIds: ['price_cw'],
    isMapped: () => { calls.mapped++; return Promise.resolve(false); },
    loadCatalog: () => { calls.catalog++; return Promise.resolve(CATALOG); },
    ...overrides,
  };
  return { input, calls };
}

Deno.test('a foreign renewal on an unmapped customer is skipped', async () => {
  const { input } = skipInput({});
  assertEquals(await shouldSkipAsForeignProduct(input), true);
});

Deno.test('a CreativeWriter event still flows through, without a database read or a Stripe call', async () => {
  const { input, calls } = skipInput({ refs: { items: [CW], hasMore: false } });
  assertEquals(await shouldSkipAsForeignProduct(input), false);
  assertEquals(calls, { mapped: 0, catalog: 0 });
});

Deno.test('an older CreativeWriter price on our product flows through', async () => {
  const { input } = skipInput({ refs: { items: [OLD_CW_PRICE], hasMore: false } });
  assertEquals(await shouldSkipAsForeignProduct(input), false);
});

Deno.test('a mapped customer keeps today\'s path, so an unlisted legacy price still syncs', async () => {
  const { input, calls } = skipInput({ isMapped: () => Promise.resolve(true) });
  assertEquals(await shouldSkipAsForeignProduct(input), false);
  assertEquals(calls.catalog, 0);
});

Deno.test('never skipped when unsure: mixed, truncated, no items, or an event without items', async () => {
  for (const refs of [
    { items: [CW, FOREIGN], hasMore: false },
    { items: [FOREIGN], hasMore: true },
    { items: [], hasMore: false },
    null,
  ]) {
    const { input } = skipInput({ refs });
    assertEquals(await shouldSkipAsForeignProduct(input), false, JSON.stringify(refs));
  }
});

Deno.test('never skipped when the configuration or the catalog is missing', async () => {
  assertEquals(await shouldSkipAsForeignProduct(skipInput({ configuredPriceIds: null }).input), false);
  assertEquals(await shouldSkipAsForeignProduct(skipInput({ loadCatalog: () => Promise.resolve(null) }).input), false);
  assertEquals(
    await shouldSkipAsForeignProduct(skipInput({ loadCatalog: () => Promise.reject(new Error('stripe down')) }).input),
    false,
  );
});

// --- what a webhook event carries ---

Deno.test('event items: a subscription\'s items, an invoice\'s lines, nothing for a checkout', () => {
  const sub = {
    type: 'customer.subscription.updated',
    data: { object: { items: { has_more: false, data: [{ price: { id: 'price_cw', product: 'prod_cw' } }] } } },
  } as unknown as Stripe.Event;
  assertEquals(eventItemRefs(sub), { items: [{ priceId: 'price_cw', productId: 'prod_cw' }], hasMore: false });

  const invoice = {
    type: 'invoice.paid',
    data: { object: { lines: { has_more: true, data: [{ price: { id: 'price_x', product: { id: 'prod_x' } } }, { price: null }] } } },
  } as unknown as Stripe.Event;
  assertEquals(eventItemRefs(invoice), {
    items: [{ priceId: 'price_x', productId: 'prod_x' }, { priceId: null, productId: null }],
    hasMore: true,
  });

  const checkout = { type: 'checkout.session.completed', data: { object: {} } } as unknown as Stripe.Event;
  assertEquals(eventItemRefs(checkout), null);
});

Deno.test('a failed mapping read is never taken for "unmapped"', async () => {
  const { input, calls } = skipInput({ isMapped: () => Promise.reject(new Error('db down')) });
  assertEquals(await shouldSkipAsForeignProduct(input), false);
  assertEquals(calls.catalog, 0);
});

Deno.test('an invoice line whose price this API version cannot read is not skipped', async () => {
  // A webhook endpoint on a newer API version moves `lines.data[].price`; the line then reads as
  // no price at all, which must not count as another product's.
  const { input } = skipInput({ refs: { items: [{ priceId: null, productId: null }], hasMore: false } });
  assertEquals(await shouldSkipAsForeignProduct(input), false);
});
