import { corsHeaders, handleCorsPreflightIfNeeded, jsonResponse } from '../_shared/cors.ts';
import { fetchWithTimeout, isTimeoutError } from '../_shared/timeout.ts';
import { rateLimitResponse } from '../_shared/rate-limit.ts';
import type { ErrorResponse } from '../_shared/types.ts';

// Proxy for fal.ai API: model listing via api.fal.ai/v1, image generation via fal.run
Deno.serve(async (request: Request) => {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin') || '';
  const headers = corsHeaders(origin);

  const preflight = handleCorsPreflightIfNeeded(request, headers);
  if (preflight) return preflight;

  const rateLimit = rateLimitResponse(request, headers, 30, 60_000, 'proxy-fal');
  if (rateLimit) return rateLimit;

  const apiKey = request.headers.get('X-API-Key') || request.headers.get('X-API-Token');
  if (!apiKey) {
    return jsonResponse<ErrorResponse>({ error: 'Missing X-API-Key header' }, 401, headers);
  }

  // Determine target based on sub-path:
  // /proxy-fal/models* → api.fal.ai/v1/models (for model listing)
  // /proxy-fal/*       → fal.run (for synchronous image generation)
  const fullPath = url.pathname.replace(/^\/proxy-fal/, '');

  let targetUrl: string;
  if (fullPath.startsWith('/models')) {
    targetUrl = `https://api.fal.ai/v1${fullPath}${url.search}`;
  } else {
    targetUrl = `https://fal.run${fullPath}${url.search}`;
  }

  // Build minimal header set — do NOT forward all request headers to third-party APIs
  const proxyHeaders = new Headers();
  proxyHeaders.set('Content-Type', request.headers.get('Content-Type') || 'application/json');
  proxyHeaders.set('Authorization', `Key ${apiKey}`);

  try {
    const proxyResponse = await fetchWithTimeout(targetUrl, {
      method: request.method,
      headers: proxyHeaders,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
      timeout: 120_000,
    });

    const responseHeaders = new Headers(proxyResponse.headers);
    for (const [key, value] of Object.entries(headers)) {
      responseHeaders.set(key, value);
    }

    return new Response(proxyResponse.body, {
      status: proxyResponse.status,
      headers: responseHeaders,
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      console.error('fal.ai proxy timeout');
      return jsonResponse<ErrorResponse>({ error: 'Upstream request timed out' }, 504, headers);
    }
    console.error('fal.ai proxy error:', err);
    return jsonResponse<ErrorResponse>({ error: 'Upstream service unavailable' }, 502, headers);
  }
});
