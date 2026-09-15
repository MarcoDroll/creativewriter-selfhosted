/**
 * Entry point for the `agentic-writer` Edge Function — and deliberately nothing else.
 *
 * Every line that used to be here is in `router.ts`. The split is not decoration: a
 * module that calls `Deno.serve` at top level binds a port as a side effect of being
 * imported, so while the router lived in this file no test could call a phase handler
 * without starting a server and leaking it past the test sanitizer. The catch ladders in
 * those handlers had been edited four times in two days with nothing exercising them.
 *
 * Keep this file at exactly this: the runtime's hook, and no logic to test.
 */

import { handleRequest } from './router.ts';

Deno.serve(handleRequest);
