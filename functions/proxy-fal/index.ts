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
  // /proxy-fal/queue/*        → queue.fal.run (submit, poll status, collect result)
  // /proxy-fal/*               → fal.run (synchronous image generation; still used by nothing
  //                             on the image path, kept for any caller that wants one call)
  const fullPath = url.pathname.replace(/^\/proxy-fal/, '');
  const isSchemaRoute = fullPath.startsWith('/openapi-schema');
  // A THIRD host, and the reason the image path uses it: `fal.run` answers one synchronous
  // request and keeps nothing, so a render whose tab is frozen or discarded mid-flight — routine
  // on a phone — cannot be asked about afterwards. `queue.fal.run` hands back a `request_id` and
  // a status URL that outlive the tab. No fal endpoint id begins with `queue/` (they are all
  // `owner/model[/variant]`), so this prefix cannot shadow a real endpoint.
  const isQueueRoute = fullPath.startsWith('/queue/');

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
  // **Queue POLLING gets its own bucket too, for the same reason and with the same shape.**
  // A queued render is watched by repeated GETs on its status path — a 60s render at a ~2s
  // interval is ~30 of them, which is the ENTIRE shared budget for one image, and two concurrent
  // renders would 429 each other's polling and leave both looking failed while both were in fact
  // succeeding. These are unauthenticated-cheap status reads at fal, not billed inference, so
  // they are metered like the schema route rather than like generation. The SUBMIT (a POST on the
  // same prefix) is real inference and deliberately stays on the shared generation bucket.
  const isQueuePoll = isQueueRoute && (request.method === 'GET' || request.method === 'HEAD');
  const rateLimit = isSchemaRoute
    ? rateLimitResponse(request, headers, 500, 60_000, 'proxy-fal-schema')
    : isQueuePoll
      ? rateLimitResponse(request, headers, 500, 60_000, 'proxy-fal-queue')
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
  } else if (isQueueRoute) {
    // The client sends the path fal itself handed back (host stripped), never a whole URL — this
    // proxy only ever reaches queue.fal.run, so a tampered stored path cannot redirect it
    // somewhere else.
    targetUrl = `https://queue.fal.run${fullPath.replace(/^\/queue/, '')}${url.search}`;
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
      // A queue POLL is the same shape of cheap JSON read as the schema route — it returns the
      // current status immediately and never waits on the render — so it gets the short bound
      // too. The queue SUBMIT and the synchronous route keep the long one, because those are
      // where a real render's time is actually spent.
      timeout: isSchemaRoute || isQueuePoll ? 15_000 : 120_000,
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
