/**
 * The priced items on a Stripe subscription or webhook event, as `stripe-catalog.ts` reads them.
 * The SDK import is type-only, so delete-account can use this without loading Stripe at boot.
 */
import type Stripe from 'npm:stripe@17';
import type { SubscriptionItemRef } from './stripe-catalog.ts';

function itemRef(price: Stripe.Price | null | undefined): SubscriptionItemRef {
  if (!price) return { priceId: null, productId: null };
  return {
    priceId: price.id ?? null,
    productId: typeof price.product === 'string' ? price.product : price.product?.id ?? null,
  };
}

/** A subscription's items as the catalog reads them. */
export function subscriptionItemRefs(sub: Stripe.Subscription): { items: SubscriptionItemRef[]; hasMore: boolean } {
  return { items: (sub.items?.data ?? []).map(i => itemRef(i.price)), hasMore: Boolean(sub.items?.has_more) };
}

/**
 * The priced items a webhook event carries: a subscription's items, or an invoice's lines. Null
 * for anything else (a checkout session carries none without an expand), so the caller never
 * classifies what it cannot see.
 */
export function eventItemRefs(event: Stripe.Event): { items: SubscriptionItemRef[]; hasMore: boolean } | null {
  if (event.type.startsWith('customer.subscription.')) {
    return subscriptionItemRefs(event.data.object as Stripe.Subscription);
  }
  if (event.type.startsWith('invoice.')) {
    const invoice = event.data.object as Stripe.Invoice;
    return {
      items: (invoice.lines?.data ?? []).map(l => itemRef(l.price)),
      hasMore: Boolean(invoice.lines?.has_more),
    };
  }
  return null;
}
