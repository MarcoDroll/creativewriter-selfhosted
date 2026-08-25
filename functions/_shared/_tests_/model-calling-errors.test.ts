/**
 * Deno tests for the ERROR paths of `callModel` / `streamToClient` (model-calling.ts).
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/_shared/_tests_/model-calling-errors.test.ts
 *
 * The first tests either function has: `model-calling-upstream.test.ts` covers
 * `resolveUpstream` and `toChatCompletionsUrl` only, so until now nothing pinned what a
 * non-2xx upstream response actually becomes. It used to become a bare `Error` whose
 * message had the status baked into English prose; it is now an `UpstreamError` carrying
 * a code, which is the whole point of this change and is trivially re-flattenable.
 *
 * `globalThis.fetch` is ASSIGNED, never spied — jasmine's double-spy throw is a frontend
 * rule, but the same reasoning holds here and assignment restores cleanly in a `finally`.
 *
 * FOOTGUN, same as its neighbour: `deno test … supabase/functions/` runs every test in
 * ONE process and `stripe/_tests_/self-hosted-lockdown.test.ts` sets `SELF_HOSTED=true`
 * at module scope. These use an `openrouter:` slot, which reads no env at all, and the
 * env is still saved and restored so a future local-provider case here cannot leak.
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { callModel, streamToClient } from '../model-calling.ts';
import { UpstreamError } from '../api-errors.ts';

const SLOT = 'openrouter:anthropic/claude-3.5-sonnet';
const CONFIG = { maxTokens: 100, temperature: 0.7 };

/** Run `fn` with `fetch` answering `response`, restoring the real one afterwards. */
async function withFetch(response: Response, fn: () => Promise<void>): Promise<void> {
  const realFetch = globalThis.fetch;
  const savedSelfHosted = Deno.env.get('SELF_HOSTED');
  globalThis.fetch = () => Promise.resolve(response);
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    if (savedSelfHosted === undefined) Deno.env.delete('SELF_HOSTED');
    else Deno.env.set('SELF_HOSTED', savedSelfHosted);
  }
}

/** A writer that swallows everything — streamToClient needs one to exist. */
function nullWriter(): WritableStreamDefaultWriter {
  return new WritableStream<Uint8Array>().getWriter();
}

Deno.test('callModel throws a coded UpstreamError on a rejected key', async () => {
  await withFetch(new Response('invalid api key', { status: 401 }), async () => {
    const err = await assertRejects(
      () => callModel(SLOT, 'sys', 'user', CONFIG, 'sk-bad'),
      UpstreamError,
    );
    assertEquals(err.code, 'api-key-invalid');
    assertEquals(err.status, 502);
    assertStringIncludes(err.message, 'Model API error (401)');
  });
});

Deno.test('callModel throws rate-limited on a 429', async () => {
  await withFetch(new Response('{"error":"too many"}', { status: 429 }), async () => {
    const err = await assertRejects(() => callModel(SLOT, 'sys', 'user', CONFIG, 'sk-x'), UpstreamError);
    assertEquals(err.code, 'rate-limited');
    assertEquals(err.status, 429);
  });
});

Deno.test('callModel relays an unclassifiable body as provider-message', async () => {
  await withFetch(new Response('upstream exploded', { status: 500 }), async () => {
    const err = await assertRejects(() => callModel(SLOT, 'sys', 'user', CONFIG, 'sk-x'), UpstreamError);
    assertEquals(err.code, 'provider-message');
    assertEquals(err.status, 502);
    assertStringIncludes(err.message, 'upstream exploded');
  });
});

Deno.test('streamToClient throws a coded UpstreamError on a non-2xx', async () => {
  await withFetch(new Response('rate limit exceeded', { status: 500 }), async () => {
    const writer = nullWriter();
    const err = await assertRejects(
      () => streamToClient(writer, SLOT, 'sys', 'user', null, CONFIG, 'sk-x'),
      UpstreamError,
    );
    assertEquals(err.code, 'rate-limited');
    assertEquals(err.status, 429);
    await writer.close().catch(() => { /* nothing read it */ });
  });
});

Deno.test('streamToClient answers provider-unavailable for a 200 with no body', async () => {
  // A 204 is the only way to build a bodyless Response; what matters is that the OK
  // branch with `!response.body` no longer throws an uncoded bare Error.
  await withFetch(new Response(null, { status: 204 }), async () => {
    const writer = nullWriter();
    const err = await assertRejects(
      () => streamToClient(writer, SLOT, 'sys', 'user', null, CONFIG, 'sk-x'),
      UpstreamError,
    );
    assertEquals(err.code, 'provider-unavailable');
    assertEquals(err.status, 502);
    assert(err.message.includes('Empty response body'));
    await writer.close().catch(() => { /* nothing read it */ });
  });
});
