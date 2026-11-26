/**
 * Per-phase watchdog used by every agentic-writer phase endpoint.
 *
 * Each Edge Function request is killed by the supervisor at the platform
 * wall-clock budget (PHASE_BUDGET_MS, hosted free-tier = 150s). The watchdog
 * fires PHASE_SAFETY_MARGIN_MS earlier so we have time to:
 *   - abort in-flight upstream fetches via the returned AbortSignal
 *   - emit a graceful error to the client (SSE event or JSON 504)
 *
 * Usage (SSE phase):
 *   const wd = setupPhaseWatchdog(writer, Date.now());
 *   try {
 *     await streamToClient(..., wd.signal);
 *   } catch (err) {
 *     if (wd.fired) { await wd.errorSent; return; }
 *     throw err;
 *   } finally {
 *     wd.dispose();
 *   }
 *
 * Usage (JSON phase):
 *   const wd = setupPhaseWatchdog(null, Date.now());
 *   try {
 *     const result = await callModel(..., wd.signal);
 *     return jsonResponse(result, 200, headers);
 *   } catch (err) {
 *     if (wd.fired) {
 *       return jsonResponse(
 *         { error: 'Phase exceeded time budget', code: WATCHDOG_CODE }, 504, headers,
 *       );
 *     }
 *     throw err;
 *   } finally {
 *     wd.dispose();
 *   }
 */

import { sendError } from './sse-helpers.ts';
import type { ApiErrorCode } from './types.ts';

export const PHASE_BUDGET_MS = 150_000;
export const PHASE_SAFETY_MARGIN_MS = 5_000;

/**
 * A phase ran out of budget, and the fix is to ask for **less**.
 *
 * Neither of the two codes here is `provider-timeout`, and that is the whole reason
 * they exist: `provider-timeout` means upstream did not answer, and its copy says
 * "please try again" — which, for a phase that hit our own 150s wall, walks the author
 * straight back into the same wall.
 *
 * This one carries the advice the English sentence already had (a smaller word count,
 * or the balanced preset) and makes it translatable. It is for the phases where that
 * advice is **true**: `/draft` and `/refine` (both size-driven, and `balanced` skips
 * refine outright) and `/analyze` (runs on the draft, and `balanced` skips it too).
 *
 * Typed as `ApiErrorCode` at the declaration rather than `as const`. The literal is
 * checked today only because every consumer happens to annotate — `sendError`'s
 * parameter and three explicit `jsonResponse<ErrorResponse>` generics — so a future
 * caller that drops the generic would silently stop checking it against the union.
 */
export const WATCHDOG_CODE: ApiErrorCode = 'generation-too-long';

/** The log line, and what a client with no `generation-too-long` key falls back to. */
export const WATCHDOG_MESSAGE =
  'Generation took too long — please try a smaller word count or the balanced preset';

/**
 * A phase ran out of budget, and asking for less would **not** help.
 *
 * `/plan` and `/research` read neither `wordCount` nor `preset` — checked, not assumed:
 * `getPlanningConfig()` takes no arguments, and research is driven by the plan's task
 * count, the codex and the scene set. Both run in *both* presets, so "try the balanced
 * preset" changes nothing about them, and a smaller word count changes nothing either.
 *
 * Research is also the phase most likely to be here at all: its agents run up to five
 * sequential 25s rounds per task, where planning's single call is capped at 25s. So this
 * is the one that had to stop giving draft-shaped advice — which it briefly did, when
 * one code was reused for all five sites on the theory that translatability was the only
 * problem. What an author can actually change here is the model that step uses.
 */
export const SLOW_STEP_CODE: ApiErrorCode = 'step-too-slow';

export interface PhaseWatchdog {
  /** AbortSignal that aborts when the watchdog fires (or is disposed). */
  signal: AbortSignal;
  /** Whether the watchdog actually fired (vs being disposed normally). */
  readonly fired: boolean;
  /** Promise that resolves once the SSE error event has been written. */
  readonly errorSent: Promise<void>;
  /** Stop the watchdog timer. Call from finally{}. Idempotent. */
  dispose(): void;
}

/**
 * Set up a per-phase watchdog. If `writer` is provided, the watchdog will
 * emit an SSE error event when it fires. If `writer` is null, the caller is
 * expected to detect `wd.fired` and return a JSON 504 itself.
 *
 * `phaseStartTime` is each phase's own Date.now() — every phase gets a fresh
 * 150s budget; nothing tracks pipeline-relative elapsed time.
 *
 * **The message is not a parameter.** It used to be an unused optional one, and once the
 * frame started carrying {@link WATCHDOG_CODE} that became a trap: a caller could pass a
 * different English sentence and still get `generation-too-long`'s catalog copy, so the
 * author would read advice unrelated to the message in the log. The only two SSE callers
 * are `/draft` and `/refine`, and both want exactly this pairing.
 */
export function setupPhaseWatchdog(
  writer: WritableStreamDefaultWriter | null,
  phaseStartTime: number,
): PhaseWatchdog {
  const controller = new AbortController();
  let fired = false;
  let errorSent: Promise<void> = Promise.resolve();
  let disposed = false;

  const elapsedAtSetup = Date.now() - phaseStartTime;
  const remaining = Math.max(PHASE_BUDGET_MS - PHASE_SAFETY_MARGIN_MS - elapsedAtSetup, 0);

  const timer = setTimeout(() => {
    if (disposed) return;
    fired = true;
    controller.abort();
    if (writer) {
      errorSent = sendError(writer, WATCHDOG_MESSAGE, WATCHDOG_CODE)
        .catch(() => { /* writer may already be closed */ });
    }
  }, remaining);

  return {
    signal: controller.signal,
    get fired() { return fired; },
    get errorSent() { return errorSent; },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
    },
  };
}
