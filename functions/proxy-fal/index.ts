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

  // Determine target based on sub-path:
  // /proxy-fal/models*        → api.fal.ai/v1/models (for model listing)
  // /proxy-fal/openapi-schema → fal.ai/api/openapi/queue/openapi.json (per-endpoint OpenAPI
  //                             schema — public and unauthenticated at fal, but routed through
  //                             here anyway: it is a different HOST (bare fal.ai, neither
  //                             api.fal.ai nor fal.run) and a browser calling it directly hits
  //                             CORS, since fal sends no Access-Control-Allow-Origin on it
  //                             (confirmed 2026-09-18). Used to auto-detect an image-to-image
  //                             endpoint's real reference-image field — see
  //                             FalImageProvider.deriveReferenceCapabilities.
  // /proxy-fal/*               → fal.run (for synchronous image generation)
  const fullPath = url.pathname.replace(/^\/proxy-fal/, '');
  const isSchemaRoute = fullPath.startsWith('/openapi-schema');

  // **The schema route gets its OWN rate-limit bucket, not the shared `proxy-fal` one.**
  // `FalImageProvider.deriveReferenceCapabilities` fires one call per `image-to-image`-category
  // model on a cold cache — measured 2026-09-18 at 423 such models — which blew straight through
  // the 30-per-60s budget shared with model-listing pagination AND real, billed generation calls.
  // Past request ~30 every further schema fetch 429'd, and the client's own `catch { return null
  // }` treats a 429 identically to "no reference field found", so the auto-detection quietly
  // stopped working for most of the catalogue on the exact load it exists to serve — and the
  // shared bucket meant a generation request landing in the same 60s window could 429 for a
  // reason with nothing to do with generating. This route is a cheap, unauthenticated JSON
  // pass-through fal itself does not meter the way it meters inference — 500/60s is generous
  // headroom for the whole catalogue in one burst while still bounding abuse of this specific
  // proxy path.
  const rateLimit = isSchemaRoute
    ? rateLimitResponse(request, headers, 500, 60_000, 'proxy-fal-schema')
    : rateLimitResponse(request, headers, 30, 60_000, 'proxy-fal');
  if (rateLimit) return rateLimit;

  const apiKey = request.headers.get('X-API-Key') || request.headers.get('X-API-Token');
  if (!apiKey) {
    return jsonResponse<ErrorResponse>({ error: 'Missing X-API-Key header' }, 401, headers);
  }

  let targetUrl: string;
  if (fullPath.startsWith('/models')) {
    targetUrl = `https://api.fal.ai/v1${fullPath}${url.search}`;
  } else if (isSchemaRoute) {
    targetUrl = `https://fal.ai/api/openapi/queue/openapi.json${url.search}`;
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
      // A static-ish JSON schema document should answer in a second or two — bounding it at 15s
      // rather than the 120s every other route needs (a real image render can genuinely take
      // that long) is what stops one straggling endpoint from holding the client's `Promise.all`
      // enrichment pass open for up to two minutes on a cold cache.
      timeout: isSchemaRoute ? 15_000 : 120_000,
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
