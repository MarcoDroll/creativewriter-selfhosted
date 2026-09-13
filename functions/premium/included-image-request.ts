import { FAL_USD_PER_BILLABLE_UNIT } from '../_shared/ai-usage.ts';
import type { IncludedImageSize, IncludedImageSizeInput } from '../_shared/types.ts';

/**
 * Request validation for the included (subsidised) image endpoint.
 *
 * Split out of `index.ts` so it can be exercised directly: that file calls `Deno.serve` at import
 * time, so nothing inside it is reachable from a test.
 */

export const ALLOWED_IMAGE_SIZES: IncludedImageSize[] = [
  'square_hd', 'square', 'portrait_4_3', 'portrait_16_9', 'landscape_4_3', 'landscape_16_9',
];

/**
 * Two models, and which one runs is decided by the request rather than configured.
 *
 * A request carrying `image_urls` is the beat-illustration path and needs an editor that reads
 * reference images; everything else — covers, codex portraits — is plain text-to-image and stays
 * on schnell, which is cheaper and unchanged.
 */
export const INCLUDED_REFERENCE_MODEL = 'fal-ai/flux-2/klein/4b/edit';
export const INCLUDED_PLAIN_MODEL = 'fal-ai/flux/schnell';

/**
 * fal's own ceiling on this endpoint: "A maximum of 4 images are allowed" (`image_urls` in its
 * published schema for {@link INCLUDED_REFERENCE_MODEL}, read 2026-08-28).
 *
 * The per-tier cap is clamped to it rather than merely being under it today, so a tier cap raised
 * later turns into an honest refusal here instead of a 422 from fal that nobody expected.
 */
export const FAL_MAX_REFERENCE_IMAGES = 4;

/**
 * A single reference, in `data:` URL characters, and the whole array.
 *
 * The client compresses each reference to 75 KB / 512 px before sending, which is ~100k base64
 * characters. These are four times that: generous enough that a legitimate request never trips
 * them, tight enough that the function is not asked to hold megabytes per call.
 */
export const MAX_REFERENCE_CHARS = 400_000;
/**
 * Deliberately HALF the client's own ceiling (`MAX_REFERENCE_PAYLOAD_CHARS` in
 * `beat-illustration.service.ts`, 3,000,000). That one bounds up to six references for the own-key
 * providers; this path takes at most four, so the tighter number is the right one here and the two
 * are not meant to match. Neither is reachable at the compression the client applies.
 */
export const MAX_REFERENCE_PAYLOAD_CHARS = 1_500_000;

/**
 * **The real cost control**, now that reference count is known not to be one.
 *
 * fal meters {@link INCLUDED_REFERENCE_MODEL} per OUTPUT megapixel, so the pixel count IS the
 * charge. An explicit `{width, height}` is accepted precisely so the four aspect ratios the app
 * offers come out exact — and that same field, unbounded, would let a caller ask for fal's
 * 14142x14142 maximum and put ~$2 on the shared monthly budget in a single request. 1.4 MP leaves
 * room above the ~1.05 MP the client asks for without leaving room for that.
 */
export const MAX_INCLUDED_PIXELS = 1_400_000;
export const MIN_INCLUDED_DIMENSION = 256;

/**
 * What to charge when fal answers without a readable `x-fal-billable-units`.
 *
 * The largest unit count a request inside {@link MAX_INCLUDED_PIXELS} could have billed, so an
 * unreadable header over-meters rather than giving the render away.
 */
export const REFERENCE_FALLBACK_COST_USD =
  MAX_INCLUDED_PIXELS / 1_000_000 * FAL_USD_PER_BILLABLE_UNIT;

/** `null` when the size is acceptable, otherwise the message to send back with a 400. */
export function validateImageSize(size: IncludedImageSizeInput): string | null {
  if (typeof size === 'string') {
    return ALLOWED_IMAGE_SIZES.includes(size)
      ? null
      : `image_size must be one of: ${ALLOWED_IMAGE_SIZES.join(', ')}, or {width, height}`;
  }
  if (typeof size !== 'object' || size === null || Array.isArray(size)) {
    return 'image_size must be a size token or a {width, height} object';
  }
  const { width, height } = size as { width: unknown; height: unknown };
  for (const [name, value] of [['width', width], ['height', height]] as const) {
    if (!Number.isInteger(value) || (value as number) < MIN_INCLUDED_DIMENSION) {
      return `image_size.${name} must be an integer of at least ${MIN_INCLUDED_DIMENSION}`;
    }
  }
  if ((width as number) * (height as number) > MAX_INCLUDED_PIXELS) {
    return `image_size may not exceed ${MAX_INCLUDED_PIXELS} pixels`;
  }
  return null;
}

/**
 * The outcome of validating `image_urls`.
 *
 * `code` is set only where the refusal is one an AUTHOR can reach without a bug — the tier cap,
 * which a subscription changing mid-session can trip — because that is the one that needs
 * translating. The rest name a malformed field and stay uncoded, as every other validation 400 on
 * this function does.
 */
export type ReferenceCheck =
  | { readonly ok: true; readonly urls: string[] }
  | { readonly ok: false; readonly error: string; readonly code?: 'reference-limit' };

/**
 * Validate the reference array against the caller's tier.
 *
 * `hasPrompt` rather than the prompt itself: references are only meaningful on the ready-made
 * prompt path. The structured portrait path builds its own prompt from one codex entry and has no
 * line-up to reference, so a request combining the two is a caller bug, not a shape to support.
 */
export function checkReferences(
  imageUrls: unknown,
  hasPrompt: boolean,
  tierCap: number,
): ReferenceCheck {
  if (imageUrls === undefined) return { ok: true, urls: [] };
  if (!Array.isArray(imageUrls) || imageUrls.some(url => typeof url !== 'string')) {
    return { ok: false, error: 'image_urls must be an array of data: URLs' };
  }

  const urls = (imageUrls as string[]).filter(url => url.length > 0);
  if (urls.length === 0) return { ok: true, urls: [] };

  // Shape before plan, and the order is deliberate. A request with references and no prompt is a
  // caller bug — no UI can produce one — so answering it with the translated "your plan allows N"
  // would hand the author copy about their subscription for something their subscription has
  // nothing to do with. The bug-shaped refusal wins when both would fire.
  if (!hasPrompt) {
    return { ok: false, error: 'image_urls requires prompt' };
  }

  const cap = Math.min(tierCap, FAL_MAX_REFERENCE_IMAGES);
  if (urls.length > cap) {
    return {
      ok: false,
      error: `Your plan allows ${cap} reference image${cap === 1 ? '' : 's'}, not ${urls.length}.`,
      code: 'reference-limit',
    };
  }

  let payloadChars = 0;
  for (const url of urls) {
    if (!url.startsWith('data:image/')) {
      return { ok: false, error: 'image_urls entries must be data:image/ URLs' };
    }
    if (url.length > MAX_REFERENCE_CHARS) {
      return { ok: false, error: 'a reference image is too large' };
    }
    payloadChars += url.length;
  }
  if (payloadChars > MAX_REFERENCE_PAYLOAD_CHARS) {
    return { ok: false, error: 'the reference images are too large in total' };
  }
  return { ok: true, urls };
}

/**
 * Why fal refused, told apart rather than assumed.
 *
 * Every 400/422 from fal used to become `code: 'moderation'` — "The image prompt was rejected. Try
 * adjusting the description." But fal answers **422 for a schema violation too**: a field it does
 * not accept, a value out of range, a malformed reference. So a bug in the body we send reached the
 * author as an accusation about their writing, and reworking the description could never fix it.
 *
 * That is the repo's own rule stated the other way round — classify the PROVIDER's body, never our
 * own sentence — and it matters most exactly here, on the path that just grew a new request shape.
 *
 * **Defaults to relaying rather than to blaming.** Getting it wrong towards `request` shows the
 * author a technical sentence, which is confusing; getting it wrong towards `moderation` tells them
 * to rewrite prose that was never the problem, and hides a malformed request from us permanently.
 */
export type FalRefusal =
  | { readonly kind: 'moderation' }
  | { readonly kind: 'request'; readonly detail: string };

/**
 * Markers fal uses when its content checker is what refused.
 *
 * `content_policy_violation` is the measured one (`scripts/probes/included-klein-4b.sh`, which saw
 * it with `loc: ["body","image_urls",0]` — note fal attributes a refusal to an INPUT IMAGE, not
 * only to the prompt, which is why the copy for this case may not blame the description alone).
 * The others are defensive spellings; an unrecognised body falls through to `request` and is
 * relayed, so a missed spelling costs a confusing message rather than a wrong accusation.
 */
const CONTENT_REFUSAL = /content[_ -]?polic|nsfw|safety[_ -]?check|moderat|explicit content/i;

export function classifyFalRefusal(body: string): FalRefusal {
  if (CONTENT_REFUSAL.test(body)) return { kind: 'moderation' };
  return { kind: 'request', detail: falValidationDetail(body) };
}

/**
 * The most useful sentence fal's validation body holds, as a single line.
 *
 * fal answers FastAPI's shape — `{ detail: [{ loc, msg, type }] }` — where `loc` names the field.
 * The field is the whole diagnosis ("image_size" vs "image_urls" are completely different bugs), so
 * it is kept alongside the message rather than dropped for tidiness.
 */
function falValidationDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown };
    const first = Array.isArray(parsed.detail) ? parsed.detail[0] : parsed.detail;
    if (typeof first === 'string') return first.slice(0, 200);
    if (first && typeof first === 'object') {
      const { loc, msg } = first as { loc?: unknown; msg?: unknown };
      const field = Array.isArray(loc) ? loc.join('.') : '';
      const message = typeof msg === 'string' ? msg : '';
      const joined = [field, message].filter(Boolean).join(': ');
      if (joined) return joined.slice(0, 200);
    }
  } catch {
    // Not JSON — fall through to the raw text, which is still better than inventing a reason.
  }
  return body.trim().slice(0, 200) || 'no detail';
}
