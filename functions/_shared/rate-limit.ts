/**
 * In-memory sliding-window rate limiter.
 * State is per-isolate (best-effort on Deno Deploy — each cold start resets).
 */

const windows = new Map<string, number[]>();

// Sweep stale keys every 60 seconds to prevent unbounded memory growth
const SWEEP_INTERVAL_MS = 60_000;
const MAX_WINDOW_MS = 60_000; // longest window used by any rate limit

setInterval(() => {
  const now = Date.now();
  const cutoff = now - MAX_WINDOW_MS;
  for (const [key, timestamps] of windows) {
    // If the newest timestamp is older than the longest window, evict entirely
    if (timestamps.length === 0 || timestamps[timestamps.length - 1] <= cutoff) {
      windows.delete(key);
    }
  }
}, SWEEP_INTERVAL_MS);

/** Evict expired timestamps and return current count. */
function cleanAndCount(key: string, windowMs: number, now: number): number {
  const timestamps = windows.get(key);
  if (!timestamps) return 0;

  const cutoff = now - windowMs;
  // Find first index that's within the window
  let i = 0;
  while (i < timestamps.length && timestamps[i] <= cutoff) i++;

  if (i > 0) {
    timestamps.splice(0, i);
    if (timestamps.length === 0) {
      windows.delete(key);
      return 0;
    }
  }
  return timestamps.length;
}

/**
 * Check rate limit for a given key.
 * Returns { allowed, remaining, retryAfterMs }.
 */
export function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number,
): { allowed: boolean; remaining: number; retryAfterMs: number } {
  const now = Date.now();
  const count = cleanAndCount(key, windowMs, now);

  if (count >= maxRequests) {
    const timestamps = windows.get(key)!;
    const oldestInWindow = timestamps[0];
    const retryAfterMs = oldestInWindow + windowMs - now;
    return { allowed: false, remaining: 0, retryAfterMs: Math.max(retryAfterMs, 0) };
  }

  // Record this request
  if (!windows.has(key)) windows.set(key, []);
  windows.get(key)!.push(now);

  return { allowed: true, remaining: maxRequests - count - 1, retryAfterMs: 0 };
}

/**
 * Extract a rate-limit key from the request.
 * Prefers auth token hash, falls back to IP.
 */
function getRateLimitKey(request: Request, prefix: string): string {
  const auth = request.headers.get('Authorization') || '';
  if (auth) {
    // Use a simple hash of the token for privacy
    let hash = 0;
    for (let i = 0; i < auth.length; i++) {
      hash = ((hash << 5) - hash + auth.charCodeAt(i)) | 0;
    }
    return `${prefix}:auth:${hash}`;
  }

  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('cf-connecting-ip') ||
    'unknown';
  return `${prefix}:ip:${ip}`;
}

/**
 * High-level helper: check rate limit and return a 429 Response if exceeded, or null if allowed.
 * Call right after CORS preflight handling.
 */
export function rateLimitResponse(
  request: Request,
  headers: Record<string, string>,
  maxRequests: number,
  windowMs: number,
  prefix: string,
): Response | null {
  const key = getRateLimitKey(request, prefix);
  const result = checkRateLimit(key, maxRequests, windowMs);

  if (!result.allowed) {
    const retryAfterSec = Math.ceil(result.retryAfterMs / 1000);
    return new Response(
      JSON.stringify({ error: 'Too many requests. Please try again later.' }),
      {
        status: 429,
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Retry-After': String(retryAfterSec),
        },
      },
    );
  }

  return null;
}
