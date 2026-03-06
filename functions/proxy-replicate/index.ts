import { corsHeaders, handleCorsPreflightIfNeeded, jsonResponse } from '../_shared/cors.ts';
import type { ErrorResponse } from '../_shared/types.ts';

Deno.serve(async (request: Request) => {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin') || '';
  const headers = corsHeaders(origin);

  const preflight = handleCorsPreflightIfNeeded(request, headers);
  if (preflight) return preflight;

  // Support both X-API-Key and X-API-Token for Replicate
  const apiKey = request.headers.get('X-API-Key') || request.headers.get('X-API-Token');
  if (!apiKey) {
    return jsonResponse<ErrorResponse>({ error: 'Missing X-API-Key header' }, 401, headers);
  }

  // Strip /proxy-replicate prefix, forward rest to Replicate API
  const targetPath = url.pathname.replace(/^\/proxy-replicate/, '') + url.search;
  const targetUrl = `https://api.replicate.com/v1${targetPath}`;

  // Build minimal header set — do NOT forward all request headers to third-party APIs
  const proxyHeaders = new Headers();
  proxyHeaders.set('Content-Type', request.headers.get('Content-Type') || 'application/json');
  proxyHeaders.set('Authorization', `Bearer ${apiKey}`);
  const prefer = request.headers.get('Prefer');
  if (prefer) proxyHeaders.set('Prefer', prefer);

  try {
    const proxyResponse = await fetch(targetUrl, {
      method: request.method,
      headers: proxyHeaders,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
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
    console.error('Replicate proxy error:', err);
    return jsonResponse<ErrorResponse>({ error: 'Upstream service unavailable' }, 502, headers);
  }
});
