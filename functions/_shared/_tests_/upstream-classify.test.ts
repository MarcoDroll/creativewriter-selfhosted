/**
 * Deno tests for `classifyUpstreamFailure` (upstream-classify.ts).
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/_shared/_tests_/upstream-classify.test.ts
 *
 * Pure and env-free — the classifier reads no `Deno.env`, so unlike its neighbours in
 * this directory these need no env save/restore dance.
 */

import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { classifyUpstreamFailure } from '../upstream-classify.ts';

const LABEL = 'Model API error';

Deno.test('429 answers rate-limited with a 429', () => {
  const err = classifyUpstreamFailure(429, '{"error":{"message":"slow down"}}', LABEL);
  assertEquals(err.code, 'rate-limited');
  assertEquals(err.status, 429);
});

Deno.test('a body saying "rate limit" answers rate-limited whatever the status', () => {
  // OpenRouter and several local shims say it in prose on a 500.
  for (const body of ['Rate limit exceeded', 'rate_limit reached', 'RATE-LIMIT']) {
    const err = classifyUpstreamFailure(500, body, LABEL);
    assertEquals(err.code, 'rate-limited', body);
    assertEquals(err.status, 429, body);
  }
});

Deno.test('401 and 403 answer api-key-invalid — and NEVER 401/403', () => {
  // The whole point of the rung. `providerCodeFromStatus` maps 401 → auth-required and
  // 403 → subscription-required, both of which mean *this app's* session; answering
  // either for a rejected OpenRouter key tells the author to sign in.
  for (const status of [401, 403]) {
    const err = classifyUpstreamFailure(status, 'invalid api key', LABEL);
    assertEquals(err.code, 'api-key-invalid');
    assertEquals(err.status, 502, `status ${status} must degrade to 502`);
  }
});

Deno.test('402 (an own-key balance ran out, e.g. NanoGPT) answers provider-balance-low with a 502', () => {
  const err = classifyUpstreamFailure(402, '{"error":{"message":"Insufficient balance"}}', LABEL, 'nanogpt:x');
  assertEquals(err.code, 'provider-balance-low');
  assertEquals(err.status, 502);
});

Deno.test('402 on an included: slot is the APP\'s balance, never "top up at your provider"', () => {
  const err = classifyUpstreamFailure(402, 'Insufficient Balance', LABEL, 'included:deepseek-chat');
  assertEquals(err.code, 'provider-message');
});

Deno.test('a 429 with an auth-shaped body is still rate-limited (rung order)', () => {
  const err = classifyUpstreamFailure(429, 'invalid api key', LABEL);
  assertEquals(err.code, 'rate-limited');
  assertEquals(err.status, 429);
});

Deno.test('moderation wording answers moderation with a 400', () => {
  for (const body of ['flagged by moderation', 'content_filter triggered', 'content filter', 'FLAGGED']) {
    const err = classifyUpstreamFailure(400, body, LABEL);
    assertEquals(err.code, 'moderation', body);
    assertEquals(err.status, 400, body);
  }
});

Deno.test('anything else relays upstream text as provider-message, 502', () => {
  const err = classifyUpstreamFailure(500, 'model exploded', LABEL);
  assertEquals(err.code, 'provider-message');
  assertEquals(err.status, 502);
  assertEquals(err.message, 'Model API error (500): model exploded');
});

Deno.test('the relayed body is capped at 200 chars', () => {
  // The cap is the accepted SSRF residual for local providers — a debugging aid, not a
  // scanning primitive. It is 200 here and 500 in premium's OpenRouter classifier.
  const err = classifyUpstreamFailure(500, 'x'.repeat(5000), LABEL);
  assertEquals(err.message, `Model API error (500): ${'x'.repeat(200)}`);
});

Deno.test('the cap runs BEFORE the regexes — a late "rate limit" is not seen', () => {
  const err = classifyUpstreamFailure(500, `${'x'.repeat(400)} rate limit`, LABEL);
  assertEquals(err.code, 'provider-message');
});

Deno.test('the label names the failing call', () => {
  const err = classifyUpstreamFailure(500, 'nope', 'Research agent API error');
  assertStringIncludes(err.message, 'Research agent API error (500)');
});

Deno.test('an empty or unparseable body is not an error condition', () => {
  const err = classifyUpstreamFailure(503, '', LABEL);
  assertEquals(err.code, 'provider-message');
  assertEquals(err.message, 'Model API error (503): ');
});

// #466: Google's own usage-policy refusal, relayed verbatim by OpenRouter. It names no
// moderation word, so before this rung it fell through to `provider-message` and the author
// read Google's English sentence raw — and resent it, as #340's author did four times.
const GOOGLE_POLICY_BODY = '{"error":{"message":"Input blocked: The prompt could not be submitted.'
  + ' The prompt contains sensitive words that violate Google\'s Generative AI Prohibited Use policy.'
  + ' Try rephrasing the prompt."}}';

Deno.test('Google\'s usage-policy sentence answers policy-blocked with a 400', () => {
  const err = classifyUpstreamFailure(400, GOOGLE_POLICY_BODY, LABEL, 'openrouter:google/gemini-2.5-pro');
  assertEquals(err.code, 'policy-blocked');
  assertEquals(err.status, 400);
  assertStringIncludes(err.message, 'Prohibited Use policy');
});

Deno.test('Imagen\'s spelling of the same refusal is policy-blocked too', () => {
  const err = classifyUpstreamFailure(400, 'violates Google\'s Responsible AI practices', LABEL);
  assertEquals(err.code, 'policy-blocked');
});

Deno.test('the policy rung beats the moderation rung when a body says both', () => {
  // "content filter" alone is the setting the author can change; the policy's name says it is
  // the one no setting turns off, which is the more specific — and the actionable — reading.
  const err = classifyUpstreamFailure(400, 'content filter: Prohibited Use policy', LABEL);
  assertEquals(err.code, 'policy-blocked');
});

/** OpenRouter's envelope around a provider's error: Google's own body, pretty-printed, as a string. */
function openRouterEnvelope(googleMessage: string): string {
  const raw = JSON.stringify({ error: { code: 400, message: googleMessage, status: 'INVALID_ARGUMENT' } }, null, 2);
  return JSON.stringify({ error: { message: 'Provider returned error', code: 400, metadata: { raw, provider_name: 'Google AI Studio' } } });
}

Deno.test('the policy is read past the 200-char relay cap — OpenRouter\'s envelope puts it there', () => {
  const body = openRouterEnvelope('Input blocked: The prompt could not be submitted. The prompt contains'
    + ' sensitive words that violate Google\'s Generative AI Prohibited Use policy. Try rephrasing the prompt.');
  // The premise: the name of the policy sits beyond what the relayed message keeps.
  assertEquals(body.indexOf('Prohibited Use') > 200, true);
  const err = classifyUpstreamFailure(400, body, LABEL, 'openrouter:google/gemini-2.5-pro');
  assertEquals(err.code, 'policy-blocked');
  assertEquals(err.status, 400);
  // The relayed message is still capped, whatever the policy rung read.
  assertEquals(err.message, `${LABEL} (400): ${body.substring(0, 200)}`);
});

Deno.test('the status rungs still come first: a throttle or a refused key naming the policy keeps its own code', () => {
  assertEquals(classifyUpstreamFailure(429, 'Prohibited Use policy', LABEL).code, 'rate-limited');
  assertEquals(classifyUpstreamFailure(403, 'Prohibited Use policy', LABEL).code, 'api-key-invalid');
});

Deno.test('the wider policy window is bounded too', () => {
  const err = classifyUpstreamFailure(400, `${'x'.repeat(5000)} Prohibited Use policy`, LABEL);
  assertEquals(err.code, 'provider-message');
});
