/**
 * Stripe side of account deletion: cancel and delete EVERY Stripe customer that
 * belongs to the account, not only the one `stripe_customers` maps (hosted#698).
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
 * Stripe's email filter is exact and case-sensitive: a customer stored under another
 * casing of the address is found only through the mapping or audit_log.
 *
 * The mapped customer is handled first. Each cancellation fires a webhook, and while
 * the mapped one is still active, an event for a duplicate reads as a second customer
 * billing an entitled user (`webhook.superseded_customer_skipped`) — an operator
 * alert for something this function is already cleaning up.
 *
 * Kept free of the Stripe SDK and the admin client so it can be unit-tested: the
 * caller passes the narrow ports below.
 */

export interface StripeCleanupPort {
  /** Customers whose email is exactly `email` (Stripe's filter is case-sensitive). */
  listCustomerIdsByEmail(email: string): Promise<string[]>;
  /** `false` when the customer is already deleted or does not exist. */
  customerExists(customerId: string): Promise<boolean>;
  listSubscriptions(customerId: string): Promise<{ id: string; status: string }[]>;
  cancelSubscription(subscriptionId: string): Promise<void>;
  deleteCustomer(customerId: string): Promise<void>;
}

export interface StripeCleanupInput {
  mappedCustomerId: string | null;
  /** Customer ids `audit_log` attributes to this user. */
  auditCustomerIds: readonly string[];
  /** The auth email, and the mapping's email when it differs. */
  emails: readonly string[];
  /** Of the given ids, those the mapping assigns to another user. */
  ownedByOtherUsers(customerIds: string[]): Promise<Set<string>>;
  stripe: StripeCleanupPort;
}

export interface StripeCleanupResult {
  deletedCustomerIds: string[];
  cancelledSubscriptionIds: string[];
  /** Email matches skipped because another account's mapping names them. */
  skippedForeignCustomerIds: string[];
}

/**
 * Statuses that can still charge or be revived by a payment. `incomplete` is
 * included: its first invoice can still be paid within the day it lives.
 */
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused']);

export function isLiveSubscriptionStatus(status: string): boolean {
  return LIVE_STATUSES.has(status);
}

/**
 * Cancels every live subscription on every customer of the account, then deletes
 * those customers (which removes the PII Stripe holds). Throws on the first
 * Stripe failure, so the caller aborts the deletion rather than deleting an account
 * that something may still bill.
 */
export async function cancelAndDeleteAllCustomers(input: StripeCleanupInput): Promise<StripeCleanupResult> {
  const { stripe } = input;

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
  };

  for (const customerId of candidates) {
    // Audit ids can name a customer deleted long ago; email matches never do.
    if (!byEmail.has(customerId) && !(await stripe.customerExists(customerId))) continue;

    for (const sub of await stripe.listSubscriptions(customerId)) {
      if (!isLiveSubscriptionStatus(sub.status)) continue;
      await stripe.cancelSubscription(sub.id);
      result.cancelledSubscriptionIds.push(sub.id);
    }
    await stripe.deleteCustomer(customerId);
    result.deletedCustomerIds.push(customerId);
  }

  return result;
}
