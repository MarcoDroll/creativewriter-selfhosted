/**
 * How an OpenRouter failure becomes an {@link UpstreamError}.
 *
 * This is the classification that used to live inline in `generateImage` /
 * `generateImagePrompt` as **eleven** bare `throw new Error(...)` sites, re-read
 * afterwards by a ladder of `message.startsWith(...)` and `/rate limit/i` tests in
 * `handleGeneratePortrait`'s catch. Pulling it out is what lets the decision happen
 * where the HTTP status and the parsed JSON are still in scope — the reason the old
 * ladder had to guess at all.
 *
 * **Classifying our own sentence is the anti-pattern; classifying the provider's
 * response is not.** OpenRouter says "rate limit" in prose about as often as it sets a
 * code for it, so text matching stays — it just runs here, on upstream's body, with
 * structured signals (`error.metadata.raw`, `error.code`, the HTTP status) winning.
 *
 * One ladder, used by both entry points, in this order:
 *
 *   1. moderation — `raw.status === 'Request Moderated'`, or /moderation|flagged/  → 400
 *   2. rate limit — `error.code === 429`, HTTP 429, or /rate.?limit/               → 429
 *   3. otherwise  — relay upstream's own sentence                                  → 502
 *
 * It is a **superset** of what the old ladder caught: nothing that answered 400 or 429
 * before answers 502 now. Several things that answered 502 now answer 400 or 429, and
 * they are worth enumerating, because this paragraph is what the next reader will diff
 * against:
 *
 *   - **HTTP 429 with a body that never spells "rate limit"** used to fall through.
 *   - **The whole prompt-building call.** It had no structured classification at all —
 *     it threw one unparsed sentence and let the outer regex ladder read it. So a
 *     moderated prompt build answered 502, because OpenRouter's moderation payload says
 *     `"status":"Request Moderated"`, which contains neither "content moderation" nor
 *     "flagged". It now runs the same ladder as the image call.
 *   - **An already-parsed `metadata.raw`.** The non-2xx branch only handled the JSON
 *     *string* spelling; handed an object it threw a SyntaxError at itself, swallowed it
 *     because the message contained "JSON", and fell through. See isModeratedRawMetadata.
 *
 * All three are strictly fewer failures landing in the generic bucket, which is the
 * point — but none of them is a no-op, so none should be described as one.
 *
 * **One case moves the other way, and it is not a widening: 429 → 400.** Both old
 * branches checked `error.code === 429` *before* they ever looked at the message, so a
 * structural 429 won unconditionally and its text was discarded. Here moderation is
 * checked first in both classifiers, so a body carrying `error.code: 429` AND a message
 * saying "flagged"/"moderation" now answers 400 instead of 429. Accepted deliberately:
 * one order in both classifiers is worth more than bug-compatibility with an input
 * OpenRouter is not known to produce, and being refused on content is the more
 * actionable of the two things such a body claims. Pinned by a test so it stays a
 * decision rather than drift.
 *
 * Moderation answers `provider-message`, not `moderation`, even where the sentence is
 * ours. That is a deliberate hold-over: switching it changes what users see, so it is
 * its own commit. See the plan's *Non-goals*.
 */

import { UpstreamError } from '../_shared/api-errors.ts';

/** Our own copy, for when upstream signalled moderation structurally and said nothing useful. */
const MODERATION_MESSAGE =
  'The portrait prompt was flagged by content moderation. Try adjusting the character description to be less suggestive or explicit.';

/**
 * Our own copy for a throttle.
 *
 * This is the wording the *response* carried before, not the wording the inner throw
 * did — the old catch replaced the message on its way out. Keeping the response's
 * version is what makes the extraction byte-identical on the wire.
 */
const RATE_LIMIT_MESSAGE = 'Image provider rate limit reached. Please wait a moment and try again.';

const MODERATION_RE = /moderation|flagged/i;
const RATE_LIMIT_RE = /rate.?limit/i;
/** OpenRouter and its upstreams disagree on the spelling; all three mean refused-on-content. */
const CONTENT_FILTER_RE = /content_filter|safety|filter/i;

/** What the two fallback sentences call the call that failed. */
export interface FailureLabels {
  /** Prefix when upstream gave us a message to relay. */
  relay: string;
  /** Prefix when it did not, and the raw body is all we have. */
  generic: string;
}

const IMAGE_LABELS: FailureLabels = {
  relay: 'Portrait generation failed',
  generic: 'Image generation failed',
};

/** The prompt-building call. `:369` uses the same wording for the DeepSeek twin of this call. */
export const PROMPT_LABELS: FailureLabels = {
  relay: 'Image prompt generation failed',
  generic: 'Image prompt generation failed',
};

interface OpenRouterErrorBody {
  error?: {
    message?: unknown;
    code?: unknown;
    metadata?: { raw?: unknown };
  };
  choices?: Array<{ finish_reason?: string; native_finish_reason?: string }>;
}

/**
 * OpenRouter nests the origin provider's verbatim body under `error.metadata.raw`,
 * sometimes as a JSON string and sometimes already parsed. Accept both — the old code
 * accepted only a string in one branch and both in the other, for no reason anyone
 * recorded.
 */
function isModeratedRawMetadata(raw: unknown): boolean {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return (parsed as { status?: unknown } | null)?.status === 'Request Moderated';
  } catch {
    // Not JSON. Not a moderation signal either — the text arms below still get a look.
    return false;
  }
}

/**
 * Classify a non-2xx OpenRouter response.
 *
 * `rawBody` is the response text, JSON or not. A body that will not parse is not an
 * error here: it becomes the relayed sentence, and the text arms still read it — which
 * is how an HTML 502 page mentioning "rate limit" still lands on 429.
 */
export function classifyOpenRouterFailure(
  status: number,
  rawBody: string,
  labels: FailureLabels = IMAGE_LABELS,
): UpstreamError {
  let parsed: OpenRouterErrorBody | null = null;
  try {
    parsed = JSON.parse(rawBody) as OpenRouterErrorBody;
  } catch {
    parsed = null;
  }

  if (isModeratedRawMetadata(parsed?.error?.metadata?.raw)) {
    return new UpstreamError('provider-message', MODERATION_MESSAGE, 400);
  }

  const upstreamMessage = parsed?.error?.message;
  // BOTH arms truncate to 500 before the prefix, as well as in `upstreamErrorResponse`.
  // The cap has to be here: the regexes below scan this string, and `upstreamErrorResponse`
  // does not run until after they have. Capping only at the response would mean scanning
  // — and duplicating — an unbounded upstream body twice for no gain, since everything
  // past 500 chars is discarded anyway. The final bytes are identical either way.
  const message = typeof upstreamMessage === 'string' && upstreamMessage
    ? `${labels.relay}: ${upstreamMessage.substring(0, 500)}`
    : `${labels.generic} (${status}): ${rawBody.substring(0, 500)}`;

  if (MODERATION_RE.test(message)) {
    // Upstream's own wording names which part was refused, which our copy cannot — so
    // relay it rather than replacing it with MODERATION_MESSAGE.
    return new UpstreamError('provider-message', message, 400);
  }

  if (parsed?.error?.code === 429 || status === 429 || RATE_LIMIT_RE.test(message)) {
    return new UpstreamError('rate-limited', RATE_LIMIT_MESSAGE, 429);
  }

  return new UpstreamError('provider-message', message, 502);
}

/**
 * Classify an HTTP **200** whose body is an error anyway.
 *
 * OpenRouter does this when an upstream provider (BFL, ByteDance) fails after dispatch,
 * or when moderation triggers late. Returns `null` when the payload looks fine, so the
 * caller can go on to parse an image out of it.
 */
export function classifyOpenRouterPayloadError(data: unknown): UpstreamError | null {
  const body = data as OpenRouterErrorBody | null | undefined;

  if (body?.error) {
    const errMsg = typeof body.error.message === 'string'
      ? body.error.message
      : JSON.stringify(body.error);

    if (isModeratedRawMetadata(body.error.metadata?.raw) || MODERATION_RE.test(errMsg)) {
      return new UpstreamError('provider-message', MODERATION_MESSAGE, 400);
    }

    if (body.error.code === 429 || RATE_LIMIT_RE.test(errMsg)) {
      return new UpstreamError('rate-limited', RATE_LIMIT_MESSAGE, 429);
    }

    return new UpstreamError('provider-message', `${IMAGE_LABELS.relay}: ${errMsg}`, 502);
  }

  // No error object, but the completion may still have been cut off on content grounds.
  const choice = body?.choices?.[0];
  const finishReason = choice?.finish_reason || choice?.native_finish_reason || '';
  if (CONTENT_FILTER_RE.test(finishReason)) {
    return new UpstreamError('provider-message', MODERATION_MESSAGE, 400);
  }

  return null;
}
