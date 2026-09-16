/**
 * Deno tests for the included-image request guards.
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/premium/included-image-request.test.ts
 *
 * Two of these guard money rather than shape, and they are the reason this file exists:
 *
 * - **The pixel ceiling.** fal meters `fal-ai/flux-2/klein/4b/edit` per output megapixel, so
 *   accepting an explicit `{width, height}` — which the app needs, or "3:2" comes back as 4:3 —
 *   hands the caller the cost dial. Without the cap one request can bill ~$2 against a $1 monthly
 *   budget.
 * - **The tier cap.** It is enforced here precisely because the browser also enforces it; a
 *   client that lies about its tier must not get four references.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  FAL_MAX_REFERENCE_IMAGES,
  MAX_INCLUDED_PIXELS,
  MAX_REFERENCE_CHARS,
  MAX_REFERENCE_PAYLOAD_CHARS,
  REFERENCE_FALLBACK_COST_USD,
  checkReferences,
  classifyFalRefusal,
  validateImageSize,
} from './included-image-request.ts';
import {
  FAL_USD_PER_BILLABLE_UNIT,
  REFERENCE_CAP_BY_TIER,
  imageCostFromBillableUnits,
} from '../_shared/ai-usage.ts';

const dataUrl = (chars: number) => 'data:image/jpeg;base64,' + 'A'.repeat(chars);
const REF = dataUrl(100);

Deno.test('validateImageSize accepts fal size tokens', () => {
  assertEquals(validateImageSize('landscape_4_3'), null);
  assertEquals(validateImageSize('square_hd'), null);
});

Deno.test('validateImageSize rejects a token fal does not have', () => {
  assertEquals(typeof validateImageSize('landscape_3_2' as never), 'string');
});

Deno.test('validateImageSize accepts the exact sizes the client sends', () => {
  // The four offered aspect ratios, as `included-image-size.ts` computes them. A token cannot
  // express 3:2 at all — the nearest is landscape_4_3, 12% out — which is why the object form is
  // accepted, and therefore why the ceiling below has to exist.
  for (const size of [
    { width: 1248, height: 832 },   // 3:2
    { width: 1280, height: 720 },   // 16:9
    { width: 1024, height: 1024 },  // 1:1
    { width: 832, height: 1248 },   // 2:3
  ]) {
    assertEquals(validateImageSize(size), null, JSON.stringify(size));
  }
});

Deno.test('validateImageSize refuses a size that would outspend the monthly budget', () => {
  // fal's own maximum is 14142 per side. At $0.01/megapixel that single request is ~$2 — twice
  // the whole Basic monthly budget.
  assertEquals(typeof validateImageSize({ width: 14142, height: 14142 }), 'string');
  assertEquals(typeof validateImageSize({ width: 2000, height: 2000 }), 'string');
  // Just inside and just outside, so the check is the ceiling rather than something near it.
  assertEquals(validateImageSize({ width: 1400, height: 1000 }), null);
  assertEquals(typeof validateImageSize({ width: 1400, height: 1001 }), 'string');
  assertEquals(1400 * 1000, MAX_INCLUDED_PIXELS);
});

Deno.test('validateImageSize refuses non-integer, negative and malformed sizes', () => {
  for (const size of [
    { width: 1024.5, height: 1024 },
    { width: -1024, height: 1024 },
    { width: 0, height: 1024 },
    { width: 128, height: 1024 },
    { width: '1024', height: 1024 },
    { height: 1024 },
    [1024, 1024],
    null,
  ] as never[]) {
    assertEquals(typeof validateImageSize(size), 'string', JSON.stringify(size));
  }
});

Deno.test('checkReferences passes an absent or empty array through as no references', () => {
  assertEquals(checkReferences(undefined, true, 4), { ok: true, urls: [] });
  assertEquals(checkReferences([], true, 4), { ok: true, urls: [] });
  assertEquals(checkReferences([''], true, 4), { ok: true, urls: [] });
});

Deno.test('checkReferences enforces the caller TIER, not fal maximum', () => {
  const basic = checkReferences([REF, REF, REF], true, REFERENCE_CAP_BY_TIER.basic);
  assertEquals(basic.ok, false);
  assertEquals(basic.ok === false && basic.code, 'reference-limit');

  // The same request from a premium caller is fine — which is what makes the refusal a tier
  // decision rather than a shape one.
  assertEquals(checkReferences([REF, REF, REF], true, REFERENCE_CAP_BY_TIER.premium).ok, true);
});

Deno.test('a trial is capped with basic, not with premium', () => {
  assertEquals(REFERENCE_CAP_BY_TIER.app_trial, REFERENCE_CAP_BY_TIER.basic);
});

Deno.test('checkReferences never exceeds what fal itself accepts', () => {
  // A tier cap raised past fal's own limit must refuse here rather than become a 422 upstream.
  const tooMany = Array.from({ length: FAL_MAX_REFERENCE_IMAGES + 1 }, () => REF);
  const result = checkReferences(tooMany, true, 99);
  assertEquals(result.ok, false);
  assertEquals(result.ok === false && result.code, 'reference-limit');
});

Deno.test('checkReferences requires a ready-made prompt', () => {
  // References belong to the beat-illustration path. The structured portrait path builds its own
  // prompt from one codex entry and has no line-up to reference.
  const result = checkReferences([REF], false, 4);
  assertEquals(result.ok, false);
  assertEquals(result.ok === false && result.code, undefined);
});

Deno.test('checkReferences rejects anything that is not an inline image', () => {
  for (const bad of [
    ['https://example.com/face.jpg'],
    ['data:text/html;base64,AAAA'],
    'not-an-array',
    [42],
  ] as never[]) {
    assertEquals(checkReferences(bad, true, 4).ok, false, JSON.stringify(bad));
  }
});

Deno.test('checkReferences bounds one reference and the whole payload', () => {
  assertEquals(checkReferences([dataUrl(MAX_REFERENCE_CHARS)], true, 4).ok, false);
  const nearMax = dataUrl(MAX_REFERENCE_CHARS - 100);
  assertEquals(checkReferences([nearMax], true, 4).ok, true);
  // Four of those are individually fine and collectively are not.
  assertEquals(nearMax.length * 4 > MAX_REFERENCE_PAYLOAD_CHARS, true);
  assertEquals(checkReferences([nearMax, nearMax, nearMax, nearMax], true, 4).ok, false);
});

Deno.test('imageCostFromBillableUnits charges what fal reported', () => {
  // The two counts the probe measured, at fal's published $0.01/megapixel.
  assertEquals(imageCostFromBillableUnits('0.75', FAL_USD_PER_BILLABLE_UNIT, 9), 0.0075);
  assertEquals(imageCostFromBillableUnits('1', FAL_USD_PER_BILLABLE_UNIT, 9), 0.01);
});

Deno.test('imageCostFromBillableUnits falls back rather than losing the charge', () => {
  // A missing or unreadable header must not make a render free — that is a silent subsidy leak,
  // and it is the direction an exception would also fail in, since the caller logs and moves on.
  for (const header of [null, '', 'n/a', '0', '-1', 'NaN']) {
    assertEquals(imageCostFromBillableUnits(header, FAL_USD_PER_BILLABLE_UNIT, 0.014), 0.014);
  }
});

Deno.test('the fallback cost is the worst case a valid request could bill', () => {
  // Not a round number picked by hand: it is the pixel ceiling at the published rate, so raising
  // the ceiling cannot leave the fallback quietly under-metering.
  assertEquals(
    REFERENCE_FALLBACK_COST_USD,
    MAX_INCLUDED_PIXELS / 1_000_000 * FAL_USD_PER_BILLABLE_UNIT,
  );
  assertEquals(REFERENCE_FALLBACK_COST_USD >= 0.01, true);
});

Deno.test('a reference request with no prompt is a caller bug, not a plan problem', () => {
  // Both refusals would fire for 5 references and no prompt. The shape one must win: telling the
  // author about their subscription for something their subscription has nothing to do with sends
  // them to the pricing page over a bug in our own request builder.
  const result = checkReferences([REF, REF, REF, REF, REF], false, 4);
  assertEquals(result.ok, false);
  assertEquals(result.ok === false && result.code, undefined);
  assertEquals(result.ok === false && result.error, 'image_urls requires prompt');
});

Deno.test('classifyFalRefusal recognises a content refusal', () => {
  // The measured shape: fal attributes it to an INPUT IMAGE, not to the prompt.
  const body = JSON.stringify({
    detail: [{ loc: ['body', 'image_urls', 0], msg: 'content policy violation', type: 'content_policy_violation' }],
  });
  assertEquals(classifyFalRefusal(body).kind, 'moderation');
  assertEquals(classifyFalRefusal('{"detail":"NSFW content detected"}').kind, 'moderation');
});

Deno.test('classifyFalRefusal does NOT call a schema error moderation', () => {
  // The bug this exists for: fal answers 422 for a bad field too, and calling that "moderation"
  // told the author to reword prose that was never the problem — advice that can never work, and
  // which hides a malformed request from us permanently.
  const body = JSON.stringify({
    detail: [{ loc: ['body', 'image_size'], msg: 'Input should be a valid dictionary', type: 'model_type' }],
  });
  const refusal = classifyFalRefusal(body);
  assertEquals(refusal.kind, 'request');
  // The FIELD is the diagnosis — `image_size` and `image_urls` are completely different bugs.
  assertEquals(refusal.kind === 'request' && refusal.detail.includes('image_size'), true);
  assertEquals(refusal.kind === 'request' && refusal.detail.includes('valid dictionary'), true);
});

Deno.test('classifyFalRefusal relays rather than blames when it cannot tell', () => {
  // Defaulting the other way is what caused the defect. An unrecognised body costs a confusing
  // message; a wrong `moderation` costs the author their trust in their own writing.
  for (const body of ['', 'Bad Request', '<html>502</html>', '{']) {
    assertEquals(classifyFalRefusal(body).kind, 'request', body);
  }
  const empty = classifyFalRefusal('');
  assertEquals(empty.kind === 'request' && empty.detail, 'no detail');
});

Deno.test('classifyFalRefusal bounds what it relays', () => {
  // Upstream text goes to the author. A pathological body must not become the whole screen.
  const refusal = classifyFalRefusal(JSON.stringify({ detail: 'x'.repeat(5000) }));
  assertEquals(refusal.kind === 'request' && refusal.detail.length <= 200, true);
});
