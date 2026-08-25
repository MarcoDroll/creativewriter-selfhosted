/**
 * Server-Sent Events helpers shared across agentic-writer phase endpoints.
 *
 * Wire format conventions (must stay compatible with the frontend SSE parser):
 * - Status events: `{ status, step, totalSteps, detail?, metadata? }`
 * - Content chunks: `{ choices: [{ delta: { content }, finish_reason }] }`
 *   plus optional `preview: true` for thorough-mode draft previews. Clients
 *   MUST gate canonical accumulation on absence of `preview`.
 * - Warnings: `{ warning: string }`
 * - Errors: `{ error: string, code?: ApiErrorCode }` — `code` is what the client
 *   translates; `error` stays the English sentence for the logs and for a client too
 *   old to know the code. Omitted entirely when the failure was never classified.
 * - Stream end: a final `{ choices: [{ delta: {}, finish_reason: 'stop' }] }`
 *   followed by `[DONE]`.
 */

import type { ApiErrorCode } from './types.ts';

const encoder = new TextEncoder();

export async function sendSSE(writer: WritableStreamDefaultWriter, data: string): Promise<boolean> {
  try {
    await writer.write(encoder.encode(`data: ${data}\n\n`));
    return true;
  } catch {
    return false; // Client disconnected
  }
}

export async function sendStatus(
  writer: WritableStreamDefaultWriter,
  status: string,
  step: number,
  totalSteps: number,
  detail?: string,
  metadata?: Record<string, unknown>
): Promise<boolean> {
  const payload: Record<string, unknown> = { status, step, totalSteps };
  if (detail) payload.detail = detail;
  if (metadata) payload.metadata = metadata;
  return sendSSE(writer, JSON.stringify(payload));
}

export async function sendContentChunk(
  writer: WritableStreamDefaultWriter,
  content: string,
  preview = false,
): Promise<boolean> {
  const payload: Record<string, unknown> = {
    choices: [{ delta: { content }, finish_reason: null }],
  };
  if (preview) payload.preview = true;
  return sendSSE(writer, JSON.stringify(payload));
}

export async function sendWarning(writer: WritableStreamDefaultWriter, message: string): Promise<boolean> {
  return sendSSE(writer, JSON.stringify({ warning: message }));
}

export async function sendDone(writer: WritableStreamDefaultWriter): Promise<void> {
  await sendSSE(writer, JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }],
  }));
  await sendSSE(writer, '[DONE]');
  try { await writer.close(); } catch { /* already closed */ }
}

/**
 * Send the terminal error frame and close the stream.
 *
 * `code` is optional because not every failure has one: a `ModelProviderConfigError`
 * carries operator-authored guidance that no catalog key improves on. That is now the
 * only uncoded case here — the phase watchdog was the other one, and it stayed uncoded
 * only while `provider-timeout` was the sole candidate code for it; it now sends its own
 * (`WATCHDOG_CODE` in `phase-watchdog.ts`).
 */
export async function sendError(
  writer: WritableStreamDefaultWriter,
  message: string,
  code?: ApiErrorCode,
): Promise<void> {
  const payload: Record<string, unknown> = { error: message };
  if (code) payload.code = code;
  await sendSSE(writer, JSON.stringify(payload));
  try { await writer.close(); } catch { /* already closed */ }
}

/**
 * Send an SSE summary event for streaming phase responses. Lets clients pick
 * up per-phase metadata (token counts, finish reason, draft text, etc.)
 * without parsing every content chunk. Sent before sendDone().
 */
export async function sendSummary<T extends object>(
  writer: WritableStreamDefaultWriter,
  summary: T,
): Promise<boolean> {
  return sendSSE(writer, JSON.stringify({ summary }));
}

/**
 * Start a periodic SSE keepalive comment to prevent proxy idle timeouts
 * (e.g. Cloudflare ~100s) during long phases. Comment lines are ignored
 * by the SSE parser on the client. Returns a stopper invoked in `finally`.
 *
 * `phaseStartTime` is each phase's own Date.now() — heartbeats are emitted
 * with elapsed-since-phase-start, not pipeline-relative time.
 */
export function startHeartbeat(
  writer: WritableStreamDefaultWriter,
  phaseStartTime: number,
  intervalMs = 15_000,
): () => void {
  let stopped = false;
  const timer = setInterval(async () => {
    if (stopped) return;
    try {
      await writer.write(encoder.encode(`: keepalive ${Date.now() - phaseStartTime}\n\n`));
    } catch {
      stopped = true;
      clearInterval(timer);
    }
  }, intervalMs);
  return () => { stopped = true; clearInterval(timer); };
}
