/**
 * Deno tests for how a failed DeepSeek answer on the Included chat route is answered (included-chat-upstream.ts).
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/premium/included-chat-upstream.test.ts
 */

import { assert, assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { MAX_RELAYED_CHARS, classifyIncludedChatFailure, deepseekErrorSentence } from './included-chat-upstream.ts';

/** DeepSeek's OpenAI-shaped error body. */
const deepseek = (message: string) => JSON.stringify({ error: { message, type: 'invalid_request_error', code: null } });

Deno.test('a 429, or a body saying "rate limit", is rate-limited with a 429', () => {
  assertEquals(classifyIncludedChatFailure(429, deepseek('Too many requests')), {
    body: { error: 'AI provider rate limit reached', code: 'rate-limited' }, status: 429,
  });
  assertEquals(classifyIncludedChatFailure(400, deepseek('Rate limit reached for requests')).body.code, 'rate-limited');
});

Deno.test('a 5xx is provider-unavailable with a 502, a 408 or 504 provider-timeout with a 504', () => {
  for (const status of [500, 502, 503]) {
    assertEquals(classifyIncludedChatFailure(status, 'Server busy'), {
      body: { error: 'AI provider error', code: 'provider-unavailable' }, status: 502,
    });
  }
  for (const status of [408, 504]) {
    assertEquals(classifyIncludedChatFailure(status, '').body.code, 'provider-timeout');
    assertEquals(classifyIncludedChatFailure(status, '').status, 504);
  }
});

Deno.test('the app\'s own key or balance (401, 402, 403) is provider-unavailable with a 424 — never the 4xx, never a 5xx', () => {
  // A 401/403 would read as the author's session on the client, and a 401 as their own key in the toast; a 5xx
  // would be retried once by the client's fallback, for as long as the account stays refused.
  for (const status of [401, 402, 403]) {
    const failure = classifyIncludedChatFailure(status, deepseek('Authentication Fails (no such user)'));
    assertEquals(failure.status, 424);
    assertEquals(failure.body.code, 'provider-unavailable');
    // DeepSeek's sentence names the app's account: it goes to the log, not to the author.
    assertEquals(failure.body.error, 'AI provider error');
  }
});

Deno.test('rung order: a throttle wins over the account rung and a 5xx; a non-error status is unavailable', () => {
  assertEquals(classifyIncludedChatFailure(402, deepseek('rate limit on this account')).body.code, 'rate-limited');
  assertEquals(classifyIncludedChatFailure(503, 'rate limit').status, 429);
  assertEquals(classifyIncludedChatFailure(302, ''), {
    body: { error: 'AI provider error', code: 'provider-unavailable' }, status: 502,
  });
  // A content refusal on a 401 is still the account rung: its sentence names the account, not the prompt.
  assertEquals(classifyIncludedChatFailure(401, deepseek('Content Exists Risk')).body.code, 'provider-unavailable');
});

Deno.test('a content refusal is moderation with a 400', () => {
  const failure = classifyIncludedChatFailure(400, deepseek('Content Exists Risk'));
  assertEquals(failure.status, 400);
  assertEquals(failure.body.code, 'moderation');
  assertStringIncludes(failure.body.error, 'Content Exists Risk');
});

Deno.test('an over-length prompt is uncoded and keeps DeepSeek\'s sentence, so the client can code it context-exceeded', () => {
  const sentence = 'This model\'s maximum context length is 131072 tokens. However, you requested 140000 tokens.';
  const failure = classifyIncludedChatFailure(400, deepseek(sentence));
  assertEquals(failure, { body: { error: `AI provider rejected the request: ${sentence}` }, status: 400 });
  // The client's isContextExceededMessage keys on this phrase.
  assertStringIncludes(failure.body.error, 'maximum context length');
});

Deno.test('any other 4xx is uncoded, relays DeepSeek\'s sentence and keeps its status', () => {
  assertEquals(classifyIncludedChatFailure(422, deepseek('Invalid max_tokens value, the valid range is [1, 8192]')), {
    body: { error: 'AI provider rejected the request: Invalid max_tokens value, the valid range is [1, 8192]' },
    status: 422,
  });
  assertEquals(classifyIncludedChatFailure(400, ''), { body: { error: 'AI provider rejected the request' }, status: 400 });
});

Deno.test('the sentence is error.message, then a string error, then message, then the raw text — capped', () => {
  assertEquals(deepseekErrorSentence(deepseek('  spaced  ')), 'spaced');
  assertEquals(deepseekErrorSentence(JSON.stringify({ error: 'flat' })), 'flat');
  assertEquals(deepseekErrorSentence(JSON.stringify({ message: 'top' })), 'top');
  assertEquals(deepseekErrorSentence('<html>Bad Gateway</html>'), '<html>Bad Gateway</html>');
  assertEquals(deepseekErrorSentence('null'), 'null');
  assertEquals(deepseekErrorSentence(JSON.stringify({ error: { message: '' } })), JSON.stringify({ error: { message: '' } }));
  const long = deepseekErrorSentence('x'.repeat(5000));
  assertEquals(long.length, MAX_RELAYED_CHARS);
  assert(deepseekErrorSentence('') === '');
});
