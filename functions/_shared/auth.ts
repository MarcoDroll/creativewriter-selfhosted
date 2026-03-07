import { createRemoteJWKSet, jwtVerify } from 'npm:jose@6';
import { jsonResponse } from './cors.ts';
import type { AuthResult, ErrorResponse, SupabaseJwtPayload } from './types.ts';

console.log('[Auth] Module loaded -- HS256 + JWKS dual-mode verification');

// Module-level JWKS cache (reused across requests in the same isolate)
let cachedJWKS: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedJWKSUrl: string | null = null;

// Module-level symmetric key cache
let cachedSymmetricKey: CryptoKey | null = null;

function getJWKS(supabaseUrl: string) {
  const jwksUrl = `${supabaseUrl}/auth/v1/.well-known/jwks.json`;
  if (cachedJWKS && cachedJWKSUrl === jwksUrl) return cachedJWKS;
  cachedJWKS = createRemoteJWKSet(new URL(jwksUrl));
  cachedJWKSUrl = jwksUrl;
  return cachedJWKS;
}

async function getSymmetricKey(secret: string): Promise<CryptoKey> {
  if (cachedSymmetricKey) return cachedSymmetricKey;
  const encoder = new TextEncoder();
  cachedSymmetricKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return cachedSymmetricKey;
}

/**
 * Verify a Supabase JWT.
 *
 * Self-hosted GoTrue uses HS256 (symmetric) with JWT_SECRET.
 * Hosted Supabase uses asymmetric keys via JWKS.
 * We detect which mode to use based on SELF_HOSTED + JWT_SECRET env vars.
 *
 * On self-hosted, SUPABASE_URL is the internal gateway (http://kong:8000)
 * but GoTrue issues JWTs with the public URL as issuer. We use
 * SUPABASE_PUBLIC_URL for the issuer check when available.
 */
async function verifySupabaseJwt(
  token: string,
  supabaseUrl: string
): Promise<SupabaseJwtPayload | null> {
  const issuerUrl = Deno.env.get('SUPABASE_PUBLIC_URL') || supabaseUrl;
  const jwtSecret = Deno.env.get('JWT_SECRET');
  const selfHosted = Deno.env.get('SELF_HOSTED') === 'true';

  try {
    if (selfHosted && jwtSecret) {
      // Self-hosted: HS256 symmetric verification
      const key = await getSymmetricKey(jwtSecret);
      const { payload } = await jwtVerify(token, key, {
        audience: 'authenticated',
      });
      return payload as unknown as SupabaseJwtPayload;
    } else {
      // Hosted: asymmetric JWKS verification
      const JWKS = getJWKS(supabaseUrl);
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: `${issuerUrl}/auth/v1`,
        audience: 'authenticated',
      });
      return payload as unknown as SupabaseJwtPayload;
    }
  } catch (error) {
    console.error('[Auth] JWT verification failed:', {
      error: error instanceof Error ? error.message : String(error),
      mode: selfHosted ? 'symmetric' : 'jwks',
      supabaseUrl,
      issuerUrl,
      tokenLength: token.length,
    });
    return null;
  }
}

/**
 * Extract authenticated user from request via Supabase JWT.
 * Returns AuthResult or an error Response.
 */
export async function extractAuthFromRequest(
  request: Request,
  headers: Record<string, string>
): Promise<AuthResult | Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;

  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse<ErrorResponse>({ error: 'Missing authorization' }, 401, headers);
  }

  const token = authHeader.slice(7);
  const payload = await verifySupabaseJwt(token, supabaseUrl);
  if (!payload) {
    return jsonResponse<ErrorResponse>({ error: 'Invalid or expired token' }, 401, headers);
  }

  if (!payload.email) {
    return jsonResponse<ErrorResponse>({ error: 'Token missing email claim' }, 401, headers);
  }

  return { userId: payload.sub, email: payload.email.toLowerCase() };
}
