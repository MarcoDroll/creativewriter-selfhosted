/**
 * Deno tests for the portrait upstream classifiers.
 *
 * Run locally with:
 *   deno test --node-modules-dir=none supabase/functions/premium/portrait-upstream.test.ts
 *
 * Run in CI via the "Test (Edge Functions / Deno)" step in ci.yml's lint-and-test job.
 * These are the **first tests `premium/` has ever had**: the file it guards had none
 * when its error classification was a ladder of `message.startsWith('DeepSeek API
 * error:')` — a label naming the wrong provider, which nothing could have noticed.
 *
 * Colocated beside `index.ts`, following `agentic-writer/codex-state.test.ts`; CI's
 * `supabase/functions/` glob picks it up either way.
 *
 * **No `withEnv` scaffolding here, and none is needed.** The module under test is pure
 * — it reads no `Deno.env`, opens no socket, and has no module-scope side effects. The
 * `SELF_HOSTED`-at-module-scope footgun that forces env scaffolding on the
 * `model-calling` tests (the whole suite shares one process, and a sibling test sets
 * `SELF_HOSTED=true` while modules evaluate) simply does not reach this file. Do not
 * add it.
 */

import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  classifyOpenRouterFailure,
  classifyOpenRouterPayloadError,
  PROMPT_LABELS,
} from './portrait-upstream.ts';

// ---------------------------------------------------------------------------
// Non-2xx responses
// ---------------------------------------------------------------------------

Deno.test('classifyOpenRouterFailure: HTTP 429 is a throttle even when the body never says so', () => {
  // The one intentional behaviour change of this refactor. The old ladder classified by
  // prose only, so a 429 whose body read `{"error":{"message":"Too many concurrent
  // requests"}}` was relayed as a generic 502 — the client then showed
  // `provider-unavailable` for something the user only had to wait out.
  const err = classifyOpenRouterFailure(429, JSON.stringify({
    error: { message: 'Too many concurrent requests' },
  }));

  assertEquals(err.code, 'rate-limited');
  assertEquals(err.status, 429);
});

Deno.test('classifyOpenRouterFailure: structured error.code 429 throttles regardless of status', () => {
  const err = classifyOpenRouterFailure(500, JSON.stringify({ error: { code: 429 } }));

  assertEquals(err.code, 'rate-limited');
  assertEquals(err.status, 429);
});

Deno.test("classifyOpenRouterFailure: upstream's own 'rate limit' wording still throttles", () => {
  const err = classifyOpenRouterFailure(400, JSON.stringify({
    error: { message: 'Rate limit exceeded for this model' },
  }));

  assertEquals(err.code, 'rate-limited');
  assertEquals(err.status, 429);
});

Deno.test('classifyOpenRouterFailure: moderation outranks a structural 429 (429 -> 400)', () => {
  // Pinning a DECISION, not a widening — this is the one case that moves toward the
  // stricter status rather than away from it. Both old branches checked error.code ===
  // 429 before looking at the message at all, so a structural 429 won unconditionally
  // and the text was discarded. One order in both classifiers is worth more than
  // bug-compatibility with a body OpenRouter is not known to produce, and "refused on
  // content" is the more actionable of the two things such a body claims.
  const err = classifyOpenRouterFailure(500, JSON.stringify({
    error: { code: 429, message: 'Request flagged for review, try later' },
  }));

  assertEquals(err.code, 'provider-message');
  assertEquals(err.status, 400);
});

Deno.test('classifyOpenRouterPayloadError: moderation outranks a structural 429 too', () => {
  // The same reordering, in the other classifier. Both must agree — a ladder that runs
  // in one order on a 500 and another on a 200 is how the original grew two spellings.
  const err = classifyOpenRouterPayloadError({
    error: { code: 429, message: 'Request flagged for review, try later' },
  });

  assertEquals(err?.code, 'provider-message');
  assertEquals(err?.status, 400);
});

Deno.test('classifyOpenRouterFailure: a long relayed message is capped before it is scanned', () => {
  // The regexes scan this string and upstreamErrorResponse does not run until after
  // they have, so the cap has to be at composition time, not just at the response.
  const err = classifyOpenRouterFailure(500, JSON.stringify({
    error: { message: 'y'.repeat(5000) },
  }));

  assertEquals(err.message.length, 'Portrait generation failed: '.length + 500);
  assertEquals(err.status, 502);
});

Deno.test('classifyOpenRouterFailure: metadata.raw moderation is a 400, from a JSON string', () => {
  // How OpenRouter actually reports a BFL refusal: the origin provider's verbatim body,
  // JSON-encoded a second time, nested under error.metadata.raw.
  const err = classifyOpenRouterFailure(400, JSON.stringify({
    error: {
      message: 'Provider returned error',
      metadata: { raw: JSON.stringify({ status: 'Request Moderated' }) },
    },
  }));

  assertEquals(err.code, 'provider-message');
  assertEquals(err.status, 400);
  assertStringIncludes(err.message, 'content moderation');
});

Deno.test('classifyOpenRouterFailure: metadata.raw moderation is a 400 when already parsed', () => {
  // The `!ok` branch used to accept only the string spelling and fell through to 502 on
  // this one; the HTTP-200 branch accepted both. One classifier, both spellings.
  const err = classifyOpenRouterFailure(400, JSON.stringify({
    error: { metadata: { raw: { status: 'Request Moderated' } } },
  }));

  assertEquals(err.code, 'provider-message');
  assertEquals(err.status, 400);
});

Deno.test("classifyOpenRouterFailure: relayed text saying 'flagged' is a 400, not a 502", () => {
  const err = classifyOpenRouterFailure(403, JSON.stringify({
    error: { message: 'Your prompt was flagged by the provider safety system' },
  }));

  assertEquals(err.code, 'provider-message');
  assertEquals(err.status, 400);
  // Relayed verbatim — upstream names which part was refused and our copy cannot.
  assertStringIncludes(err.message, 'flagged by the provider safety system');
});

Deno.test('classifyOpenRouterFailure: a non-JSON body relays as a 502', () => {
  const err = classifyOpenRouterFailure(502, '<html><body>Bad Gateway</body></html>');

  assertEquals(err.code, 'provider-message');
  assertEquals(err.status, 502);
  assertStringIncludes(err.message, 'Image generation failed (502)');
  assertStringIncludes(err.message, 'Bad Gateway');
});

Deno.test('classifyOpenRouterFailure: a non-JSON body is still read for signals', () => {
  // An HTML error page from a proxy in front of OpenRouter. Nothing parses, but the
  // text arms still apply — this is why the body is folded into the message first.
  const err = classifyOpenRouterFailure(503, '<html><title>Rate limit reached</title></html>');

  assertEquals(err.code, 'rate-limited');
  assertEquals(err.status, 429);
});

Deno.test('classifyOpenRouterFailure: an oversized body is capped before the prefix', () => {
  const err = classifyOpenRouterFailure(500, 'x'.repeat(5000));

  // The cap belongs here as well as in upstreamErrorResponse: applied only at the
  // response, a long body would push the "(500):" prefix past the 500-char slice.
  assertEquals(err.message.length, 'Image generation failed (500): '.length + 500);
});

Deno.test('classifyOpenRouterFailure: the prompt call labels itself, not the image call', () => {
  // This is the site whose old label read `DeepSeek API error:` — on a call to
  // OPENROUTER. The label was wrong and load-bearing at once.
  const err = classifyOpenRouterFailure(401, '{"nope":true}', PROMPT_LABELS);

  assertEquals(err.code, 'provider-message');
  assertEquals(err.status, 502);
  assertStringIncludes(err.message, 'Image prompt generation failed (401)');
});

// ---------------------------------------------------------------------------
// HTTP 200 whose body is an error anyway
// ---------------------------------------------------------------------------

Deno.test('classifyOpenRouterPayloadError: a clean payload classifies as nothing', () => {
  assertEquals(
    classifyOpenRouterPayloadError({ choices: [{ finish_reason: 'stop', message: {} }] }),
    null,
  );
});

Deno.test('classifyOpenRouterPayloadError: metadata.raw moderation is a 400', () => {
  const err = classifyOpenRouterPayloadError({
    error: {
      message: 'Provider returned error',
      metadata: { raw: JSON.stringify({ status: 'Request Moderated' }) },
    },
  });

  assertEquals(err?.code, 'provider-message');
  assertEquals(err?.status, 400);
  assertStringIncludes(err?.message ?? '', 'content moderation');
});

Deno.test('classifyOpenRouterPayloadError: an error.code 429 throttles', () => {
  const err = classifyOpenRouterPayloadError({ error: { code: 429, message: 'slow down' } });

  assertEquals(err?.code, 'rate-limited');
  assertEquals(err?.status, 429);
});

Deno.test('classifyOpenRouterPayloadError: a non-string error object still relays', () => {
  const err = classifyOpenRouterPayloadError({ error: { detail: ['upstream exploded'] } });

  assertEquals(err?.code, 'provider-message');
  assertEquals(err?.status, 502);
  assertStringIncludes(err?.message ?? '', 'upstream exploded');
});

Deno.test('classifyOpenRouterPayloadError: a content_filter finish_reason is a 400', () => {
  const err = classifyOpenRouterPayloadError({ choices: [{ finish_reason: 'content_filter' }] });

  assertEquals(err?.code, 'provider-message');
  assertEquals(err?.status, 400);
});

Deno.test('classifyOpenRouterPayloadError: native_finish_reason is read when finish_reason is absent', () => {
  // Some OpenRouter providers only populate the native field.
  const err = classifyOpenRouterPayloadError({ choices: [{ native_finish_reason: 'SAFETY' }] });

  assertEquals(err?.code, 'provider-message');
  assertEquals(err?.status, 400);
});

Deno.test('classifyOpenRouterPayloadError: a set finish_reason hides a native filter signal', () => {
  // Pinning a KNOWN GAP rather than an aspiration. The `||` chain short-circuits, so a
  // provider that reports finish_reason 'stop' alongside native 'SAFETY' reads as clean
  // and the request goes on to fail as "no image data" (502) instead of moderation
  // (400). This is today's behaviour, carried over deliberately — widening it changes
  // what users see and belongs in its own commit, like the moderation-code switch.
  assertEquals(
    classifyOpenRouterPayloadError({
      choices: [{ finish_reason: 'stop', native_finish_reason: 'SAFETY' }],
    }),
    null,
  );
});
