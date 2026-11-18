/**
 * Deno tests for the phase watchdog's error frame (phase-watchdog.ts).
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/_shared/_tests_/phase-watchdog.test.ts
 *
 * The watchdog was the last uncoded user-facing failure in the pipeline, left that way
 * on purpose while `provider-timeout` was the only candidate code: its copy says "please
 * try again", which for a phase that hit our own 150s wall walks the author back into
 * the same wall. It now has `generation-too-long`, whose copy keeps the advice the
 * English sentence already carried.
 *
 * These pin the frame's SHAPE, which is the part a client depends on — the wording is
 * the catalogs' business, and a spec asserts the key exists for every code.
 */

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  PHASE_BUDGET_MS,
  PHASE_SAFETY_MARGIN_MS,
  SLOW_STEP_CODE,
  WATCHDOG_CODE,
  WATCHDOG_MESSAGE,
  setupPhaseWatchdog,
} from '../phase-watchdog.ts';

/** A phase start far enough in the past that the watchdog's remaining budget is 0. */
function alreadyOverBudget(): number {
  return Date.now() - (PHASE_BUDGET_MS - PHASE_SAFETY_MARGIN_MS);
}

/** Collect everything written to an SSE writer until it is closed. */
function sseSink(): { writer: WritableStreamDefaultWriter; read: () => Promise<string> } {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  return {
    writer: writable.getWriter(),
    read: async () => {
      let out = '';
      const decoder = new TextDecoder();
      for await (const chunk of readable) out += decoder.decode(chunk, { stream: true });
      return out;
    },
  };
}

/**
 * Wait for the watchdog to have fired AND written.
 *
 * Polls `fired` rather than awaiting `errorSent` directly, and the difference is not
 * pedantry: `errorSent` starts life as `Promise.resolve()` and is REASSIGNED inside the
 * timer callback, so awaiting it before the timer runs resolves instantly on nothing.
 * `fired = true` and the reassignment happen synchronously back to back with no `await`
 * between them, so once `fired` is observable the promise is the real one. An earlier
 * version of this helper instead raced two same-delay timers and relied on FIFO
 * tie-breaking, which no spec guarantees.
 */
async function firedAndWritten(wd: { fired: boolean; errorSent: Promise<void> }): Promise<void> {
  while (!wd.fired) await new Promise(resolve => setTimeout(resolve, 1));
  await wd.errorSent;
}

Deno.test('the SSE frame carries the code beside the message', async () => {
  const sink = sseSink();
  const wd = setupPhaseWatchdog(sink.writer, alreadyOverBudget());
  const collected = sink.read();

  await firedAndWritten(wd);
  wd.dispose();

  const frame = JSON.parse((await collected).replace(/^data: /, '').trim());
  assertEquals(frame.code, WATCHDOG_CODE);
  assertEquals(frame.error, WATCHDOG_MESSAGE);
  assert(wd.fired);
});

Deno.test('neither budget code is provider-timeout, and they are not each other', () => {
  // `provider-timeout` means upstream did not answer; these two mean our own 150s wall.
  // The wire contract IS the string, so a rename silently degrades the client to the
  // wrong copy — and the split between these two is a difference in *advice*, which is
  // the one thing no test of the frame's shape can see.
  assertEquals(WATCHDOG_CODE, 'generation-too-long');
  assertEquals(SLOW_STEP_CODE, 'step-too-slow');
  assert(WATCHDOG_CODE !== SLOW_STEP_CODE);
});

Deno.test('the SSE frame only ever uses the size-driven code', () => {
  // The watchdog writes a frame only for /draft and /refine, where "a smaller word count
  // or the balanced preset" is true. /plan and /research pass `writer: null` and answer
  // SLOW_STEP_CODE themselves, because they read neither wordCount nor preset. There is
  // no message parameter to disagree with the code any more.
  assertEquals(setupPhaseWatchdog.length, 2);
});

Deno.test('a disposed watchdog never fires and never writes', async () => {
  const sink = sseSink();
  const wd = setupPhaseWatchdog(sink.writer, alreadyOverBudget());
  wd.dispose();

  const collected = sink.read();
  await new Promise(resolve => setTimeout(resolve, 5));
  await sink.writer.close();

  assertEquals(wd.fired, false);
  assertEquals(await collected, '');
});
