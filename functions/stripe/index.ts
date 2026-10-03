import Stripe from 'npm:stripe@17';
import { SignJWT } from 'npm:jose@6';
import { corsHeaders, handleCorsPreflightIfNeeded, jsonResponse } from '../_shared/cors.ts';
import { rateLimitResponse } from '../_shared/rate-limit.ts';
import { logAuditEvent } from '../_shared/audit.ts';
import { getAdminClient } from '../_shared/supabase-admin.ts';
import { extractAuthFromRequest } from '../_shared/auth.ts';
import {
  getStripe,
  getLicenseSigningKey,
  getOrCreateCustomer,
  syncStripeData,
  validateJwtAndGetSubscription,
  getConfiguredPriceIds,
  getCustomerIdByEmail,
  getCustomerIdByUserId,
  getCustomerIdByStripeId,
  saveCustomerMapping,
  requireEnv,
} from '../_shared/stripe-helpers.ts';
import type {
  ErrorResponse,
  PortalResponse,
  PriceInfo,
  PricesResponse,
  SubscriptionTier,
  VerifyResponse,
} from '../_shared/types.ts';

// --- Validation helpers ---

/** Validate a redirect URL uses http/https protocol. Returns error string or null. */
function validateRedirectUrl(value: string, field: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return `${field} must use http or https`;
    }
  } catch {
    return `${field} must be a valid URL`;
  }
  return null;
}

// --- Webhook helpers ---

/**
 * Ensure a `stripe_customers` mapping row exists for `customerId` before the
 * webhook tries to write `subscription_cache` (which has a FK on it).
 *
 * Returns true when the mapping is in place, false when no mapping could be
 * established (no email, no matching auth user, or the auth user was deleted).
 * In the false case the caller should skip syncStripeData and return 200, so
 * Stripe doesn't retry forever on something we cannot resolve automatically.
 */
async function ensureCustomerMapping(
  stripe: Stripe,
  event: Stripe.Event,
  customerId: string,
): Promise<boolean> {
  const existing = await getCustomerIdByStripeId(customerId);
  if (existing) return true;

  // Fast path: checkout.session.completed carries client_reference_id, the
  // Supabase user_id we set on the Pricing Table embed. Prefer this over the
  // email-fallback path because the user_id is authoritative, while the email
  // could match the wrong user if the Stripe customer was reused with a
  // different Supabase account.
  let userIdFromSession: string | null = null;
  let emailFromSession: string | null = null;
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    userIdFromSession = session.client_reference_id || null;
    emailFromSession = session.customer_details?.email || session.customer_email || null;
    if (userIdFromSession && emailFromSession) {
      return await saveCustomerMapping(userIdFromSession, emailFromSession, customerId);
    }
  }

  // Fallback: subscription/invoice events arriving before checkout.completed,
  // a checkout.session that didn't carry one of {client_reference_id, email},
  // or a legacy session without client_reference_id. Retrieve the Stripe
  // customer to recover the email; resolve user_id from the session if we
  // already have it, otherwise look it up by email.
  let customerEmail: string | null = emailFromSession;
  if (!customerEmail) {
    try {
      const customer = await stripe.customers.retrieve(customerId);
      if (!('deleted' in customer) || !customer.deleted) {
        customerEmail = (customer as Stripe.Customer).email;
      }
    } catch (err) {
      console.warn(JSON.stringify({
        level: 'warn',
        reason: 'orphan_customer_retrieve_failed',
        customerId,
        error: err instanceof Error ? err.message : String(err),
      }));
      return false;
    }
  }

  if (!customerEmail) {
    console.warn(JSON.stringify({ level: 'warn', reason: 'orphan_no_email', customerId }));
    return false;
  }

  let userId: string | null = userIdFromSession;
  if (!userId) {
    const { data, error } = await getAdminClient()
      .rpc('get_user_id_by_email', { p_email: customerEmail });
    if (error) {
      console.error(JSON.stringify({
        level: 'error',
        reason: 'get_user_id_by_email_failed',
        customerId,
        email: customerEmail,
        error: error.message,
      }));
      return false;
    }
    userId = data || null;
  }

  if (!userId) {
    console.warn(JSON.stringify({
      level: 'warn',
      reason: 'orphan_no_user',
      customerId,
      email: customerEmail,
    }));
    return false;
  }

  return await saveCustomerMapping(userId, customerEmail, customerId);
}

// --- Route handlers ---

async function handleWebhook(request: Request): Promise<Response> {
  // Self-hosted instances do not process Stripe webhooks. Premium unlock on
  // self-hosted is license-key only (see /stripe/license-key on the hosted
  // instance). Returning 410 short-circuits both forged events and stale
  // configurations that still point a webhook at this endpoint.
  if (Deno.env.get('SELF_HOSTED') === 'true') {
    return new Response(
      JSON.stringify({ error: 'Stripe webhooks are not supported on self-hosted; use the license-key flow at creativewriter.dev' }),
      { status: 410, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const body = await request.text();
  const signature = request.headers.get('Stripe-Signature');

  if (!signature) {
    return new Response('Missing signature', { status: 400 });
  }

  const stripe = getStripe();
  if (!stripe) {
    return new Response(JSON.stringify({ error: 'Stripe not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  let event: Stripe.Event;

  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      requireEnv('STRIPE_WEBHOOK_SECRET'),
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err);
    return new Response('Invalid signature', { status: 400 });
  }

  const subscriptionEvents = [
    'checkout.session.completed',
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'customer.subscription.paused',
    'customer.subscription.resumed',
    'invoice.paid',
    'invoice.payment_failed',
  ];

  if (subscriptionEvents.includes(event.type)) {
    const obj = event.data.object as Stripe.Subscription | Stripe.Invoice | Stripe.Checkout.Session;
    const customerId = typeof obj.customer === 'string'
      ? obj.customer
      : obj.customer?.id;

    if (customerId) {
      // Self-heal mapping before syncing so the FK on subscription_cache holds.
      // If we cannot establish a mapping (no email, no matching user, deleted
      // account), skip the sync and return 200 — there is no way the cache
      // write can succeed and we don't want infinite Stripe retries. The
      // reconcile-stripe-orphans.ts script catches these.
      const mappingOk = await ensureCustomerMapping(stripe, event, customerId);
      if (!mappingOk) {
        logAuditEvent('webhook.orphan_skipped', {
          stripe_event_id: event.id,
          stripe_customer_id: customerId,
          stripe_event_type: event.type,
        }, { request });
        return new Response(JSON.stringify({ received: true, skipped: 'orphan' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Sync subscription data — must succeed for webhook to return 200
      try {
        console.log(`Processing ${event.type} for customer ${customerId}`);
        await syncStripeData(stripe, customerId);
      } catch (err) {
        // Log structured error for Supabase Edge Function logs
        console.error(JSON.stringify({
          level: 'error',
          handler: 'webhook',
          event_type: event.type,
          event_id: event.id,
          customer_id: customerId,
          error: err instanceof Error ? err.message : String(err),
        }));

        // Audit the failure for queryable history
        logAuditEvent('webhook.processing_failed', {
          stripe_event_id: event.id,
          stripe_customer_id: customerId,
          stripe_event_type: event.type,
          error: err instanceof Error ? err.message : String(err),
        }, { request });

        // Return 500 so Stripe retries the webhook
        return new Response(JSON.stringify({ error: 'Webhook processing failed' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Audit logging — best effort, must not cause a 500/retry
      try {
        const auditTypeMap: Record<string, string> = {
          'checkout.session.completed': 'checkout.completed',
          'customer.subscription.created': 'subscription.created',
          'customer.subscription.updated': 'subscription.updated',
          'customer.subscription.deleted': 'subscription.cancelled',
          'customer.subscription.paused': 'subscription.paused',
          'customer.subscription.resumed': 'subscription.resumed',
          'invoice.paid': 'payment.succeeded',
          'invoice.payment_failed': 'payment.failed',
        };

        const auditType = auditTypeMap[event.type];
        if (auditType) {
          const { data: customerRow } = await getAdminClient()
            .from('stripe_customers')
            .select('user_id')
            .eq('stripe_customer_id', customerId)
            .maybeSingle();

          logAuditEvent(auditType, {
            stripe_event_id: event.id,
            stripe_customer_id: customerId,
            stripe_event_type: event.type,
          }, {
            userId: customerRow?.user_id || null,
            request,
          });
        }
      } catch (auditErr) {
        console.error('Non-critical: webhook audit logging failed:', auditErr);
      }
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleVerify(
  request: Request,
  headers: Record<string, string>,
): Promise<Response> {
  const validation = await validateJwtAndGetSubscription(request, headers);
  if (validation instanceof Response) return validation;

  const { valid, tier, subData } = validation;

  // Observability: one structured line per verify so support can answer
  // "what tier is this user live?" by grepping function logs for the user's
  // id/email (see the argash tier-check that logs couldn't answer). Uses
  // console.log (ephemeral function logs), NOT logAuditEvent — verify is
  // high-frequency and must not bloat the persisted audit_log table.
  console.log(JSON.stringify({
    event: 'verify.tier',
    userId: validation.userId,
    email: validation.email,
    tier: tier || 'none',
    status: subData?.status || 'none',
    plan: subData?.plan,
  }));

  return jsonResponse<VerifyResponse>(
    {
      active: valid,
      status: subData?.status || 'none',
      tier: tier || 'none',
      expiresAt: subData ? subData.currentPeriodEnd * 1000 : undefined,
      cancelAtPeriodEnd: subData?.cancelAtPeriodEnd,
      plan: subData?.plan,
      trialEnd: subData?.trialEnd ? subData.trialEnd * 1000 : undefined,
    },
    200,
    headers,
  );
}

async function handleDirectPortalSession(
  request: Request,
  headers: Record<string, string>,
): Promise<Response> {
  // Self-hosted has no Stripe customer; the Billing Portal is hosted-only.
  if (Deno.env.get('SELF_HOSTED') === 'true') {
    return jsonResponse<ErrorResponse>(
      { error: 'Billing portal is not available on self-hosted; manage your subscription at creativewriter.dev' },
      410,
      headers,
    );
  }

  const url = new URL(request.url);
  const returnUrlParam = url.searchParams.get('returnUrl');
  if (returnUrlParam) {
    const urlError = validateRedirectUrl(returnUrlParam, 'returnUrl');
    if (urlError) {
      return jsonResponse<ErrorResponse>({ error: urlError }, 400, headers);
    }
  }
  const returnUrl = returnUrlParam || requireEnv('SUCCESS_URL');

  const authResult = await extractAuthFromRequest(request, headers);
  if (authResult instanceof Response) return authResult;

  const { userId, email } = authResult;

  try {
    const stripe = getStripe();
    if (!stripe) {
      return jsonResponse<ErrorResponse>({ error: 'Stripe not configured' }, 503, headers);
    }
    const customerId = await getOrCreateCustomer(stripe, email, userId);
    const subData = await syncStripeData(stripe, customerId);

    if (subData.status !== 'active' && subData.status !== 'trialing') {
      return jsonResponse<ErrorResponse>(
        { error: 'Subscription not active' },
        403,
        headers,
      );
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });

    console.log(`[DirectPortalSession] Created session for ${email}`);
    return jsonResponse<PortalResponse>({ url: session.url }, 200, headers);
  } catch (error) {
    console.error('[DirectPortalSession] Stripe API error:', error);
    return jsonResponse<ErrorResponse>(
      { error: 'Failed to create portal session. Please try again.' },
      500,
      headers,
    );
  }
}

async function handlePortal(
  request: Request,
  headers: Record<string, string>,
): Promise<Response> {
  // Self-hosted has no Stripe customer; the Billing Portal is hosted-only.
  if (Deno.env.get('SELF_HOSTED') === 'true') {
    return jsonResponse<ErrorResponse>(
      { error: 'Billing portal is not available on self-hosted; manage your subscription at creativewriter.dev' },
      410,
      headers,
    );
  }

  const url = new URL(request.url);
  const returnUrlParam = url.searchParams.get('returnUrl');
  if (returnUrlParam) {
    const urlError = validateRedirectUrl(returnUrlParam, 'returnUrl');
    if (urlError) {
      return jsonResponse<ErrorResponse>({ error: urlError }, 400, headers);
    }
  }
  const returnUrl = returnUrlParam || requireEnv('SUCCESS_URL').replace('?subscription=success', '');

  const authResult = await extractAuthFromRequest(request, headers);
  if (authResult instanceof Response) return authResult;

  const { userId, email } = authResult;
  const stripe = getStripe();
  if (!stripe) {
    return jsonResponse<ErrorResponse>({ error: 'Stripe not configured' }, 503, headers);
  }

  let customerId = await getCustomerIdByUserId(userId);
  if (!customerId) customerId = await getCustomerIdByEmail(email);

  if (!customerId) {
    const existing = await stripe.customers.list({ email, limit: 1 });
    if (existing.data.length > 0) {
      customerId = existing.data[0].id;
      try {
        await saveCustomerMapping(userId, email, customerId);
      } catch (err) {
        console.error('[Portal] Non-critical: failed to cache customer mapping:', err);
      }
    } else {
      return jsonResponse<ErrorResponse>(
        { error: 'No subscription found. Please subscribe first.' },
        404,
        headers,
      );
    }
  }

  // Gracefully degrade if cache save fails — portal still works with Stripe API data
  let subData;
  try {
    subData = await syncStripeData(stripe, customerId);
  } catch (err) {
    console.error('[Portal] Non-critical: cache save failed, fetching from Stripe:', err);
    const subs = await stripe.subscriptions.list({ customer: customerId, limit: 1, status: 'all' });
    const sub = subs.data[0];
    subData = sub ? { status: sub.status } : { status: 'none' as const };
  }
  if (subData.status !== 'active' && subData.status !== 'trialing') {
    return jsonResponse<ErrorResponse>(
      { error: 'Your subscription is not active.' },
      403,
      headers,
    );
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });

  console.log(`[Portal] Created session for ${email}`);
  return jsonResponse<PortalResponse>({ url: session.url }, 200, headers);
}

async function handleLicenseKey(
  request: Request,
  headers: Record<string, string>,
): Promise<Response> {
  // Only available on hosted (not self-hosted)
  if (Deno.env.get('SELF_HOSTED') === 'true') {
    return jsonResponse<ErrorResponse>({ error: 'License key generation is only available on the hosted instance' }, 403, headers);
  }

  const validation = await validateJwtAndGetSubscription(request, headers);
  if (validation instanceof Response) return validation;
  // Block trial statuses: a license key is a 1-year premium grant, so it must
  // require a genuinely paid subscription. `app_trial` is our signup-date trial;
  // `trialing` is a Stripe free trial. The latter is unreachable today (checkout
  // sets no trial_period_days) but blocking it now pre-empts card-free 1-year
  // license minting if a Stripe free trial is ever enabled.
  const trialStatus = validation.subData?.status === 'app_trial' || validation.subData?.status === 'trialing';
  if (!validation.valid || trialStatus) {
    return jsonResponse<ErrorResponse>({ error: 'Active subscription required to generate a license key' }, 403, headers);
  }

  // Presence-check first so an absent key still yields the informative 503.
  // getLicenseSigningKey() returns null for BOTH absent and malformed, so we
  // keep the bare env check to distinguish "not configured" from "misconfigured".
  if (!Deno.env.get('LICENSE_SIGNING_KEY')) {
    return jsonResponse<ErrorResponse>({ error: 'License signing key not configured' }, 503, headers);
  }

  try {
    const privateKey = await getLicenseSigningKey();
    if (!privateKey) {
      // Present but malformed JSON/JWK (error already logged in loadLicenseSigningKey).
      return jsonResponse<ErrorResponse>({ error: 'Failed to generate license key' }, 500, headers);
    }

    const now = Math.floor(Date.now() / 1000);
    const oneYear = 365 * 86400;
    const expiresAt = now + oneYear;

    // All self-hosted license keys grant premium tier, regardless of the
    // subscriber's hosted tier. This is intentional: self-hosted users bring
    // their own API keys and infrastructure, so the license unlocks all
    // features except Included AI (which is hosted-only).
    const licenseKey = await new SignJWT({
      tier: 'premium',
      email: validation.email,
    })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer('creativewriter')
      .setSubject('license')
      .setAudience('creativewriter-selfhosted')
      .setIssuedAt(now)
      .setExpirationTime(expiresAt)
      .sign(privateKey);

    logAuditEvent('license_key.generated', {
      email: validation.email,
      tier: 'premium',
      expires_at: expiresAt * 1000,
    }, { request });

    return jsonResponse(
      { licenseKey, expiresAt: expiresAt * 1000, tier: 'premium' as SubscriptionTier },
      200,
      headers,
    );
  } catch (error) {
    console.error('[LicenseKey] Signing failed:', error);
    return jsonResponse<ErrorResponse>({ error: 'Failed to generate license key' }, 500, headers);
  }
}

/**
 * Public (unauthenticated) prices endpoint. Returns the amounts for the
 * configured Stripe prices so the logged-out welcome page can show real
 * numbers. Degrades to `{ prices: [] }` on self-hosted, when Stripe isn't
 * configured, or when no price IDs are set — never throws.
 */
async function handlePrices(headers: Record<string, string>): Promise<Response> {
  const pricesHeaders = { ...headers, 'Cache-Control': 'public, max-age=600' };

  if (Deno.env.get('SELF_HOSTED') === 'true') {
    return jsonResponse<PricesResponse>({ prices: [] }, 200, pricesHeaders);
  }

  // getStripe() throws on a misconfigured hosted instance (no STRIPE_API_KEY);
  // treat that like "unconfigured" and degrade to an empty list rather than 500.
  let stripe: ReturnType<typeof getStripe>;
  try {
    stripe = getStripe();
  } catch {
    stripe = null;
  }
  if (!stripe) {
    return jsonResponse<PricesResponse>({ prices: [] }, 200, pricesHeaders);
  }

  // Serve fresh in-isolate cache without hitting Stripe.
  if (pricesCache && Date.now() - pricesCache.at < PRICES_TTL_MS) {
    return jsonResponse<PricesResponse>({ prices: pricesCache.prices }, 200, pricesHeaders);
  }

  // Cold miss: de-dupe concurrent refills so a burst of requests in the
  // sub-second refill window hits Stripe once (up to 4 calls), not N×4.
  if (!pricesInFlight) {
    pricesInFlight = fetchPricesFromStripe(stripe)
      .then((prices) => {
        pricesCache = { prices, at: Date.now() };
        return prices;
      })
      .finally(() => {
        pricesInFlight = null;
      });
  }

  const prices = await pricesInFlight;
  return jsonResponse<PricesResponse>({ prices }, 200, pricesHeaders);
}

/**
 * Retrieve amounts for the configured prices from Stripe. Each retrieve is
 * wrapped in its own try/catch so a single bad ID (or missing amount/recurring)
 * is skipped rather than failing the whole batch — so this never rejects.
 */
async function fetchPricesFromStripe(stripe: Stripe): Promise<PriceInfo[]> {
  const resolved = await Promise.all(
    getConfiguredPriceIds().map(async ({ tier, cycle, priceId }): Promise<PriceInfo | null> => {
      try {
        const price = await stripe.prices.retrieve(priceId);
        if (price.unit_amount == null || !price.recurring) return null;
        return {
          tier,
          cycle,
          unitAmount: price.unit_amount,
          currency: price.currency,
          interval: price.recurring.interval === 'year' ? 'year' : 'month',
        };
      } catch (err) {
        console.warn(`[Prices] Failed to retrieve price ${priceId}:`, err instanceof Error ? err.message : String(err));
        return null;
      }
    }),
  );
  return resolved.filter((p): p is PriceInfo => p !== null);
}

// --- Main entry point ---

// In-isolate memo for the public /prices route (per-isolate, best-effort).
const PRICES_TTL_MS = 10 * 60 * 1000;
let pricesCache: { prices: PriceInfo[]; at: number } | null = null;
let pricesInFlight: Promise<PriceInfo[]> | null = null;

Deno.serve(async (request: Request) => {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin') || '';
  const headers = corsHeaders(origin);

  const preflight = handleCorsPreflightIfNeeded(request, headers);
  if (preflight) return preflight;

  const path = url.pathname.replace(/^\/stripe/, '') || '/';

  // Per-route rate limiting (webhook and read-only routes excluded)
  if (path === '/portal' || path === '/portal/session') {
    const rl = rateLimitResponse(request, headers, 10, 60_000, 'stripe:portal');
    if (rl) return rl;
  } else if (path === '/license-key') {
    const rl = rateLimitResponse(request, headers, 5, 60_000, 'stripe:license-key');
    if (rl) return rl;
  } else if (path === '/prices') {
    // Lenient cap for a public endpoint — the in-isolate memo is per-isolate
    // (not a global bound) and the cold-miss path has no in-flight de-dupe,
    // so this bounds the worst-case Stripe amplification from concurrent misses.
    const rl = rateLimitResponse(request, headers, 60, 60_000, 'stripe:prices');
    if (rl) return rl;
  }

  try {
    switch (path) {
      case '/webhook':
        if (request.method !== 'POST') {
          return jsonResponse<ErrorResponse>({ error: 'Method not allowed' }, 405, headers);
        }
        return handleWebhook(request);

      case '/verify':
        if (request.method !== 'GET') {
          return jsonResponse<ErrorResponse>({ error: 'Method not allowed' }, 405, headers);
        }
        return handleVerify(request, headers);

      case '/portal/session':
        if (request.method !== 'GET') {
          return jsonResponse<ErrorResponse>({ error: 'Method not allowed' }, 405, headers);
        }
        return handleDirectPortalSession(request, headers);

      case '/portal':
        if (request.method !== 'GET') {
          return jsonResponse<ErrorResponse>({ error: 'Method not allowed' }, 405, headers);
        }
        return handlePortal(request, headers);

      case '/license-key':
        if (request.method !== 'POST') {
          return jsonResponse<ErrorResponse>({ error: 'Method not allowed' }, 405, headers);
        }
        return handleLicenseKey(request, headers);

      case '/prices':
        if (request.method !== 'GET') {
          return jsonResponse<ErrorResponse>({ error: 'Method not allowed' }, 405, headers);
        }
        return handlePrices(headers);

      default:
        return jsonResponse<ErrorResponse>({ error: 'Not found' }, 404, headers);
    }
  } catch (error) {
    console.error('Stripe function error:', error);
    return jsonResponse<ErrorResponse>(
      { error: 'Internal server error' },
      500,
      headers,
    );
  }
});
