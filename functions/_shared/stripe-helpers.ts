import Stripe from 'npm:stripe@17';
import { importJWK, importSPKI, jwtVerify, SignJWT } from 'npm:jose@6';
import { extractAuthFromRequest } from './auth.ts';
import { getAdminClient } from './supabase-admin.ts';
import { jsonResponse } from './cors.ts';
import { validateLicenseKey } from './license.ts';
import { LICENSE_PUBLIC_KEY } from './license-public-key.ts';
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

// --- License signing key (cached per isolate) ---
//
// getLicenseSigningKey() caches the imported key for handleLicenseKey()'s repeated
// signing calls. The trust probe below deliberately parses the key via the
// un-memoized loadLicenseSigningKey() instead (so tests can re-evaluate with a
// different key each call). Both go through the same loadLicenseSigningKey()
// logic, so they can never disagree about whether the key parses — they share
// the parse logic, not the cached CryptoKey object. LICENSE_SIGNING_KEY is static
// for an isolate's lifetime, so this duplication costs at most one extra one-time
// key import per isolate, never per request.

let licenseSigningKeyCache: Promise<CryptoKey | null> | null = null;

async function loadLicenseSigningKey(): Promise<CryptoKey | null> {
  const signingKeyJson = Deno.env.get('LICENSE_SIGNING_KEY');
  if (!signingKeyJson) return null; // absent → not hosted, fail closed
  try {
    return await importJWK(JSON.parse(signingKeyJson), 'EdDSA') as CryptoKey;
  } catch (err) {
    console.error('[Stripe] LICENSE_SIGNING_KEY present but invalid JSON/JWK:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Cached import of the LICENSE_SIGNING_KEY private key, or null if absent/malformed. */
export function getLicenseSigningKey(): Promise<CryptoKey | null> {
  if (!licenseSigningKeyCache) licenseSigningKeyCache = loadLicenseSigningKey();
  return licenseSigningKeyCache;
}

// --- Non-forgeable "is this a genuine hosted instance" probe ---
//
// The private LICENSE_SIGNING_KEY only ever exists as a Supabase secret on the
// two real hosted projects; self-hosted deployments carry only the embedded
// public key. So holding a private key that MATCHES the embedded public key is
// the structurally-unfakeable signal that this runtime is genuinely hosted.

let hostedInstanceCheck: Promise<boolean> | null = null;

/**
 * The un-memoized probe: proves this runtime holds the private key that matches
 * `publicKeyPem` (the embedded LICENSE_PUBLIC_KEY by default) via a
 * sign-then-verify round trip. Reads LICENSE_SIGNING_KEY from env on every call
 * (un-memoized) and takes the public key as a parameter — both so tests can
 * drive each scenario with a different key. Production code should call the
 * memoized isGenuineHostedInstance() instead; the `publicKeyPem` param exists
 * for the positive-case test, which must inject a test keypair's public half
 * (the real LICENSE_PUBLIC_KEY's matching private key is not in this repo).
 */
export async function probeIsGenuineHostedInstance(publicKeyPem: string = LICENSE_PUBLIC_KEY): Promise<boolean> {
  const privateKey = await loadLicenseSigningKey();
  if (!privateKey) {
    console.log('[Stripe] hosted-instance probe: false (no/invalid LICENSE_SIGNING_KEY)');
    return false;
  }

  try {
    const publicKey = await importSPKI(publicKeyPem, 'EdDSA');

    // Prove `d` actually corresponds to the known public key — not just that the
    // JWK is well-formed, and not just that `x` was copied verbatim out of the
    // (checked-in) public key. A forged `d` produces a signature that fails
    // verification against the real public key even when `x` looks right.
    // Distinct subject 'license-probe' (not 'license') so this token is NOT a
    // usable license even if it ever leaked to a log within its 1-minute window
    // — validateLicenseKey() requires subject: 'license' — and so probe tokens
    // are unambiguous in logs.
    const probeToken = await new SignJWT({ probe: true })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer('creativewriter')
      .setSubject('license-probe')
      .setAudience('creativewriter-selfhosted')
      .setExpirationTime('1m')
      .sign(privateKey);

    await jwtVerify(probeToken, publicKey, {
      issuer: 'creativewriter',
      subject: 'license-probe',
      audience: 'creativewriter-selfhosted',
    });
    console.log('[Stripe] hosted-instance probe: true');
    return true; // signature verified against the real public key — genuine match
  } catch (err) {
    // Fail CLOSED — never silently trust local DB state on a key mismatch.
    console.error('[Stripe] LICENSE_SIGNING_KEY does not match the expected public key — treating instance as non-hosted:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * True only if this runtime holds the private key matching LICENSE_PUBLIC_KEY —
 * the non-forgeable "this is genuinely hosted" signal. Cached per isolate so the
 * sign+verify round trip is paid once per cold start, not on every request.
 */
export function isGenuineHostedInstance(): Promise<boolean> {
  if (!hostedInstanceCheck) hostedInstanceCheck = probeIsGenuineHostedInstance();
  return hostedInstanceCheck;
}

/**
 * Test-only: clear the per-isolate memoized probe/signing-key caches so a test
 * can drive isGenuineHostedInstance() with a fresh LICENSE_SIGNING_KEY. Never
 * called in production — the caches are module-level and intentionally sticky
 * for an isolate's lifetime.
 */
export function resetHostedInstanceCacheForTests(): void {
  hostedInstanceCheck = null;
  licenseSigningKeyCache = null;
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

/**
 * List the price IDs currently configured via the 4 STRIPE_*_PRICE_ID_* env
 * vars, skipping any that are unset. Reads the vars DIRECTLY (not via
 * `requireEnv`, which throws on hosted when a var is missing) so this is a
 * graceful, side-effect-free seam for the public /prices route: a partially
 * configured instance simply yields fewer entries instead of erroring.
 */
export function getConfiguredPriceIds(): { tier: 'basic' | 'premium'; cycle: BillingCycle; priceId: string }[] {
  const config: [('basic' | 'premium'), BillingCycle, string][] = [
    ['basic', 'monthly', 'STRIPE_BASIC_PRICE_ID_MONTHLY'],
    ['basic', 'yearly', 'STRIPE_BASIC_PRICE_ID_YEARLY'],
    ['premium', 'monthly', 'STRIPE_PREMIUM_PRICE_ID_MONTHLY'],
    ['premium', 'yearly', 'STRIPE_PREMIUM_PRICE_ID_YEARLY'],
  ];
  const result: { tier: 'basic' | 'premium'; cycle: BillingCycle; priceId: string }[] = [];
  for (const [tier, cycle, envKey] of config) {
    const priceId = Deno.env.get(envKey);
    if (priceId) result.push({ tier, cycle, priceId });
  }
  return result;
}

// --- Database helpers (replacing KV) ---

export async function getCustomerIdByEmail(email: string): Promise<string | null> {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from('stripe_customers')
    .select('stripe_customer_id')
    .eq('email', email.toLowerCase())
    .maybeSingle();
  if (error) {
    console.error('DB error looking up customer by email:', error.message);
  }
  return data?.stripe_customer_id || null;
}

export async function getCustomerIdByUserId(userId: string): Promise<string | null> {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from('stripe_customers')
    .select('stripe_customer_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.error('DB error looking up customer by user_id:', error.message);
  }
  return data?.stripe_customer_id || null;
}

export async function getCustomerIdByStripeId(stripeCustomerId: string): Promise<string | null> {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from('stripe_customers')
    .select('stripe_customer_id')
    .eq('stripe_customer_id', stripeCustomerId)
    .maybeSingle();
  if (error) {
    console.error('DB error looking up customer by stripe id:', error.message);
  }
  return data?.stripe_customer_id || null;
}

/**
 * Upsert the user_id <-> stripe_customer_id mapping atomically. Calls the
 * SECURITY DEFINER RPC `upsert_stripe_customer_mapping` which deterministically
 * removes conflicting rows on the other two unique columns before inserting.
 *
 * Returns true on success, false if the user_id no longer exists in auth.users
 * (FK 23503 — account deleted between checkout and webhook). All other errors
 * are rethrown.
 */
export async function saveCustomerMapping(userId: string, email: string, stripeCustomerId: string): Promise<boolean> {
  const supabase = getAdminClient();
  const { error } = await supabase.rpc('upsert_stripe_customer_mapping', {
    p_user_id: userId,
    p_email: email.toLowerCase(),
    p_stripe_customer_id: stripeCustomerId,
  });
  if (error) {
    // Only swallow 23503 when the auth.users FK fired (account deleted between
    // checkout and webhook). Any other 23503 (e.g. a child-table FK we forgot
    // to ON UPDATE CASCADE) must surface so Stripe retries and we see it.
    if (error.code === '23503' && (error.message || '').includes('user_id')) {
      console.warn(JSON.stringify({
        level: 'warn',
        reason: 'orphan_user_deleted',
        userId,
        stripeCustomerId,
      }));
      return false;
    }
    throw new Error(`Failed to save customer mapping: ${error.message}`);
  }
  return true;
}

/**
 * Parse a PostgREST TIMESTAMPTZ string (e.g. "2026-07-23T10:18:26.123456+00:00")
 * into epoch ms. Returns undefined for absent or unparseable values so callers can
 * treat "unknown age" distinctly from "known fresh".
 */
export function parseCachedAt(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Cached statuses that grant entitlement. Webhooks keep these rows fresh, so they
 * are trusted indefinitely — this is the paying-user fast path that costs zero
 * Stripe calls per request.
 *
 * NOTE: 'app_trial' is deliberately absent. It is synthesized by
 * checkAppTrialEligibility() and never persisted to subscription_cache (the column
 * is unconstrained TEXT, so nothing at the DB level enforces this). Adding it here
 * would be a no-op at best and would mask a real bug if a trial status ever did get
 * written to the cache.
 */
const ENTITLING_STATUSES = ['active', 'trialing'];

/** How long a non-entitling cached row is trusted before we re-check Stripe. */
const NON_ENTITLING_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Grace period after an entitling row's `current_period_end` before we re-check
 * Stripe. Renewal webhooks (`customer.subscription.updated`) are near-instant, so
 * a healthy sub's period end is pushed forward well before it can pass — this
 * grace only absorbs boundary jitter/clock skew, never a healthy renewal. A
 * genuinely missed webhook is caught within the grace, and if that webhook was a
 * missed cancellation the churned user keeps at most ~1h of extra access.
 */
const ENTITLING_EXPIRY_GRACE_MS = 60 * 60 * 1000;

/**
 * Decide whether a cached subscription row must be re-checked against Stripe.
 *
 * Non-entitling rows ('none', 'canceled', 'past_due', 'incomplete', 'unpaid',
 * 'paused', …) go stale after NON_ENTITLING_CACHE_TTL_MS, so a missed webhook
 * degrades to a ≤5-minute delay instead of a permanent paid-with-no-entitlement
 * state (see the 2026-07-23 orphan incident: a `none` row written five minutes
 * before payment pinned the user at tier 'none' forever).
 *
 * Entitling rows ('active'/'trialing') are trusted while their billing period is
 * current — webhooks own them and this is the paying-user zero-Stripe-call fast
 * path. But an entitling row whose `current_period_end` is more than
 * ENTITLING_EXPIRY_GRACE_MS in the past is the exact fingerprint of a missed
 * webhook: Stripe pushes `current_period_end` forward on every renewal, so a
 * healthy sub never enters this window. Such a row goes stale and is re-checked,
 * which closes the missed-cancellation leak (a churned `active` row that would
 * otherwise be trusted forever). If the sub genuinely renewed the re-check just
 * writes the new future period end and returns to the fast path; if Stripe is
 * unreachable the caller falls back to the stale entitling row, so no paying user
 * is ever locked out.
 *
 * Unit caveat: `cachedAtMs` is epoch **milliseconds** but `currentPeriodEndSec`
 * is epoch **seconds** (raw from Stripe / the BIGINT `current_period_end` column),
 * hence the `* 1000`. A malformed `currentPeriodEndSec <= 0` entitling row keeps
 * today's trust-indefinitely behaviour (no regression; a real active sub always
 * has a positive period end).
 *
 * A missing/unparseable cachedAt counts as stale for non-entitling rows — unknown
 * age fails toward correctness, and the refresh rewrites cached_at so it
 * self-corrects.
 *
 * Exported as a pure predicate specifically so it is unit-testable;
 * validateJwtAndGetSubscription() is not, because it requires
 * isGenuineHostedInstance() and the private LICENSE_SIGNING_KEY that is
 * deliberately absent from this repo.
 */
export function isSubscriptionCacheStale(
  status: string,
  cachedAtMs: number | undefined,
  currentPeriodEndSec: number | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (isEntitlingStatus(status)) {
    // Fast path unless the billing period has demonstrably lapsed past the grace.
    if (currentPeriodEndSec !== undefined && currentPeriodEndSec > 0) {
      return nowMs >= currentPeriodEndSec * 1000 + ENTITLING_EXPIRY_GRACE_MS;
    }
    return false;
  }
  if (cachedAtMs === undefined) return true;
  return nowMs - cachedAtMs >= NON_ENTITLING_CACHE_TTL_MS;
}

/** Single source of truth for "this status grants access". */
function isEntitlingStatus(status: string | undefined): boolean {
  return status !== undefined && ENTITLING_STATUSES.includes(status);
}

/**
 * Fill in tier/plan from the price ID for cached rows written before those
 * columns existed. Fresh Stripe data never needs this — extractSubscriptionData
 * already does its own two-layer tier/cycle resolution.
 */
function backfillFromPriceId(data: SubscriptionData): void {
  if (!data.tier && data.priceId) data.tier = getTierFromPriceId(data.priceId);
  if (!data.plan && data.priceId) data.plan = getCycleFromPriceId(data.priceId);
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
    cachedAt: parseCachedAt(data.cached_at),
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

/** Live subscription state for a customer, straight from Stripe — no DB write. */
async function fetchSubscriptionDataFromStripe(
  stripe: Stripe,
  customerId: string,
  logPrefix = '',
): Promise<SubscriptionData> {
  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    limit: 1,
    status: 'all',
  });

  return subscriptions.data.length === 0
    ? { status: 'none', currentPeriodEnd: 0, cancelAtPeriodEnd: false, tier: 'none' as SubscriptionTier }
    : await extractSubscriptionData(subscriptions.data[0], logPrefix, stripe);
}

export async function syncStripeData(
  stripe: Stripe,
  customerId: string,
): Promise<SubscriptionData> {
  const subData = await fetchSubscriptionDataFromStripe(stripe, customerId);
  await saveSubscriptionCache(customerId, subData);
  return subData;
}

/**
 * In-isolate de-dupe of concurrent Stripe refreshes for the same customer.
 *
 * `/verify` is not rate-limited (unlike /portal, /license-key and /prices), and the
 * frontend "Refresh status" button resets only its own client-side dedup — so an
 * impatient user, or several open tabs, can fire a burst against the same stale row.
 * Mirrors the `pricesInFlight` memo in stripe/index.ts: per-isolate, not a global
 * bound, so it collapses the common same-isolate burst rather than a distributed one.
 */
const subscriptionRefreshInFlight = new Map<string, Promise<SubscriptionData>>();

/**
 * Fetch live subscription state for a customer, sharing one Stripe round trip
 * across concurrent callers. Rejects only if Stripe itself is unreachable —
 * callers decide how to degrade.
 *
 * Deliberately NOT `syncStripeData()`: that one throws when the cache write
 * fails, which used to send this path back to Stripe for a second identical
 * `subscriptions.list`. On the old cache-MISS-only path that cost one extra call
 * once per customer; now that a stale row re-enters here every 5 minutes, a
 * sustained DB-write outage would double Stripe traffic for the whole
 * non-entitling cohort exactly when the system is already degraded. So we fetch
 * once and treat the persist as best-effort.
 */
function refreshSubscriptionFromStripe(stripe: Stripe, customerId: string): Promise<SubscriptionData> {
  const existing = subscriptionRefreshInFlight.get(customerId);
  if (existing) return existing;

  const tracked = (async () => {
    const subData = await fetchSubscriptionDataFromStripe(stripe, customerId);
    try {
      await saveSubscriptionCache(customerId, subData);
    } catch (err) {
      // Serve the live data anyway — this is a user-facing verification flow.
      // `cached_at` did not advance, so the next request re-checks Stripe; this
      // log is how that degraded (1 Stripe call per request) state stays visible.
      console.error(JSON.stringify({
        event: 'verify.cache_write_failed',
        customerId,
        message: err instanceof Error ? err.message : String(err),
      }));
    }
    return subData;
  })().finally(() => {
    // Identity-checked so a later refresh's entry is never evicted by an earlier one.
    if (subscriptionRefreshInFlight.get(customerId) === tracked) {
      subscriptionRefreshInFlight.delete(customerId);
    }
  });

  subscriptionRefreshInFlight.set(customerId, tracked);
  return tracked;
}

export async function getOrCreateCustomer(
  stripe: Stripe,
  email: string,
  userId: string,
): Promise<string> {
  // user_id first: a user whose Supabase email differs from their Stripe email
  // (e.g. they edited the prefilled email at checkout) must still resolve to
  // their existing mapping, otherwise we'd create a duplicate Stripe customer.
  const byUserId = await getCustomerIdByUserId(userId);
  if (byUserId) return byUserId;

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
    // App-trial grants full Premium for the 7-day window (issue #35). The tier is
    // 'premium' so the premium feature gates (AI Rewrite, Character Chat, Portrait)
    // unlock during the trial. `status` stays 'app_trial' — that is what keeps the
    // spend bounded: resolveIncludedAiTier() keys the $0.50/month included-AI cap on
    // the status (not the tier), and license-key minting (stripe/index.ts) blocks
    // 'app_trial', so trials remain hosted-only and capped despite the premium tier.
    return {
      valid: true,
      email,
      tier: 'premium' as SubscriptionTier,
      customerId,
      userId,
      subData: {
        status: 'app_trial',
        currentPeriodEnd: Math.floor(trialEndMs / 1000),
        cancelAtPeriodEnd: false,
        tier: 'premium',
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

  // Hosted-trust gate keyed on secret possession, NOT a self-declared flag.
  // The local-Postgres trust path below (subscription_cache rows, app-trial
  // grants, the local-Stripe bypass) is only honoured when this runtime actually
  // holds the private LICENSE_SIGNING_KEY that matches the embedded public key —
  // a secret that exists only on the two real hosted Supabase projects. A
  // self-hoster owns their own Postgres and could INSERT a premium
  // subscription_cache row, so trusting that DB requires proof this is genuinely
  // hosted; the old `SELF_HOSTED === 'true'` check was operator-set env they
  // could simply omit/flip. Without the matching key we return `tier: 'none'`
  // and skip every Stripe path; a purchased license key (verified above) remains
  // the only way to unlock premium on self-hosted. Frontend maps 'none' to
  // `basic` (subscription.service.ts) via its self-hosted forced-basic default.
  if (!(await isGenuineHostedInstance())) {
    return { valid: false, email, tier: 'none', userId };
  }

  const stripe = getStripe();

  if (!stripe) {
    const trial = await checkAppTrialEligibility(userId, email);
    if (trial) return trial;
    return { valid: false, email, tier: 'none', userId };
  }

  // user_id first so users whose Stripe email differs from their Supabase email
  // (edited at checkout) still resolve to their mapping.
  let customerId = await getCustomerIdByUserId(userId);
  if (!customerId) customerId = await getCustomerIdByEmail(email);

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

    if (cached && !isSubscriptionCacheStale(cached.status, cached.cachedAt, cached.currentPeriodEnd)) {
      subData = cached;
      backfillFromPriceId(subData);
    } else {
      // Cache miss, or a non-entitling row past its TTL — fetch from Stripe.
      // The TTL re-check is what lets a missed webhook self-heal; without it a
      // `status: 'none'` row is a permanent cache HIT and the user stays at
      // tier 'none' despite having paid (2026-07-23 orphan incident).
      try {
        subData = await refreshSubscriptionFromStripe(stripe, customerId);
        if (cached && !isEntitlingStatus(cached.status) && isEntitlingStatus(subData.status)) {
          // A stale non-entitling row that Stripe says is entitling means a
          // webhook was missed and we just repaired it. Absent in normal
          // operation — pairs with `webhook.orphan_skipped` for alerting.
          console.log(JSON.stringify({
            event: 'verify.cache_self_heal',
            userId,
            customerId,
            previousStatus: cached.status,
            newStatus: subData.status,
            newTier: subData.tier ?? null,
          }));
        } else if (cached && isEntitlingStatus(cached.status) && !isEntitlingStatus(subData.status)) {
          // The mirror of cache_self_heal and the revenue-*leak* signal: an
          // entitling row expired past its `current_period_end` grace, we
          // re-checked, and Stripe says the sub is no longer entitling — a missed
          // cancellation webhook we just revoked access for. Absent in normal
          // operation; higher-signal counterpart to `verify.cache_self_heal`.
          console.log(JSON.stringify({
            event: 'verify.entitlement_expired_recheck',
            userId,
            customerId,
            previousStatus: cached.status,
            newStatus: subData.status,
            previousPeriodEnd: cached.currentPeriodEnd,
          }));
        }
      } catch (err) {
        // Stripe unreachable entirely. Fall back to the stale cached row rather
        // than 500-ing every premium/included-AI request for a population that
        // otherwise makes zero Stripe calls. `cached` may be null — that is the
        // pre-existing no-customer behaviour and still reaches the app-trial check.
        console.error('Stripe refresh failed, falling back to cached subscription row:', err);
        subData = cached;
        if (subData) backfillFromPriceId(subData);
      }
    }
  }

  const isActive = isEntitlingStatus(subData?.status);

  // App trial grant: if the user has no active paid subscription, check trial
  // eligibility based on signup date. Runs regardless of whether a Stripe
  // customer record exists so trial users retain access after the first paid
  // call (which creates the customer for budget tracking).
  if (!isActive) {
    const trial = await checkAppTrialEligibility(userId, email, customerId ?? undefined);
    if (trial) return trial;
  }

  const tier = isActive ? (subData!.tier || getTierFromPriceId(subData!.priceId) || 'none') : 'none';

  return { valid: isActive, email, tier, subData: subData ?? undefined, customerId: customerId ?? undefined, userId };
}
