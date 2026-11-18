/**
 * Stripe side of account deletion: end the account's CreativeWriter billing on EVERY
 * Stripe customer that belongs to it, not only the one `stripe_customers` maps
 * (hosted#698) — and touch nothing else, because the Stripe account bills other
 * products too.
 *
 * `stripe_customers` holds one customer per user, but the Pricing Table creates a
 * new customer on every checkout, so an author who bought twice has a customer the
 * mapping no longer names (public#65 ended with four). Cancelling only the mapped
 * one left any other subscription billing someone who no longer has an account.
 *
 * Candidates come from three places, because none of them is complete alone:
 * - the mapping row;
 * - `audit_log`: webhook events record the customer with the user id, including
 *   `webhook.superseded_customer_skipped` for a customer the mapping never named;
 * - Stripe customers carrying the account's email. The Pricing Table locks
 *   `customer-email` to the auth email, so a re-purchase lands here even when no
 *   webhook was ever attributed to the user.
 *
 * An email match can name someone else's customer (another account that typed this
 * address at checkout), and an audit id can name one that was relinked since. So any
 * candidate the caller attributes to a DIFFERENT user — by their mapping row or by
 * their own webhook history — is left alone.
 *
 * **Three outcomes per subscription** (`classifySubscriptionItems`, `_shared/stripe-catalog.ts`):
 * - CreativeWriter's: cancelled when live.
 * - Foreign: never touched.
 * - Unsure (mixed items, or a list Stripe truncated): never touched, and reported for
 *   review. A live foreign subscription on the MAPPED customer is reported too, since
 *   it may be a legacy CreativeWriter price nobody listed — an operator decides.
 *
 * **A customer is deleted only when nothing live on it is foreign or unsure**, because
 * `customers.del` cancels every subscription the customer has. A customer the mapping or
 * audit_log attributes to the user is deleted under that rule alone. An email-only match
 * is deleted only when it has had a CreativeWriter subscription (any status) and has no
 * `open` or `draft` invoice; any other email-only match is left as it is. Every kept
 * customer is reported with its reason. A kept customer still carries the email, so a
 * later sign-up with the address can map to it through `get_user_id_by_email`; that is
 * accepted, and its foreign renewals are dropped by the webhook
 * (`webhook.foreign_product_skipped`) instead of alerting as orphans.
 *
 * Every subscription is read before anything is cancelled, so the decisions do not
 * depend on the webhooks the first cancellations set off. A retry after a partial run
 * re-reads Stripe: what was cancelled is no longer live and is not cancelled twice.
 *
 * Stripe's email filter is exact and case-sensitive: a customer stored under another
 * casing of the address is found only through the mapping or audit_log. (The auth
 * email is already lower-case — `_shared/auth.ts` normalises it.)
 *
 * The mapped customer is handled first. Each cancellation fires a webhook, and while
 * the mapped one is still active, an event for a duplicate reads as a second customer
 * billing an entitled user (`webhook.superseded_customer_skipped`) — an operator
 * alert for something this function is already cleaning up.
 *
 * Kept free of the Stripe SDK and the admin client so it can be unit-tested: the
 * caller passes the narrow ports below.
 */

import { classifySubscriptionItems, type CwCatalog, type SubscriptionItemRef } from '../_shared/stripe-catalog.ts';

export interface CleanupSubscription {
  id: string;
  status: string;
  items: SubscriptionItemRef[];
  /** Stripe's `items.has_more`: the list above is not the whole subscription. */
  itemsHasMore: boolean;
}

export interface StripeCleanupPort {
  /** Customers whose email is exactly `email` (Stripe's filter is case-sensitive). */
  listCustomerIdsByEmail(email: string): Promise<string[]>;
  /** `false` when the customer is already deleted or does not exist. */
  customerExists(customerId: string): Promise<boolean>;
  /** Every subscription, any status. */
  listSubscriptions(customerId: string): Promise<CleanupSubscription[]>;
  cancelSubscription(subscriptionId: string): Promise<void>;
  deleteCustomer(customerId: string): Promise<void>;
  /** Whether the customer has an `open` or `draft` invoice. */
  hasOpenOrDraftInvoice(customerId: string): Promise<boolean>;
}

export interface StripeCleanupInput {
  mappedCustomerId: string | null;
  /** Customer ids `audit_log` attributes to this user. */
  auditCustomerIds: readonly string[];
  /** The auth email, and the mapping's email when it differs. */
  emails: readonly string[];
  /** Of the given ids, those the mapping or audit_log assigns to another user. */
  ownedByOtherUsers(customerIds: string[]): Promise<Set<string>>;
  /** CreativeWriter's prices and products. The caller refuses to run without one. */
  catalog: CwCatalog;
  stripe: StripeCleanupPort;
}

export type KeptCustomerReason =
  | 'live_subscription_not_ours'
  | 'email_match_without_creativewriter_history'
  | 'open_or_draft_invoice';

export type ReviewReason =
  | 'mixed_items'
  | 'items_truncated'
  | 'items_unreadable'
  | 'unknown_product_on_mapped_customer';

export interface StripeCleanupResult {
  deletedCustomerIds: string[];
  cancelledSubscriptionIds: string[];
  /** Candidates skipped because another account's mapping or webhook history names them. */
  skippedForeignCustomerIds: string[];
  /** Customers left in Stripe, and why. */
  keptCustomers: { customerId: string; reason: KeptCustomerReason }[];
  /** Live subscriptions nobody may cancel automatically. The caller raises an operator alert. */
  needsReview: { customerId: string; subscriptionId: string; reason: ReviewReason }[];
}

/**
 * Statuses that can still charge or be revived by a payment. `incomplete` is
 * included: its first invoice can still be paid within the day it lives.
 */
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused']);

export function isLiveSubscriptionStatus(status: string): boolean {
  return LIVE_STATUSES.has(status);
}

interface CustomerPlan {
  customerId: string;
  toCancel: string[];
  /** Delete after cancelling, subject to the invoice check when `needsInvoiceCheck`. */
  deletable: boolean;
  needsInvoiceCheck: boolean;
  keptReason?: KeptCustomerReason;
}

/**
 * Cancels the account's live CreativeWriter subscriptions on every customer of the
 * account, then deletes the customers nothing else needs (which removes the PII Stripe
 * holds). Throws on the first Stripe failure, so the caller aborts the deletion rather
 * than deleting an account that something may still bill.
 */
export async function cancelAndDeleteAllCustomers(input: StripeCleanupInput): Promise<StripeCleanupResult> {
  const { stripe, catalog } = input;

  const byEmail = new Set<string>();
  for (const email of new Set(input.emails.filter(Boolean))) {
    for (const id of await stripe.listCustomerIdsByEmail(email)) byEmail.add(id);
  }

  const known = new Set<string>(input.auditCustomerIds);
  if (input.mappedCustomerId) known.add(input.mappedCustomerId);

  // The mapping is authoritative for its own row; only email matches can be foreign.
  // An audit id that is now mapped elsewhere is foreign as well.
  const toCheck = [...new Set([...byEmail, ...known])].filter(id => id !== input.mappedCustomerId);
  const foreign = toCheck.length > 0 ? await input.ownedByOtherUsers(toCheck) : new Set<string>();

  const others = [...new Set([...known, ...byEmail])].filter(id => id !== input.mappedCustomerId && !foreign.has(id));
  const candidates = input.mappedCustomerId ? [input.mappedCustomerId, ...others] : others;

  const result: StripeCleanupResult = {
    deletedCustomerIds: [],
    cancelledSubscriptionIds: [],
    skippedForeignCustomerIds: [...foreign],
    keptCustomers: [],
    needsReview: [],
  };

  // Phase 1: read everything and decide, before any write.
  const plans: CustomerPlan[] = [];
  for (const customerId of candidates) {
    // Audit ids can name a customer deleted long ago; email matches never do.
    if (!byEmail.has(customerId) && !(await stripe.customerExists(customerId))) continue;

    const isMapped = customerId === input.mappedCustomerId;
    const emailOnly = !known.has(customerId);
    const subscriptions = await stripe.listSubscriptions(customerId);

    const toCancel: string[] = [];
    let blocked = false;
    let hasCreativeWriterHistory = false;
    for (const sub of subscriptions) {
      const kind = classifySubscriptionItems(sub.items, sub.itemsHasMore, catalog);
      const live = isLiveSubscriptionStatus(sub.status);
      if (kind === 'creativewriter') {
        hasCreativeWriterHistory = true;
        if (live) toCancel.push(sub.id);
        continue;
      }
      if (!live) continue;
      blocked = true;
      if (kind === 'unsure') {
        result.needsReview.push({
          customerId,
          subscriptionId: sub.id,
          reason: sub.itemsHasMore
            ? 'items_truncated'
            : sub.items.length === 0 || sub.items.some(i => i.priceId === null && i.productId === null)
              ? 'items_unreadable'
              : 'mixed_items',
        });
      } else if (isMapped) {
        result.needsReview.push({ customerId, subscriptionId: sub.id, reason: 'unknown_product_on_mapped_customer' });
      }
    }

    if (emailOnly && !hasCreativeWriterHistory) {
      // Not ours to judge: leave it exactly as it is.
      plans.push({
        customerId, toCancel: [], deletable: false, needsInvoiceCheck: false,
        keptReason: 'email_match_without_creativewriter_history',
      });
      continue;
    }
    plans.push({
      customerId,
      toCancel,
      deletable: !blocked,
      needsInvoiceCheck: emailOnly,
      keptReason: blocked ? 'live_subscription_not_ours' : undefined,
    });
  }

  // Phase 2: act, the mapped customer first.
  for (const plan of plans) {
    for (const id of plan.toCancel) {
      await stripe.cancelSubscription(id);
      result.cancelledSubscriptionIds.push(id);
    }
    let keptReason = plan.keptReason;
    if (plan.deletable && plan.needsInvoiceCheck && (await stripe.hasOpenOrDraftInvoice(plan.customerId))) {
      keptReason = 'open_or_draft_invoice';
    }
    if (plan.deletable && keptReason === undefined) {
      await stripe.deleteCustomer(plan.customerId);
      result.deletedCustomerIds.push(plan.customerId);
    } else if (keptReason) {
      result.keptCustomers.push({ customerId: plan.customerId, reason: keptReason });
    }
  }

  return result;
}
