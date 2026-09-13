/**
 * How a Deep Writer upstream failure becomes an {@link UpstreamError}.
 *
 * The sibling of `premium/portrait-upstream.ts`, and deliberately a different ladder.
 * That one classifies **OpenRouter** and can read OpenRouter's own body shape
 * (`error.metadata.raw`, `error.code`). This one serves **four** providers —
 * `openrouter:`, `included:` (DeepSeek), and the operator's own `ollama:` /
 * `openaiCompatible:` servers — which agree on almost nothing about their error
 * bodies. The one thing they do agree on is the HTTP status, so this keys on status
 * first and on text only where a status cannot say it.
 *
 * The line it replaces existed four times, spelled identically:
 *
 *     throw new Error(`Model API error (${status}): ${text.substring(0, 200)}`);
 *
 * That flattens the status into an English sentence at the throw site, so no catch
 * downstream can see it. Every `/plan`, `/research` and `/analyze` failure reached the
 * author as a raw `HTTP 500: {"error":"Planning error"}` blob, and every `/draft`
 * failure as the literal string `Draft error`.
 *
 * The ladder, in order:
 *
 *   1. 429, or a body saying "rate limit"        → `rate-limited`,     429
 *   2. 401 / 403                                 → `api-key-invalid`, **502**
 *   3. moderation / flagged / content filter     → `moderation`,       400
 *   4. otherwise                                 → `provider-message`, 502
 *
 * **Rung 2 answers 502 on purpose, never 401/403.** The client's
 * `providerCodeFromStatus` maps 401 → `auth-required` and 403 →
 * `subscription-required`, and both of those mean *this app's* session. Answering 401
 * for a rejected **OpenRouter** key would tell the author to sign in — advice that is
 * wrong and unactionable. 502 degrades to `provider-unavailable` on a client too old to
 * know `api-key-invalid`, which is merely vague rather than misleading.
 *
 * **The 200-char body cap is load-bearing, not a copy of premium's 500.**
 * `model-calling.ts` names the echoed upstream body an accepted SSRF residual for local
 * providers — "a debugging aid rather than a scanning primitive". It stays a debugging
 * aid only while it is short. The cap is applied before the regexes run, so a body that
 * says "rate limit" only at char 900 is not seen; that is the same trade premium makes,
 * and the alternative is scanning an unbounded body we then discard.
 */

import { UpstreamError } from './api-errors.ts';

/** See the SSRF residual note above before raising this. */
const MAX_RELAYED_BODY = 200;

const RATE_LIMIT_RE = /rate.?limit/i;
/** The three spellings providers use for "refused on content grounds". */
const MODERATION_RE = /moderation|flagged|content.?filter/i;

/**
 * Classify a non-2xx response from a Deep Writer model call.
 *
 * `label` names the call that failed ('Model API error', 'Research agent API error',
 * 'Analyzer model error') and is what the relayed sentence is prefixed with. `rawBody`
 * is the response text, JSON or not — a body that will not parse is not an error here,
 * it just becomes the relayed text.
 *
 * The English `message` is built the same way on every rung: it is the log line, and for
 * `provider-message` it is the only information there is. The `code` is what the client
 * translates.
 */
export function classifyUpstreamFailure(
  status: number,
  rawBody: string,
  label: string,
): UpstreamError {
  const body = (rawBody || '').substring(0, MAX_RELAYED_BODY);
  const message = `${label} (${status}): ${body}`;

  if (status === 429 || RATE_LIMIT_RE.test(body)) {
    return new UpstreamError('rate-limited', message, 429);
  }

  if (status === 401 || status === 403) {
    return new UpstreamError('api-key-invalid', message, 502);
  }

  if (MODERATION_RE.test(body)) {
    return new UpstreamError('moderation', message, 400);
  }

  return new UpstreamError('provider-message', message, 502);
}
