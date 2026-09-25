/**
 * The preflight allowlist.
 *
 * This exists because a header the client sends but the allowlist omits does not degrade —
 * the browser's preflight refuses, so the request is never made and the failure reads as a
 * generic CORS error naming nothing. The rest of the Deno suite cannot see it: those tests
 * build a `Request` and call `handleRequest` in-process, never crossing an origin, so they
 * pass just as happily with the header missing. `X-Venice-Key` shipped that way for one
 * commit.
 */
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { ALLOWED_HEADERS, corsHeaders } from '../cors.ts';

function withSelfHosted(value: string | undefined, fn: () => void): void {
  const saved = Deno.env.get('SELF_HOSTED');
  if (value === undefined) Deno.env.delete('SELF_HOSTED');
  else Deno.env.set('SELF_HOSTED', value);
  try { fn(); } finally {
    if (saved === undefined) Deno.env.delete('SELF_HOSTED');
    else Deno.env.set('SELF_HOSTED', saved);
  }
}

/**
 * Every custom header `src/` actually sends to a function. Keep this list honest — it is the
 * whole point of the file, and a header added to a service without being added here is
 * exactly the bug this catches.
 */
const HEADERS_THE_CLIENT_SENDS = [
  'Content-Type',
  'Authorization',
  'X-API-Key',              // OpenRouter key, agentic-writer + proxies
  'X-Venice-Key',           // Venice key, agentic-writer
  'X-Pipeline-Request-Id',  // agentic-writer
  'X-License-Key',
  'X-API-Token',
  'X-Client-Name',
  'X-Client-Version',
];

Deno.test('CORS: both deployments allow every header the client sends', () => {
  for (const selfHosted of [undefined, 'true']) {
    withSelfHosted(selfHosted, () => {
      const allowed = corsHeaders('https://creativewriter.dev')['Access-Control-Allow-Headers']
        .split(',').map(h => h.trim().toLowerCase());
      for (const header of HEADERS_THE_CLIENT_SENDS) {
        assert(
          allowed.includes(header.toLowerCase()),
          `${header} is not in the ${selfHosted ? 'self-hosted' : 'hosted'} preflight allowlist`,
        );
      }
    });
  }
});

Deno.test('CORS: the two branches expose the SAME allowlist', () => {
  // They were two hand-maintained copies of one list. Adding a header to one branch only
  // is a deployment-shaped bug — hosted broken and self-hosted fine, or the reverse.
  let hosted = '';
  let selfHosted = '';
  withSelfHosted(undefined, () => {
    hosted = corsHeaders('https://creativewriter.dev')['Access-Control-Allow-Headers'];
  });
  withSelfHosted('true', () => {
    selfHosted = corsHeaders('https://anything.local')['Access-Control-Allow-Headers'];
  });
  assertEquals(hosted, selfHosted);
  assertEquals(hosted, ALLOWED_HEADERS);
});
