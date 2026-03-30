import { corsHeaders, handleCorsPreflightIfNeeded, jsonResponse } from '../_shared/cors.ts';
import { fetchWithTimeout, isTimeoutError } from '../_shared/timeout.ts';
import { rateLimitResponse } from '../_shared/rate-limit.ts';
import type { ErrorResponse } from '../_shared/types.ts';

Deno.serve(async (request: Request) => {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin') || '';
  const headers = corsHeaders(origin);

  const preflight = handleCorsPreflightIfNeeded(request, headers);
  if (preflight) return preflight;

  const rateLimit = rateLimitResponse(request, headers, 60, 60_000, 'proxy-gemini');
  if (rateLimit) return rateLimit;

  const apiKey = request.headers.get('X-API-Key');
  if (!apiKey) {
    return jsonResponse<ErrorResponse>({ error: 'Missing X-API-Key header' }, 401, headers);
  }

  // Strip /proxy-gemini prefix, forward rest to Google API
  const targetPath = url.pathname.replace(/^\/proxy-gemini/, '');
  const targetUrl = `https://generativelanguage.googleapis.com${targetPath}${url.search}`;

  const proxyHeaders = new Headers();
  proxyHeaders.set('Content-Type', request.headers.get('Content-Type') || 'application/json');
  proxyHeaders.set('x-goog-api-key', apiKey);

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
      console.error('Gemini proxy timeout');
      return jsonResponse<ErrorResponse>({ error: 'Upstream request timed out' }, 504, headers);
    }
    console.error('Gemini proxy error:', err);
    return jsonResponse<ErrorResponse>({ error: 'Upstream service unavailable' }, 502, headers);
  }
});
