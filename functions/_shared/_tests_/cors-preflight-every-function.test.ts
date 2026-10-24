/**
 * Every browser-facing function answers a CORS preflight before doing anything else (#240).
 *
 * A routing refactor of `proxy-fal` once deleted its `handleCorsPreflightIfNeeded` call while
 * keeping the import, and nothing noticed: no test reached the `Deno.serve` callback, and
 * ESLint does not lint `supabase/functions/`. Every browser call to the function would then have
 * failed — an `OPTIONS` preflight (which `X-API-Key` / `X-API-Token` always trigger) fell through
 * to the key check and got a 401, which the browser reports as a bare CORS error.
 *
 * `cors-headers.test.ts` checks what the headers SAY. This checks that each function SENDS them,
 * by asking the real handler. The handlers are not exported — each `index.ts` hands its callback
 * straight to `Deno.serve` — so `Deno.serve` is swapped for a recorder while the module loads,
 * which captures the callback without binding a port.
 */
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

type Handler = (request: Request) => Response | Promise<Response>;

/**
 * The functions a browser calls — every `supabase/functions/*` with a `Deno.serve` except `main`,
 * the self-hosted router. **Add a new function here**: this list cannot discover one by itself,
 * because reading the directory needs `--allow-read`, which CI's `deno test` does not grant. For
 * the same reason the specifiers are literals: Deno resolves those with the module graph, where a
 * template-string import would need read access too.
 */
const BROWSER_FUNCTIONS: Record<string, () => Promise<unknown>> = {
  'proxy-fal': () => import('../../proxy-fal/index.ts'),
  'proxy-gemini': () => import('../../proxy-gemini/index.ts'),
  'proxy-replicate': () => import('../../proxy-replicate/index.ts'),
  'proxy-anthropic': () => import('../../proxy-anthropic/index.ts'),
  'premium': () => import('../../premium/index.ts'),
  'stripe': () => import('../../stripe/index.ts'),
  'delete-account': () => import('../../delete-account/index.ts'),
  'agentic-writer': () => import('../../agentic-writer/index.ts'),
};

const ORIGIN = 'https://creativewriter.dev';

async function handlerOf(fn: string, load: () => Promise<unknown>): Promise<Handler> {
  const realServe = Deno.serve;
  let captured: Handler | undefined;
  // deno-lint-ignore no-explicit-any
  (Deno as any).serve = (...args: unknown[]) => {
    captured = args.find((arg): arg is Handler => typeof arg === 'function');
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve(), ref() {}, unref() {}, addr: {} };
  };
  try {
    await load();
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).serve = realServe;
  }
  assert(captured, `${fn}/index.ts did not hand a handler to Deno.serve`);
  return captured;
}

for (const [fn, load] of Object.entries(BROWSER_FUNCTIONS)) {
  Deno.test({
    name: `${fn}: answers a preflight with 204 and the CORS headers, before any auth`,
    // Importing a function module can open clients and timers it never closes; this test only
    // asks whether the preflight is answered, not whether the module tidies up after itself.
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const handler = await handlerOf(fn, load);

      const response = await handler(new Request(`https://edge.test/functions/v1/${fn}/anything`, {
        method: 'OPTIONS',
        headers: {
          'Origin': ORIGIN,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization, x-api-key, x-api-token, content-type',
        },
      }));
      await response.body?.cancel();

      assertEquals(response.status, 204, `${fn} must not route a preflight past the CORS check`);
      assertEquals(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
      assert(response.headers.get('Access-Control-Allow-Methods')?.includes('POST'));
      assert(response.headers.get('Access-Control-Allow-Headers')?.includes('X-API-Key'));
    },
  });
}
