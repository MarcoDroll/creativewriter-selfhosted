import Stripe from 'npm:stripe@17';
import { SignJWT, importJWK } from 'npm:jose@6';
import { corsHeaders, handleCorsPreflightIfNeeded, jsonResponse } from '../_shared/cors.ts';
import { extractAuthFromRequest } from '../_shared/auth.ts';
import {
  getStripe,
  getOrCreateCustomer,
  syncStripeData,
  validateJwtAndGetSubscription,
  getCustomerIdByEmail,
  saveCustomerMapping,
  getPriceIdForTierAndCycle,
  getTrialDays,
  requireEnv,
} from '../_shared/stripe-helpers.ts';
import type {
  BillingCycle,
  CheckoutResponse,
  ErrorResponse,
  PortalResponse,
  PricesResponse,
  SubscriptionTier,
  VerifyResponse,
} from '../_shared/types.ts';

// --- Route handlers ---

async function handleCheckout(
  request: Request,
  headers: Record<string, string>,
): Promise<Response> {
  const authResult = await extractAuthFromRequest(request, headers);
  if (authResult instanceof Response) return authResult;

  const { userId, email } = authResult;

  const body = await request.json() as {
    tier?: SubscriptionTier;
    plan?: BillingCycle;
    successUrl?: string;
    cancelUrl?: string;
  };
  const tier: SubscriptionTier = body.tier === 'premium' ? 'premium' : 'basic';
  const cycle: BillingCycle = body.plan === 'yearly' ? 'yearly' : 'monthly';

  const successUrl = body.successUrl || requireEnv('SUCCESS_URL');
  const cancelUrl = body.cancelUrl || requireEnv('CANCEL_URL');

  const stripe = getStripe();
  if (!stripe) {
    return jsonResponse<ErrorResponse>({ error: 'Stripe not configured' }, 503, headers);
  }
  const customerId = await getOrCreateCustomer(stripe, email, userId);

  // Check for existing active/trialing subscription
  const existingSubs = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 1,
  });

  const activeSub = existingSubs.data.find(s => s.status === 'active' || s.status === 'trialing');
  if (activeSub) {
    return jsonResponse<ErrorResponse>(
      { error: 'You already have an active subscription. Use the billing portal to change your plan.' },
      400,
      headers,
    );
  }

  const priceId = getPriceIdForTierAndCycle(tier, cycle);
  const trialDays = getTrialDays();

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    subscription_data: {
      trial_period_days: trialDays,
      metadata: { email, tier, cycle },
    },
    allow_promotion_codes: true,
  });

  if (!session.url) {
    return jsonResponse<ErrorResponse>(
      { error: 'Failed to create checkout session' },
      500,
      headers,
    );
  }

  return jsonResponse<CheckoutResponse>({ url: session.url }, 200, headers);
}

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
      console.log(`Processing ${event.type} for customer ${customerId}`);
      await syncStripeData(stripe, customerId);
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
  const returnUrl = url.searchParams.get('returnUrl') || requireEnv('SUCCESS_URL');

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
  const returnUrl = url.searchParams.get('returnUrl') || requireEnv('SUCCESS_URL').replace('?subscription=success', '');

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
      await saveCustomerMapping(userId, email, customerId);
    } else {
      return jsonResponse<ErrorResponse>(
        { error: 'No subscription found. Please subscribe first.' },
        404,
        headers,
      );
    }
  }

  const subData = await syncStripeData(stripe, customerId);
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

function handlePrices(headers: Record<string, string>): Response {
  const stripe = getStripe();
  if (!stripe) {
    return jsonResponse<PricesResponse>(
      {
        basic: {
          monthly: { priceId: '', amount: 0, currency: 'usd' },
          yearly: { priceId: '', amount: 0, currency: 'usd' },
        },
        premium: {
          monthly: { priceId: '', amount: 0, currency: 'usd' },
          yearly: { priceId: '', amount: 0, currency: 'usd' },
        },
        trialDays: 0,
      },
      200,
      headers,
    );
  }
  return jsonResponse<PricesResponse>(
    {
      basic: {
        monthly: {
          priceId: Deno.env.get('STRIPE_BASIC_PRICE_ID_MONTHLY') || '',
          amount: 99,
          currency: 'usd',
        },
        yearly: {
          priceId: Deno.env.get('STRIPE_BASIC_PRICE_ID_YEARLY') || '',
          amount: 999,
          currency: 'usd',
        },
      },
      premium: {
        monthly: {
          priceId: Deno.env.get('STRIPE_PREMIUM_PRICE_ID_MONTHLY') || '',
          amount: 299,
          currency: 'usd',
        },
        yearly: {
          priceId: Deno.env.get('STRIPE_PREMIUM_PRICE_ID_YEARLY') || '',
          amount: 2999,
          currency: 'usd',
        },
      },
      trialDays: getTrialDays(),
    },
    200,
    headers,
  );
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
  if (!validation.valid) {
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

  try {
    switch (path) {
      case '/checkout':
        if (request.method !== 'POST') {
          return jsonResponse<ErrorResponse>({ error: 'Method not allowed' }, 405, headers);
        }
        return handleCheckout(request, headers);

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

      case '/prices':
        if (request.method !== 'GET') {
          return jsonResponse<ErrorResponse>({ error: 'Method not allowed' }, 405, headers);
        }
        return handlePrices(headers);

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
