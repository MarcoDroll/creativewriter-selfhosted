/**
 * Deno tests for the DeepSeek request fields of an `included:` slot (#1064 slice 4).
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/_shared/_tests_/deepseek-model.test.ts
 *
 * Probed 2026-11-12: `reasoning_effort` steers `deepseek-flash` with thinking on (low thinks
 * least, max most), and an unknown value is a 422. The browser rounds the author's level to
 * low/high/max (`includedReasoningEffort`); the server forwards it to the reasoner slot only.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { deepseekReasoningEffortError, deepseekRequestFields, isDeepseekReasoningEffort } from '../deepseek-model.ts';

Deno.test('the reasoner slot sends the effort it is given beside thinking on', () => {
  assertEquals(deepseekRequestFields('deepseek-reasoner', 'high'), {
    model: 'deepseek-flash', thinking: { type: 'enabled' }, reasoning_effort: 'high',
  });
});

Deno.test('the reasoner slot with no effort sends no field, which DeepSeek runs at high', () => {
  assertEquals(deepseekRequestFields('deepseek-reasoner'), {
    model: 'deepseek-flash', thinking: { type: 'enabled' },
  });
});

Deno.test('the chat slot never sends an effort: thinking is off', () => {
  assertEquals(deepseekRequestFields('deepseek-chat', 'max'), {
    model: 'deepseek-flash', thinking: { type: 'disabled' },
  });
});

Deno.test('only DeepSeek\'s three real levels are accepted from a client', () => {
  for (const level of ['low', 'high', 'max']) assertEquals(isDeepseekReasoningEffort(level), true, level);
  for (const value of ['medium', 'none', 'xhigh', 'ultra', '', 'HIGH', 3, null, undefined, {}]) {
    assertEquals(isDeepseekReasoningEffort(value), false, String(value));
  }
});

Deno.test('the premium chat route refuses a level DeepSeek does not take, and lets a real one or none through', () => {
  assertEquals(deepseekReasoningEffortError(undefined), null);
  assertEquals(deepseekReasoningEffortError('high'), null);
  assertEquals(deepseekReasoningEffortError('medium'), 'reasoning_effort must be one of: low, high, max');
  assertEquals(deepseekReasoningEffortError(null), 'reasoning_effort must be one of: low, high, max');
});
