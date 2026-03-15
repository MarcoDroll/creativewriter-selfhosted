/**
 * CORS headers for cross-origin requests.
 * Self-hosted: allow all origins. Hosted: restrict to known origins.
 */
export function corsHeaders(origin: string): Record<string, string> {
  // Self-hosted: allow all origins (frontend is on the same host)
  const selfHosted = Deno.env.get('SELF_HOSTED') === 'true';
  if (selfHosted) {
    return {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, X-Client-Name, X-Client-Version, Accept, anthropic-version, anthropic-beta, X-API-Token, X-License-Key, Prefer',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
  }

  const allowed = [
    'https://creativewriter-hosted.pages.dev',
    'https://creativewriter-hosted-dev.pages.dev',
  ];

  // Extract base URL from SUCCESS_URL if it differs (e.g. custom domain)
  const successUrl = Deno.env.get('SUCCESS_URL');
  if (successUrl) {
    try {
      const parsed = new URL(successUrl);
      if (parsed.protocol === 'https:') {
        const successOrigin = parsed.origin;
        if (!allowed.includes(successOrigin)) {
          allowed.push(successOrigin);
        }
      } else {
        console.warn('[CORS] SUCCESS_URL rejected: not HTTPS:', successUrl);
      }
    } catch {
      console.warn('[CORS] SUCCESS_URL rejected: malformed URL:', successUrl);
    }
  }

  // Allow localhost in dev (non-live Stripe key = dev environment)
  const stripeKey = Deno.env.get('STRIPE_API_KEY') || '';
  if (stripeKey && !stripeKey.startsWith('sk_live')) {
    allowed.push('http://localhost:4200');
  }

  // Check environment variable for additional allowed origins
  const env = Deno.env.get('ENVIRONMENT');
  if (env === 'development') {
    if (!allowed.includes('http://localhost:4200')) {
      allowed.push('http://localhost:4200');
    }
  }

  // Allow Cloudflare Pages preview deployments
  const isPreviewDeploy = (
    origin.endsWith('.creativewriter-hosted.pages.dev') ||
    origin.endsWith('.creativewriter-hosted-dev.pages.dev')
  ) && origin.startsWith('https://');

  const effectiveOrigin = allowed.includes(origin) || isPreviewDeploy
    ? origin : allowed[0];

  return {
    'Access-Control-Allow-Origin': effectiveOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, X-Client-Name, X-Client-Version, Accept, anthropic-version, anthropic-beta, X-API-Token, X-License-Key, Prefer',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

/** Handle CORS preflight — return early if OPTIONS */
export function handleCorsPreflightIfNeeded(
  request: Request,
  headers: Record<string, string>
): Response | null {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }
  return null;
}

/** JSON response helper */
export function jsonResponse<T>(data: T, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
  });
}
