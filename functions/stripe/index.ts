import Stripe from 'npm:stripe@17';
import { SignJWT, importJWK } from 'npm:jose@6';
import { corsHeaders, handleCorsPreflightIfNeeded, jsonResponse } from '../_shared/cors.ts';
import { rateLimitResponse } from '../_shared/rate-limit.ts';
import { logAuditEvent } from '../_shared/audit.ts';
import { getAdminClient } from '../_shared/supabase-admin.ts';
import { extractAuthFromRequest } from '../_shared/auth.ts';
import {
  getStripe,
  getOrCreateCustomer,
  syncStripeData,
  validateJwtAndGetSubscription,
  getCustomerIdByEmail,
  saveCustomerMapping,
  requireEnv,
} from '../_shared/stripe-helpers.ts';
import type {
  ErrorResponse,
  PortalResponse,
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

// --- Route handlers ---

async function handleWebhook(request: Request): Promise<Response> {
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

  let customerId = await getCustomerIdByEmail(email);

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
  if (!validation.valid || validation.subData?.status === 'app_trial') {
    return jsonResponse<ErrorResponse>({ error: 'Active subscription required to generate a license key' }, 403, headers);
  }

  const signingKeyJson = Deno.env.get('LICENSE_SIGNING_KEY');
  if (!signingKeyJson) {
    return jsonResponse<ErrorResponse>({ error: 'License signing key not configured' }, 503, headers);
  }

  try {
    const jwk = JSON.parse(signingKeyJson);
    const privateKey = await importJWK(jwk, 'EdDSA');

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

// --- Main entry point ---

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
