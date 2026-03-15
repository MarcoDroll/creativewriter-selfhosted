import Stripe from 'npm:stripe@17';
import { extractAuthFromRequest } from './auth.ts';
import { getAdminClient } from './supabase-admin.ts';
import { jsonResponse } from './cors.ts';
import { validateLicenseKey } from './license.ts';
import type {
  BillingCycle,
  ErrorResponse,
  JwtValidationResult,
  SubscriptionData,
  SubscriptionTier,
} from './types.ts';

// --- Env helper ---

export function requireEnv(key: string): string {
  const value = Deno.env.get(key);
  if (!value) {
    if (Deno.env.get('SELF_HOSTED') === 'true') return '';
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

// --- Stripe client (cached per isolate) ---

let stripeInstance: Stripe | null = null;

export function getStripe(): Stripe | null {
  if (stripeInstance) return stripeInstance;
  const key = Deno.env.get('STRIPE_API_KEY');
  if (!key) {
    if (Deno.env.get('SELF_HOSTED') === 'true') return null;
    throw new Error('Missing STRIPE_API_KEY');
  }
  stripeInstance = new Stripe(key, {
    apiVersion: '2025-02-24.acacia',
  });
  return stripeInstance;
}

// --- Tier & Pricing helpers ---

export function getTierFromPriceId(priceId: string | undefined): SubscriptionTier {
  if (!priceId) return 'none';
  if (priceId === Deno.env.get('STRIPE_BASIC_PRICE_ID_MONTHLY') || priceId === Deno.env.get('STRIPE_BASIC_PRICE_ID_YEARLY')) return 'basic';
  if (priceId === Deno.env.get('STRIPE_PREMIUM_PRICE_ID_MONTHLY') || priceId === Deno.env.get('STRIPE_PREMIUM_PRICE_ID_YEARLY')) return 'premium';
  return 'none';
}

export function getCycleFromPriceId(priceId: string | undefined): BillingCycle | undefined {
  if (!priceId) return undefined;
  if (priceId === Deno.env.get('STRIPE_BASIC_PRICE_ID_MONTHLY') || priceId === Deno.env.get('STRIPE_PREMIUM_PRICE_ID_MONTHLY')) return 'monthly';
  if (priceId === Deno.env.get('STRIPE_BASIC_PRICE_ID_YEARLY') || priceId === Deno.env.get('STRIPE_PREMIUM_PRICE_ID_YEARLY')) return 'yearly';
  return undefined;
}

export function getPriceIdForTierAndCycle(tier: SubscriptionTier, cycle: BillingCycle): string {
  if (tier === 'basic') {
    return cycle === 'yearly' ? requireEnv('STRIPE_BASIC_PRICE_ID_YEARLY') : requireEnv('STRIPE_BASIC_PRICE_ID_MONTHLY');
  }
  return cycle === 'yearly' ? requireEnv('STRIPE_PREMIUM_PRICE_ID_YEARLY') : requireEnv('STRIPE_PREMIUM_PRICE_ID_MONTHLY');
}

export function getTrialDays(): number {
  return parseInt(Deno.env.get('STRIPE_TRIAL_DAYS') || '7', 10);
}

// --- Database helpers (replacing KV) ---

export async function getCustomerIdByEmail(email: string): Promise<string | null> {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from('stripe_customers')
    .select('stripe_customer_id')
    .eq('email', email.toLowerCase())
    .single();
  if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
    console.error('DB error looking up customer:', error.message);
  }
  return data?.stripe_customer_id || null;
}

export async function saveCustomerMapping(userId: string, email: string, stripeCustomerId: string): Promise<void> {
  const supabase = getAdminClient();
  const { error } = await supabase
    .from('stripe_customers')
    .upsert({
      user_id: userId,
      email: email.toLowerCase(),
      stripe_customer_id: stripeCustomerId,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'email' });
  if (error) {
    throw new Error(`Failed to save customer mapping: ${error.message}`);
  }
}

export async function getSubscriptionCache(stripeCustomerId: string): Promise<SubscriptionData | null> {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from('subscription_cache')
    .select('*')
    .eq('stripe_customer_id', stripeCustomerId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('DB error reading subscription cache:', error.message);
  }
  if (!data) return null;

  return {
    status: data.status,
    currentPeriodEnd: data.current_period_end,
    cancelAtPeriodEnd: data.cancel_at_period_end,
    priceId: data.price_id,
    subscriptionId: data.subscription_id,
    plan: data.plan as BillingCycle | undefined,
    tier: data.tier as SubscriptionTier | undefined,
    trialEnd: data.trial_end,
  };
}

export async function saveSubscriptionCache(stripeCustomerId: string, subData: SubscriptionData): Promise<void> {
  const supabase = getAdminClient();
  const { error } = await supabase
    .from('subscription_cache')
    .upsert({
      stripe_customer_id: stripeCustomerId,
      status: subData.status,
      tier: subData.tier || 'none',
      plan: subData.plan || null,
      price_id: subData.priceId || null,
      subscription_id: subData.subscriptionId || null,
      current_period_end: subData.currentPeriodEnd,
      cancel_at_period_end: subData.cancelAtPeriodEnd,
      trial_end: subData.trialEnd || null,
      cached_at: new Date().toISOString(),
    }, { onConflict: 'stripe_customer_id' });
  if (error) {
    throw new Error(`Failed to save subscription cache: ${error.message}`);
  }
}

// --- Core Stripe logic ---

export async function syncStripeData(
  stripe: Stripe,
  customerId: string,
): Promise<SubscriptionData> {
  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    limit: 1,
    status: 'all',
  });

  let subData: SubscriptionData;

  if (subscriptions.data.length === 0) {
    subData = {
      status: 'none',
      currentPeriodEnd: 0,
      cancelAtPeriodEnd: false,
      tier: 'none',
    };
  } else {
    const sub = subscriptions.data[0];
    const priceId = sub.items.data[0]?.price.id;
    subData = {
      status: sub.status,
      currentPeriodEnd: sub.current_period_end,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      priceId,
      subscriptionId: sub.id,
      plan: getCycleFromPriceId(priceId),
      tier: getTierFromPriceId(priceId),
      trialEnd: sub.status === 'trialing' && sub.trial_end ? sub.trial_end : undefined,
    };
  }

  await saveSubscriptionCache(customerId, subData);
  return subData;
}

export async function getOrCreateCustomer(
  stripe: Stripe,
  email: string,
  userId: string,
): Promise<string> {
  const cachedId = await getCustomerIdByEmail(email);
  if (cachedId) return cachedId;

  const existing = await stripe.customers.list({
    email: email.toLowerCase(),
    limit: 1,
  });

  if (existing.data.length > 0) {
    const customerId = existing.data[0].id;
    try {
      await saveCustomerMapping(userId, email, customerId);
    } catch (err) {
      console.error('Non-critical: failed to cache customer mapping:', err);
    }
    return customerId;
  }

  const customer = await stripe.customers.create({
    email: email.toLowerCase(),
  });

  try {
    await saveCustomerMapping(userId, email, customer.id);
  } catch (err) {
    console.error('Non-critical: failed to cache customer mapping:', err);
  }
  return customer.id;
}

export async function validateJwtAndGetSubscription(
  request: Request,
  headers: Record<string, string>,
): Promise<JwtValidationResult | Response> {
  const authResult = await extractAuthFromRequest(request, headers);
  if (authResult instanceof Response) return authResult;

  const { userId, email } = authResult;

  // License key check — header takes precedence, env var is legacy fallback
  const licenseKey = request.headers.get('X-License-Key') || Deno.env.get('LICENSE_KEY');
  if (licenseKey) {
    const licenseResult = await validateLicenseKey(licenseKey);
    if (licenseResult.valid) {
      return {
        valid: true,
        email,
        tier: licenseResult.tier,
        customerId: `license:${userId}`,
        subData: {
          status: 'active',
          currentPeriodEnd: licenseResult.expiresAt || 0,
          cancelAtPeriodEnd: false,
          tier: licenseResult.tier,
        },
      };
    }
    // Invalid license: log already happened in validateLicenseKey, fall through to Stripe
  }

  const stripe = getStripe();

  if (!stripe) {
    return { valid: false, email, tier: 'none' };
  }

  let customerId = await getCustomerIdByEmail(email);

  if (!customerId) {
    const existing = await stripe.customers.list({ email, limit: 1 });
    if (existing.data.length > 0) {
      customerId = existing.data[0].id;
      try {
        await saveCustomerMapping(userId, email, customerId);
      } catch (err) {
        console.error('Non-critical: failed to cache customer mapping:', err);
      }
    } else {
      return { valid: false, email, tier: 'none' };
    }
  }

  const cached = await getSubscriptionCache(customerId);
  let subData: SubscriptionData;

  if (cached) {
    subData = cached;
    if (!subData.tier && subData.priceId) {
      subData.tier = getTierFromPriceId(subData.priceId);
    }
    if (!subData.plan && subData.priceId) {
      subData.plan = getCycleFromPriceId(subData.priceId);
    }
  } else {
    // Cache miss — fetch from Stripe API. If the DB cache save fails,
    // degrade gracefully since this is a user-facing verification flow.
    try {
      subData = await syncStripeData(stripe, customerId);
    } catch (err) {
      console.error('Non-critical: syncStripeData cache save failed, using Stripe API data:', err);
      // Fetch directly from Stripe without caching
      const subscriptions = await stripe.subscriptions.list({
        customer: customerId,
        limit: 1,
        status: 'all',
      });
      if (subscriptions.data.length === 0) {
        subData = { status: 'none', currentPeriodEnd: 0, cancelAtPeriodEnd: false, tier: 'none' };
      } else {
        const sub = subscriptions.data[0];
        const priceId = sub.items.data[0]?.price.id;
        subData = {
          status: sub.status,
          currentPeriodEnd: sub.current_period_end,
          cancelAtPeriodEnd: sub.cancel_at_period_end,
          priceId,
          subscriptionId: sub.id,
          plan: getCycleFromPriceId(priceId),
          tier: getTierFromPriceId(priceId),
          trialEnd: sub.status === 'trialing' && sub.trial_end ? sub.trial_end : undefined,
        };
      }
    }
  }

  const isActive = subData.status === 'active' || subData.status === 'trialing';
  const tier = isActive ? (subData.tier || getTierFromPriceId(subData.priceId) || 'none') : 'none';

  return { valid: isActive, email, tier, subData, customerId };
}
