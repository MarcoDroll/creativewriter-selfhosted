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

/**
 * Fallback tier detection from Stripe product name.
 *
 * When a subscription uses a price ID not in the 4 STRIPE_*_PRICE_ID_* env vars
 * (e.g. comped €0 prices, legacy products, promotional prices), getTierFromPriceId()
 * returns 'none'. This function resolves the tier from the Stripe product name instead.
 *
 * IMPORTANT: Stripe product names must contain the tier keyword ("Premium" or "Basic").
 * If a new tier is added, update this function AND the SubscriptionTier type.
 */
export function getTierFromProductName(productName: string): SubscriptionTier {
  const name = productName.toLowerCase();
  if (name.includes('premium')) return 'premium';
  if (name.includes('basic')) return 'basic';
  return 'none';
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

/**
 * Extracts SubscriptionData from a Stripe subscription using two-layer tier/cycle detection:
 * 1. Primary: exact price ID match against STRIPE_*_PRICE_ID_* env vars
 * 2. Fallback: product name matching (covers comps, legacy prices, promotional prices)
 *    and price.recurring.interval for cycle detection
 *
 * If the product is already expanded on the price, it will be used for tier fallback.
 * Otherwise pass a Stripe instance to resolve the product via a separate API call.
 */
async function extractSubscriptionData(sub: Stripe.Subscription, logPrefix = '', stripe?: Stripe | null): Promise<SubscriptionData> {
  const price = sub.items.data[0]?.price;
  const priceId = price?.id;

  let tier = getTierFromPriceId(priceId);
  if (tier === 'none' && priceId) {
    const product = price?.product;
    let productName: string | undefined;
    if (typeof product === 'object' && product !== null && 'name' in product) {
      productName = (product as { name: string }).name;
    } else if (typeof product === 'string' && stripe) {
      try {
        const productObj = await stripe.products.retrieve(product);
        productName = productObj.name;
      } catch (err) {
        console.warn(`Product fetch failed${logPrefix} for price ${priceId}, product ${product}:`, err);
      }
    } else if (typeof product === 'string' && !stripe) {
      console.warn(`Cannot resolve product name${logPrefix}: stripe instance not provided for product ${product}`);
    }
    if (productName) {
      tier = getTierFromProductName(productName);
      if (tier !== 'none') {
        console.log(`Tier fallback${logPrefix}: price ${priceId} resolved to '${tier}' via product name '${productName}'`);
      }
    }
  }

  let plan = getCycleFromPriceId(priceId);
  if (!plan && price?.recurring?.interval) {
    plan = price.recurring.interval === 'year' ? 'yearly' : 'monthly';
    console.log(`Cycle fallback${logPrefix}: price ${priceId} resolved to '${plan}' via recurring interval`);
  }

  return {
    status: sub.status,
    currentPeriodEnd: sub.current_period_end,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    priceId,
    subscriptionId: sub.id,
    plan,
    tier,
    trialEnd: sub.status === 'trialing' && sub.trial_end ? sub.trial_end : undefined,
  };
}

export async function syncStripeData(
  stripe: Stripe,
  customerId: string,
): Promise<SubscriptionData> {
  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    limit: 1,
    status: 'all',
  });

  const subData = subscriptions.data.length === 0
    ? { status: 'none', currentPeriodEnd: 0, cancelAtPeriodEnd: false, tier: 'none' as SubscriptionTier }
    : await extractSubscriptionData(subscriptions.data[0], '', stripe);

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

/**
 * Check whether the user is within the app-level trial window.
 * Returns a trial JwtValidationResult if eligible, or null otherwise.
 * Eligibility is based on auth.users.created_at and STRIPE_TRIAL_DAYS,
 * independent of whether a Stripe customer record exists — a Stripe
 * customer is created the first time the user calls a paid endpoint
 * (e.g. premium/ai/chat → getOrCreateCustomer for budget tracking),
 * which previously caused trial users to lose access after their first
 * generation. Keep this check orthogonal to Stripe customer existence.
 */
async function checkAppTrialEligibility(
  userId: string,
  email: string,
  customerId?: string,
): Promise<JwtValidationResult | null> {
  const trialDays = getTrialDays();
  if (trialDays <= 0) return null;
  try {
    const adminClient = getAdminClient();
    const { data: { user } } = await adminClient.auth.admin.getUserById(userId);
    if (!user?.created_at) return null;
    const createdAt = new Date(user.created_at).getTime();
    const trialEndMs = createdAt + trialDays * 86_400_000;
    if (Date.now() >= trialEndMs) return null;
    return {
      valid: true,
      email,
      tier: 'basic' as SubscriptionTier,
      customerId,
      userId,
      subData: {
        status: 'app_trial',
        currentPeriodEnd: Math.floor(trialEndMs / 1000),
        cancelAtPeriodEnd: false,
        tier: 'basic',
        trialEnd: Math.floor(trialEndMs / 1000),
      },
    };
  } catch (err) {
    console.error('Non-critical: app trial check failed:', err);
    return null;
  }
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
        userId,
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
    const trial = await checkAppTrialEligibility(userId, email);
    if (trial) return trial;
    return { valid: false, email, tier: 'none', userId };
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
    }
  }

  let subData: SubscriptionData | null = null;
  if (customerId) {
    const cached = await getSubscriptionCache(customerId);

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
        console.error('Non-critical: syncStripeData failed, using direct Stripe API data:', err);
        // Fetch directly from Stripe without caching — same two-layer fallback via extractSubscriptionData
        const subscriptions = await stripe.subscriptions.list({
          customer: customerId,
          limit: 1,
          status: 'all',
        });
        if (subscriptions.data.length === 0) {
          subData = { status: 'none', currentPeriodEnd: 0, cancelAtPeriodEnd: false, tier: 'none' };
        } else {
          subData = await extractSubscriptionData(subscriptions.data[0], ' (direct)', stripe);
        }
      }
    }
  }

  const isActive = subData?.status === 'active' || subData?.status === 'trialing';

  // App trial grant: if the user has no active paid subscription, check trial
  // eligibility based on signup date. Runs regardless of whether a Stripe
  // customer record exists so trial users retain access after the first paid
  // call (which creates the customer for budget tracking).
  if (!isActive) {
    const trial = await checkAppTrialEligibility(userId, email, customerId);
    if (trial) return trial;
  }

  const tier = isActive ? (subData!.tier || getTierFromPriceId(subData!.priceId) || 'none') : 'none';

  return { valid: isActive, email, tier, subData: subData ?? undefined, customerId, userId };
}
