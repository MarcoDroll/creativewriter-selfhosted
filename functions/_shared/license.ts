import { importSPKI, jwtVerify } from 'npm:jose@6';
import { LICENSE_PUBLIC_KEY } from './license-public-key.ts';
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
