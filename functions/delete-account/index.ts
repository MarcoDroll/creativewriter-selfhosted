import { corsHeaders, handleCorsPreflightIfNeeded, jsonResponse } from '../_shared/cors.ts';
import { extractAuthFromRequest } from '../_shared/auth.ts';
import { getAdminClient } from '../_shared/supabase-admin.ts';
import { getClientIp } from '../_shared/audit.ts';
import { rateLimitResponse } from '../_shared/rate-limit.ts';
import { STORAGE_BUCKET_STORY_MEDIA, STORAGE_BUCKET_USER_BACKGROUNDS } from '../_shared/storage.ts';
import type { ErrorResponse } from '../_shared/types.ts';
import { cancelAndDeleteAllCustomers } from './stripe-cleanup.ts';

/**
 * Account Deletion Edge Function
 *
 * Handles GDPR-compliant account deletion:
 * 1. Authenticates the user
 * 2. Cancels live Stripe subscriptions and deletes every Stripe customer of the account (stripe-cleanup.ts)
 * 3. Deletes all storage files (story-media, user-backgrounds)
 * 4. Awaits an audit event (user_id will be SET NULL by FK cascade)
 * 5. Deletes the auth user (triggers DB cascade on all user tables)
 */

/** Ceiling on audit rows read per lookup; far above any real account. */
const AUDIT_ROW_CAP = 1000;

function redactEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local[0]}***@${domain}`;
}

/**
 * Cancel and delete every Stripe customer of the account — the mapped one and any
 * other a re-purchase left behind (hosted#698). The rules live in stripe-cleanup.ts;
 * this only supplies the database reads and the Stripe client.
 */
async function cancelStripeAndDeleteCustomers(userId: string, email: string): Promise<void> {
  const stripeApiKey = Deno.env.get('STRIPE_API_KEY');
  if (!stripeApiKey) return;

  const supabase = getAdminClient();

  const [{ data: mapping }, { data: auditRows, error: auditError }] = await Promise.all([
    supabase
      .from('stripe_customers')
      .select('stripe_customer_id, email')
      .eq('user_id', userId)
      .maybeSingle(),
    supabase
      .from('audit_log')
      .select('customer:metadata->>stripe_customer_id')
      .eq('user_id', userId)
      .not('metadata->>stripe_customer_id', 'is', null)
      // Newest first, so a cap cuts the oldest ids — the ones the email and
      // mapping sources most likely cover anyway. Prod's busiest user has 26 rows.
      .order('created_at', { ascending: false })
      .limit(AUDIT_ROW_CAP),
  ]);
  if (auditError) {
    // Fail the deletion rather than miss a customer that may still bill.
    throw new Error(`Audit lookup failed: ${auditError.message}`);
  }
  if ((auditRows?.length ?? 0) >= AUDIT_ROW_CAP) {
    console.warn(JSON.stringify({ level: 'warn', reason: 'delete_account_audit_cap_reached', userId }));
  }

  const auditCustomerIds = [...new Set(
    (auditRows ?? [])
      .map(r => (r as { customer?: unknown }).customer)
      .filter((id): id is string => typeof id === 'string' && id.startsWith('cus_')),
  )];

  const { default: Stripe } = await import('npm:stripe@17');
  // Calls run one after another, so bound each: a hung request must not eat the
  // function's wall clock before the storage and auth steps run.
  const stripe = new Stripe(stripeApiKey, { apiVersion: '2025-02-24.acacia', timeout: 15_000, maxNetworkRetries: 1 });

  const result = await cancelAndDeleteAllCustomers({
    mappedCustomerId: mapping?.stripe_customer_id ?? null,
    auditCustomerIds,
    emails: [email.toLowerCase(), email, mapping?.email ?? ''],
    // Another user's mapping row, or another user's webhook history: a superseded
    // customer of theirs has no mapping row, but its events carry their user id.
    ownedByOtherUsers: async (ids) => {
      const [mapped, audited] = await Promise.all([
        supabase
          .from('stripe_customers')
          .select('stripe_customer_id')
          .in('stripe_customer_id', ids)
          .neq('user_id', userId),
        supabase
          .from('audit_log')
          .select('customer:metadata->>stripe_customer_id')
          .in('metadata->>stripe_customer_id', ids)
          .not('user_id', 'is', null)
          .neq('user_id', userId)
          .limit(AUDIT_ROW_CAP),
      ]);
      if (mapped.error) throw new Error(`Ownership lookup failed: ${mapped.error.message}`);
      if (audited.error) throw new Error(`Ownership lookup failed: ${audited.error.message}`);
      return new Set<string>([
        ...(mapped.data ?? []).map(r => r.stripe_customer_id as string),
        ...(audited.data ?? [])
          .map(r => (r as { customer?: unknown }).customer)
          .filter((id): id is string => typeof id === 'string'),
      ]);
    },
    stripe: {
      // Stripe's email filter is exact and case-sensitive, hence the casings the caller passes.
      listCustomerIdsByEmail: async (address) =>
        (await stripe.customers.list({ email: address, limit: 100 }).autoPagingToArray({ limit: 1000 }))
          .map(c => c.id),
      customerExists: async (id) => {
        try {
          const customer = await stripe.customers.retrieve(id);
          return !('deleted' in customer && customer.deleted);
        } catch (err) {
          if ((err as { code?: string }).code === 'resource_missing') return false;
          throw err;
        }
      },
      listSubscriptions: async (id) =>
        (await stripe.subscriptions.list({ customer: id, status: 'all', limit: 100 }).autoPagingToArray({ limit: 1000 }))
          .map(s => ({ id: s.id, status: s.status })),
      cancelSubscription: async (id) => {
        await stripe.subscriptions.cancel(id, { prorate: true });
        console.log(`[DeleteAccount] Cancelled subscription ${id}`);
      },
      // Deleting the customer removes the PII Stripe holds.
      deleteCustomer: async (id) => {
        await stripe.customers.del(id);
        console.log(`[DeleteAccount] Deleted Stripe customer ${id}`);
      },
    },
  });

  if (result.skippedForeignCustomerIds.length > 0) {
    console.warn(JSON.stringify({
      level: 'warn',
      reason: 'delete_account_foreign_customer_skipped',
      userId,
      customerIds: result.skippedForeignCustomerIds,
    }));
  }
}

async function deleteStorageFiles(userId: string): Promise<string[]> {
  const supabase = getAdminClient();
  const failedPaths: string[] = [];

  const [images, videos, backgrounds, stories] = await Promise.all([
    supabase.from('story_images').select('storage_path').eq('user_id', userId),
    supabase.from('story_videos').select('storage_path').eq('user_id', userId),
    supabase.from('custom_backgrounds').select('storage_path').eq('user_id', userId),
    // Cover gallery objects are referenced by path inside the cover_gallery jsonb,
    // invisible to the story_images/story_videos tables — collect them explicitly.
    supabase.from('stories').select('cover_gallery').eq('user_id', userId),
  ]);

  // Cover gallery paths: [{ id, path, thumbPath?, source, createdAt }] per story.
  //
  // **Both paths.** Since 00071 each cover has a card-sized copy beside it, and missing it here is
  // not an ordinary leak that the janitor drains later:
  // `find_orphaned_cover_objects` is scoped to `auth.uid()`, so once this account is gone no
  // caller can ever reclaim its objects. They would sit in the bucket forever.
  const coverPaths: string[] = [];
  for (const row of (stories.data ?? [])) {
    const gallery = (row as { cover_gallery?: unknown }).cover_gallery;
    if (Array.isArray(gallery)) {
      for (const item of gallery) {
        const entry = item as { path?: unknown; thumbPath?: unknown };
        if (typeof entry?.path === 'string' && entry.path) coverPaths.push(entry.path);
        if (typeof entry?.thumbPath === 'string' && entry.thumbPath) coverPaths.push(entry.thumbPath);
      }
    }
  }

  // Delete from story-media bucket
  const mediaPaths = [
    ...(images.data?.map(r => r.storage_path).filter(Boolean) ?? []),
    ...(videos.data?.map(r => r.storage_path).filter(Boolean) ?? []),
    ...coverPaths,
  ];

  if (mediaPaths.length > 0) {
    const chunkSize = 100;
    for (let i = 0; i < mediaPaths.length; i += chunkSize) {
      const chunk = mediaPaths.slice(i, i + chunkSize);
      const { error } = await supabase.storage.from(STORAGE_BUCKET_STORY_MEDIA).remove(chunk);
      if (error) {
        console.error('[DeleteAccount] Error deleting story-media chunk:', error.message);
        failedPaths.push(...chunk);
      }
    }
    console.log(`[DeleteAccount] Processed ${mediaPaths.length} files from story-media`);
  }

  // Delete from user-backgrounds bucket
  const bgPaths = backgrounds.data?.map(r => r.storage_path).filter(Boolean) ?? [];

  if (bgPaths.length > 0) {
    const { error } = await supabase.storage.from(STORAGE_BUCKET_USER_BACKGROUNDS).remove(bgPaths);
    if (error) {
      console.error('[DeleteAccount] Error deleting user-backgrounds:', error.message);
      failedPaths.push(...bgPaths);
    }
    console.log(`[DeleteAccount] Processed ${bgPaths.length} files from user-backgrounds`);
  }

  return failedPaths;
}

async function awaitAuditEvent(
  eventType: string,
  metadata: Record<string, unknown>,
  options: { userId?: string; request?: Request },
): Promise<void> {
  const ip = options.request ? getClientIp(options.request) : null;
  const { error } = await getAdminClient().rpc('log_audit_event', {
    p_user_id: options.userId || null,
    p_event_type: eventType,
    p_metadata: metadata,
    p_ip_address: ip,
  });
  if (error) {
    console.error(`[DeleteAccount] Audit log failed for ${eventType}:`, error.message);
  }
}

async function deleteAuthUser(userId: string): Promise<void> {
  const supabase = getAdminClient();
  const { error } = await supabase.auth.admin.deleteUser(userId);
  if (error) {
    throw new Error(`Auth user deletion failed: ${error.message}`);
  }
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get('Origin') || '';
  const headers = corsHeaders(origin);

  const preflight = handleCorsPreflightIfNeeded(request, headers);
  if (preflight) return preflight;

  if (request.method !== 'POST') {
    return jsonResponse<ErrorResponse>({ error: 'Method not allowed' }, 405, headers);
  }

  // Strict rate limit: 3 requests per minute
  const rl = rateLimitResponse(request, headers, 3, 60_000, 'delete-account');
  if (rl) return rl;

  // Authenticate
  const authResult = await extractAuthFromRequest(request, headers);
  if (authResult instanceof Response) return authResult;
  const { userId, email } = authResult;

  const redacted = redactEmail(email);
  console.log(`[DeleteAccount] Starting for user ${redacted} (${userId})`);

  const completedSteps: string[] = [];

  try {
    // 1. Cancel Stripe subscriptions and delete customer (must happen before DB cascade)
    await cancelStripeAndDeleteCustomers(userId, email);
    completedSteps.push('stripe');

    // 2. Delete storage files (must happen before DB cascade removes metadata rows)
    const failedPaths = await deleteStorageFiles(userId);
    completedSteps.push('storage');

    // 3. Await audit event BEFORE deleting user (FK will SET NULL the user_id)
    const auditMetadata: Record<string, unknown> = { email };
    if (failedPaths.length > 0) {
      auditMetadata.orphaned_storage_paths = failedPaths;
    }
    await awaitAuditEvent('account_deletion', auditMetadata, { userId, request });
    completedSteps.push('audit');

    // 4. Delete auth user — triggers CASCADE on all user data tables
    await deleteAuthUser(userId);
    completedSteps.push('auth');

    console.log(`[DeleteAccount] Completed for ${redacted}`);

    return jsonResponse({ success: true }, 200, headers);
  } catch (error) {
    const errorMessage = (error as Error).message || 'Unknown error';
    console.error(`[DeleteAccount] Failed for ${redacted}:`, errorMessage);

    // Log failure with completed steps for support investigation
    await awaitAuditEvent(
      'account_deletion.failed',
      { email, error: errorMessage, completed_steps: completedSteps },
      { userId, request },
    );

    return jsonResponse<ErrorResponse>(
      { error: 'Account deletion failed. Please contact support.' },
      500,
      headers,
    );
  }
});
