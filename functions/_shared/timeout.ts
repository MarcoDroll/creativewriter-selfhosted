/**
 * Fetch wrapper with a connection/headers timeout via AbortController.
 * The timeout applies to the initial connection + headers only (not body streaming),
 * which is correct for SSE/streaming proxies.
 */
export async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit & { timeout?: number } = {},
): Promise<Response> {
  const { timeout = 120_000, ...fetchInit } = init;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  // Merge caller's signal if present
  if (fetchInit.signal) {
    fetchInit.signal.addEventListener('abort', () => controller.abort());
  }

  try {
    const response = await fetch(url, {
      ...fetchInit,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/** Type guard: true when an error is an AbortError (timeout fired). */
export function isTimeoutError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}
