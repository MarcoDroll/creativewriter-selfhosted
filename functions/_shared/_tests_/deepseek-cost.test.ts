/**
 * Deno tests for how Included AI meters a DeepSeek call (#473).
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/_shared/_tests_/deepseek-cost.test.ts
 *
 * Decided in #473: DeepSeek V4.1 Flash is metered at its PEAK rate always — $0.30 per 1M input
 * (cache miss), $0.006 per 1M cached input, $1.20 per 1M output — and cache hits are their own
 * line rather than full-price input. The tier budgets are unchanged.
 */

import { assertAlmostEquals, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { deepseekCostUsd } from '../ai-usage.ts';
import { cachedTokensOf } from '../usage-tokens.ts';

const MILLION = 1_000_000;

Deno.test('a million input, a million output: DeepSeek V4.1 Flash at peak', () => {
  assertAlmostEquals(deepseekCostUsd(MILLION, 0), 0.30, 1e-9);
  assertAlmostEquals(deepseekCostUsd(0, MILLION), 1.20, 1e-9);
  assertAlmostEquals(deepseekCostUsd(MILLION, MILLION), 1.50, 1e-9);
});

Deno.test('cache hits are part of the input total, metered at the cache-hit rate', () => {
  // 1M prompt tokens of which 800k came from the cache: 200k at $0.30 + 800k at $0.006.
  assertAlmostEquals(deepseekCostUsd(MILLION, 0, 800_000), 0.2 * 0.30 + 0.8 * 0.006, 1e-9);
  assertAlmostEquals(deepseekCostUsd(MILLION, 0, MILLION), 0.006, 1e-9);
});

Deno.test('a malformed cache count can never make the miss negative, or the cost lower than all-cached', () => {
  assertAlmostEquals(deepseekCostUsd(1000, 0, 5000), deepseekCostUsd(1000, 0, 1000), 1e-12);
  assertAlmostEquals(deepseekCostUsd(1000, 0, -50), deepseekCostUsd(1000, 0, 0), 1e-12);
  assertEquals(deepseekCostUsd(-5, -5, 0), 0);
});

Deno.test('every slot and wire name meters at the same rate; an unknown one falls back to it', () => {
  const reference = deepseekCostUsd(1234, 567, 89, 'deepseek-chat');
  for (const model of ['deepseek-reasoner', 'deepseek-flash', 'deepseek-v4-flash', 'something-else']) {
    assertAlmostEquals(deepseekCostUsd(1234, 567, 89, model), reference, 1e-12, model);
  }
});

Deno.test('the cache count is read from DeepSeek\'s own field, else the OpenAI-standard one, else 0', () => {
  assertEquals(cachedTokensOf({ prompt_tokens: 100, prompt_cache_hit_tokens: 60, prompt_tokens_details: { cached_tokens: 10 } }), 60);
  assertEquals(cachedTokensOf({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 40 } }), 40);
  assertEquals(cachedTokensOf({ prompt_tokens: 100 }), 0);
  assertEquals(cachedTokensOf(undefined), 0);
  assertEquals(cachedTokensOf({ prompt_cache_hit_tokens: 'x' }), 0);
});
