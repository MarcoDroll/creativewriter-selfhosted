/**
 * Deno tests: `callModel` and `streamToClient` carry the provider's cache-hit count out with the
 * token totals, so Deep Writer can meter it at DeepSeek's cache-hit rate (#473).
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/_shared/_tests_/model-calling-cache-tokens.test.ts
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { callModel, streamToClient } from '../model-calling.ts';

const SLOT = 'openrouter:deepseek/deepseek-chat';
const CONFIG = { maxTokens: 100, temperature: 0.7 };
const USAGE = { prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 800 };

async function withFetch(response: () => Response, fn: () => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(response());
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

Deno.test('callModel returns the cache-hit count beside the totals', async () => {
  await withFetch(
    () => new Response(JSON.stringify({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }], usage: USAGE })),
    async () => {
      const result = await callModel(SLOT, 'sys', 'user', CONFIG, 'sk-x');
      assertEquals([result.inputTokens, result.outputTokens, result.cachedInputTokens], [1000, 50, 800]);
    },
  );
});

Deno.test('streamToClient returns the cache-hit count from the usage frame', async () => {
  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: USAGE })}`,
    'data: [DONE]',
    '',
  ].join('\n');
  await withFetch(
    () => new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }),
    async () => {
      const writer = new WritableStream<Uint8Array>().getWriter();
      const result = await streamToClient(writer, SLOT, 'sys', 'user', null, CONFIG, 'sk-x');
      assertEquals([result.inputTokens, result.outputTokens, result.cachedInputTokens], [1000, 50, 800]);
      await writer.close().catch(() => { /* nothing read it */ });
    },
  );
});
