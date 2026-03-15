import { corsHeaders, handleCorsPreflightIfNeeded, jsonResponse } from '../_shared/cors.ts';
import { extractAuthFromRequest } from '../_shared/auth.ts';
import { getAdminClient } from '../_shared/supabase-admin.ts';
import { getClientIp } from '../_shared/audit.ts';
import { rateLimitResponse } from '../_shared/rate-limit.ts';
import type { ErrorResponse } from '../_shared/types.ts';

/**
 * Account Deletion Edge Function
 *
 * Handles GDPR-compliant account deletion:
 * 1. Authenticates the user
 * 2. Cancels any active Stripe subscriptions and deletes the Stripe customer
 * 3. Deletes all storage files (story-media, user-backgrounds)
 * 4. Awaits an audit event (user_id will be SET NULL by FK cascade)
 * 5. Deletes the auth user (triggers DB cascade on all user tables)
 */

function redactEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local[0]}***@${domain}`;
}

async function cancelStripeAndDeleteCustomer(userId: string): Promise<void> {
  const stripeApiKey = Deno.env.get('STRIPE_API_KEY');
  if (!stripeApiKey) return;

  const supabase = getAdminClient();

  const { data: customer } = await supabase
    .from('stripe_customers')
    .select('stripe_customer_id')
    .eq('user_id', userId)
    .maybeSingle();

  if (!customer?.stripe_customer_id) return;

  const { default: Stripe } = await import('npm:stripe@17');
  const stripe = new Stripe(stripeApiKey, { apiVersion: '2025-02-24.acacia' });

  // Cancel all active/trialing subscriptions
  const subscriptions = await stripe.subscriptions.list({
    customer: customer.stripe_customer_id,
    status: 'all',
    limit: 100,
  });

  for (const sub of subscriptions.data) {
    if (sub.status === 'active' || sub.status === 'trialing' || sub.status === 'past_due') {
      await stripe.subscriptions.cancel(sub.id, { prorate: true });
      console.log(`[DeleteAccount] Cancelled subscription ${sub.id}`);
    }
  }

  // Delete the Stripe customer to remove PII from Stripe
  await stripe.customers.del(customer.stripe_customer_id);
  console.log(`[DeleteAccount] Deleted Stripe customer ${customer.stripe_customer_id}`);
}

async function deleteStorageFiles(userId: string): Promise<string[]> {
  const supabase = getAdminClient();
  const failedPaths: string[] = [];

  const [images, videos, backgrounds] = await Promise.all([
    supabase.from('story_images').select('storage_path').eq('user_id', userId),
    supabase.from('story_videos').select('storage_path').eq('user_id', userId),
    supabase.from('custom_backgrounds').select('storage_path').eq('user_id', userId),
  ]);

  // Delete from story-media bucket
  const mediaPaths = [
    ...(images.data?.map(r => r.storage_path).filter(Boolean) ?? []),
    ...(videos.data?.map(r => r.storage_path).filter(Boolean) ?? []),
  ];

  if (mediaPaths.length > 0) {
    const chunkSize = 100;
    for (let i = 0; i < mediaPaths.length; i += chunkSize) {
      const chunk = mediaPaths.slice(i, i + chunkSize);
      const { error } = await supabase.storage.from('story-media').remove(chunk);
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
    const { error } = await supabase.storage.from('user-backgrounds').remove(bgPaths);
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
    await cancelStripeAndDeleteCustomer(userId);
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
