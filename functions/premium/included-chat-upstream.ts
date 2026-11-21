/**
 * How a failed DeepSeek answer on the Included chat route (`/ai/chat`) becomes the error response.
 *
 * It used to be one line: every non-OK answer became `{ error: 'AI provider error', code:
 * 'provider-unavailable' }`, with DeepSeek's status passed through for a 4xx. So the author read "The AI
 * provider is unavailable right now. Please try again." for failures a retry cannot fix (a prompt longer
 * than the model's window, a content refusal), the client's toast read a passed-through 401 as the
 * author's own key, and DeepSeek's own sentence went only to the function log.
 *
 * Why not `classifyUpstreamFailure` (`_shared/upstream-classify.ts`): that ladder serves own-key providers
 * too, so a 401/403 there means "your key was rejected, check it in Settings". Here the key and the balance
 * are the **app's**. The author can do nothing about them, and must never be told to.
 *
 * The ladder, in order:
 *
 *   1. 429, or a body saying "rate limit"           → `rate-limited`,         429
 *   2. 408, or a 5xx                                → `provider-timeout` 504 / `provider-unavailable` 502
 *   3. 401 / 402 / 403 (the app's key or balance)  → `provider-unavailable`, **424** ({@link APP_ACCOUNT_REFUSED_STATUS})
 *   4. a content refusal                            → `moderation`,           400
 *   5. any other 4xx                                → **no code**, DeepSeek's sentence relayed, its status
 *
 * **Rung 3 never answers the 4xx it got**, nor a 5xx; {@link APP_ACCOUNT_REFUSED_STATUS} says why.
 *
 * **Rung 5 is uncoded on purpose**, as the backend's other validation 400s are: DeepSeek's sentence names
 * what was wrong, and no translated generic sentence replaces it. It also carries the case that matters
 * most to an author: "This model's maximum context length is … tokens", which the client codes
 * `context-exceeded` from the sentence (`isContextExceededMessage`) and tells them to send less. A code here
 * would stop that, because the client only upgrades an uncoded error. Its status stays a 4xx, so the client
 * does not repeat a request that was decided.
 *
 * The relayed sentence is DeepSeek's `error.message` (OpenAI's body shape) or, failing that, the raw body,
 * capped at {@link MAX_RELAYED_CHARS}.
 */

import type { ErrorResponse } from '../_shared/types.ts';

/**
 * What the app's own DeepSeek key or balance being refused (401/402/403) is answered with: **424 Failed
 * Dependency**. Not the 4xx itself (the client reads 401 as this app's session and 403 as the subscription; its
 * toast reads both as the author's own key), and not a 5xx, because the client's non-streaming fallback retries a
 * 5xx once, and this lasts until the operator notices: every beat would cost two invocations meanwhile. 424 is a
 * decided 4xx the client maps to no code of its own, so `provider-unavailable` sets the copy and nothing retries.
 */
export const APP_ACCOUNT_REFUSED_STATUS = 424;

/** DeepSeek's sentences are short; a whole HTML error page is not worth relaying. */
export const MAX_RELAYED_CHARS = 300;

const RATE_LIMIT_RE = /rate.?limit/i;
/** OpenAI-shaped wordings, and DeepSeek's own ("Content Exists Risk"). */
const MODERATION_RE = /moderation|flagged|content.?filter|content exists risk/i;

/** DeepSeek's own sentence from an error body, or the body itself; capped, never empty unless the body is. */
export function deepseekErrorSentence(rawBody: string): string {
  let sentence = rawBody || '';
  try {
    const parsed = JSON.parse(rawBody) as { error?: { message?: unknown } | string; message?: unknown } | null;
    const candidate = typeof parsed?.error === 'string' ? parsed.error
      : typeof parsed?.error?.message === 'string' ? parsed.error.message
        : typeof parsed?.message === 'string' ? parsed.message : null;
    if (candidate && candidate.trim()) sentence = candidate;
  } catch {
    // Not JSON: relay the text as it came.
  }
  return sentence.trim().slice(0, MAX_RELAYED_CHARS);
}

/** The response body and status for a non-OK DeepSeek answer. See the ladder above. */
export function classifyIncludedChatFailure(status: number, rawBody: string): { body: ErrorResponse; status: number } {
  const sentence = deepseekErrorSentence(rawBody);

  if (status === 429 || RATE_LIMIT_RE.test(sentence)) {
    return { body: { error: 'AI provider rate limit reached', code: 'rate-limited' }, status: 429 };
  }
  if (status === 408 || status === 504) {
    return { body: { error: 'AI provider timed out', code: 'provider-timeout' }, status: 504 };
  }
  if (status >= 500 || status < 400) {
    return { body: { error: 'AI provider error', code: 'provider-unavailable' }, status: 502 };
  }
  if (status === 401 || status === 402 || status === 403) {
    return { body: { error: 'AI provider error', code: 'provider-unavailable' }, status: APP_ACCOUNT_REFUSED_STATUS };
  }
  if (MODERATION_RE.test(sentence)) {
    return {
      body: { error: `The AI provider refused this request on content grounds: ${sentence}`, code: 'moderation' },
      status: 400,
    };
  }
  return {
    body: { error: sentence ? `AI provider rejected the request: ${sentence}` : 'AI provider rejected the request' },
    status,
  };
}
