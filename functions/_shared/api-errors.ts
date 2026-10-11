/**
 * A thrown failure that already knows its `ApiErrorCode` and HTTP status.
 *
 * Until this existed, nothing in the edge functions carried an `ApiErrorCode` at
 * *runtime*: `types.ts` is type-only and `ModelProviderConfigError` has no code. So a
 * handler that wanted to answer 400-vs-429-vs-502 had to re-derive it downstream, and
 * the only thing available downstream was the English sentence it had thrown itself —
 * `message.startsWith('DeepSeek API error:')`. That ladder was both wrong (the call it
 * named was an OpenRouter one) and load-bearing (fixing the label alone dropped the
 * failure into the generic 500 arm).
 *
 * The rule this replaces it with: **classify where the signal is, throw the verdict.**
 * A classifier runs where the HTTP status and the parsed body are still in scope,
 * decides once, and the catch just renders. Nothing re-reads prose to guess a status.
 *
 * `message` stays the English sentence on purpose — it is the log line, and it is what
 * `provider-message` relays when upstream's own wording is the only information there
 * is. `code` is what the client translates.
 */

import { jsonResponse } from './cors.ts';
import type { ApiErrorCode, ErrorResponse } from './types.ts';

export class UpstreamError extends Error {
  constructor(
    /** What the client maps to a `providerError.<code>` catalog key. */
    readonly code: ApiErrorCode,
    message: string,
    /** The HTTP status to answer with. A client too old to know `code` infers from it. */
    readonly status: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

/**
 * Render an {@link UpstreamError} as the error response.
 *
 * Owns the 500-char cap so no call site has to remember it: relayed upstream bodies
 * are unbounded, and a whole provider stack trace in a toast helps nobody.
 */
export function upstreamErrorResponse(
  err: UpstreamError,
  headers: Record<string, string>,
): Response {
  return jsonResponse<ErrorResponse>(
    { error: err.message.slice(0, 500), code: err.code },
    err.status,
    headers,
  );
}
