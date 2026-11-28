import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

/** Ceiling on audit rows read per ownership lookup; far above any real account. */
const OWNERSHIP_AUDIT_ROW_CAP = 1000;

/**
 * Of `customerIds`, those that belong to an account OTHER than `userId`: by that account's
 * `stripe_customers` row, or by its own webhook history in `audit_log`. The second matters
 * because a superseded customer of theirs has no mapping row, yet its events carry their id.
 *
 * Used by delete-account (never cancel another account's billing) and the Pricing Table's
 * customer session (never attach a checkout to another account's customer). Rejects on a failed
 * read; each caller decides what that means.
 *
 * The audit_log filter on `metadata->>stripe_customer_id` has no index, so it is a sequential
 * scan. Both callers run it only after a Stripe email match, with a handful of ids, which keeps
 * it rare; an index belongs here if that changes.
 */
export async function customersOwnedByOtherUsers(
  supabase: SupabaseClient,
  userId: string,
  customerIds: string[],
): Promise<Set<string>> {
  if (customerIds.length === 0) return new Set();
  const [mapped, audited] = await Promise.all([
    supabase
      .from('stripe_customers')
      .select('stripe_customer_id')
      .in('stripe_customer_id', customerIds)
      .neq('user_id', userId),
    supabase
      .from('audit_log')
      .select('customer:metadata->>stripe_customer_id')
      .in('metadata->>stripe_customer_id', customerIds)
      .not('user_id', 'is', null)
      .neq('user_id', userId)
      .limit(OWNERSHIP_AUDIT_ROW_CAP),
  ]);
  if (mapped.error) throw new Error(`Ownership lookup failed: ${mapped.error.message}`);
  if (audited.error) throw new Error(`Ownership lookup failed: ${audited.error.message}`);
  return new Set<string>([
    ...(mapped.data ?? []).map(r => (r as { stripe_customer_id: string }).stripe_customer_id),
    ...(audited.data ?? [])
      .map(r => (r as { customer?: unknown }).customer)
      .filter((id): id is string => typeof id === 'string'),
  ]);
}
