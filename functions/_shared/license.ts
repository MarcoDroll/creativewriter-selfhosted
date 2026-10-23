import { importSPKI, jwtVerify } from 'npm:jose@6';
import { LICENSE_PUBLIC_KEY } from './license-public-key.ts';
import { getAdminClient } from './supabase-admin.ts';
import type { SubscriptionTier } from './types.ts';

export interface LicenseValidationResult {
  valid: boolean;
  tier: SubscriptionTier;
  email?: string;
  expiresAt?: number; // Unix seconds
}

// Cache the imported public key at module level (like stripeInstance/cachedJWKS)
let cachedPublicKey: Awaited<ReturnType<typeof importSPKI>> | null = null;

async function getPublicKey() {
  if (cachedPublicKey) return cachedPublicKey;
  cachedPublicKey = await importSPKI(LICENSE_PUBLIC_KEY, 'EdDSA');
  return cachedPublicKey;
}

/**
 * Validate a self-hosted license key (Ed25519-signed JWT).
 * Returns { valid: true, tier, email, expiresAt } on success.
 * On invalid/expired key: logs a warning and returns { valid: false }.
 */
export async function validateLicenseKey(licenseKey: string): Promise<LicenseValidationResult> {
  try {
    const publicKey = await getPublicKey();
    const { payload } = await jwtVerify(licenseKey, publicKey, {
      issuer: 'creativewriter',
      subject: 'license',
      audience: 'creativewriter-selfhosted',
    });

    const rawTier = payload.tier as string;
    const validTiers: SubscriptionTier[] = ['basic', 'premium'];
    const tier: SubscriptionTier = validTiers.includes(rawTier as SubscriptionTier)
      ? (rawTier as SubscriptionTier)
      : 'basic';
    const email = payload.email as string | undefined;
    const expiresAt = payload.exp;

    return { valid: true, tier, email, expiresAt };
  } catch (error) {
    console.warn('[License] Invalid or expired license key:', error instanceof Error ? error.message : String(error));
    return { valid: false, tier: 'none' };
  }
}

/**
 * Persist a validated license's tier into Postgres, so `cw_current_tier()` (SQL, the
 * roleplay Arc/session tier-cap trigger from 00067) can see a licensed self-hosted
 * Premium user instead of the blanket self-hosted -> basic mapping (#187) — SQL has no
 * other way to know a license was ever presented, since verification happens only here.
 *
 * **Caller MUST have already confirmed this runtime is NOT the genuine hosted instance**
 * (`isGenuineHostedInstance()` in stripe-helpers.ts) before calling this. The license-key
 * check runs BEFORE that hosted-trust gate in `validateJwtAndGetSubscription` — self-hosted
 * needs it to work when the Stripe/subscription_cache path is deliberately failed closed
 * there — so without this restriction a leaked license key sent to the REAL hosted
 * instance would turn what is today only a transient, per-request "premium" response into
 * a row this file's own trigger trusts for up to a year. This function does not re-check
 * that itself: it has no way to, and duplicating the probe here would only invite the two
 * checks to disagree.
 *
 * Best-effort: logs and returns on failure rather than throwing, because the caller's
 * `/stripe/verify` response does not depend on this side effect succeeding — the author's
 * own client already resolves their effective tier correctly regardless (this table exists
 * solely so the DATABASE can agree, for the one control the client cannot enforce). A
 * failed write here means the next tier-capped write attempt stays capped until the next
 * successful `/stripe/verify` call retries it, never that anyone is wrongly granted more.
 */
export async function persistSelfHostedLicenseValidation(
  userId: string,
  tier: SubscriptionTier,
  expiresAtUnixSeconds: number | undefined,
): Promise<void> {
  if (tier !== 'premium' || !expiresAtUnixSeconds) return;

  const { error } = await getAdminClient()
    .from('cw_license_validations')
    .upsert({
      user_id: userId,
      tier,
      expires_at: new Date(expiresAtUnixSeconds * 1000).toISOString(),
      validated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });

  if (error) {
    console.error('[License] failed to persist self-hosted license validation:', error.message);
  }
}
