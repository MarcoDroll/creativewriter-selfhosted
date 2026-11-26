/**
 * Deno tests for the Edge copy of `coerceAliases` (`_shared/codex-aliases.ts`, #898).
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/_shared/_tests_/codex-aliases.test.ts
 *
 * The cases live in `codex-aliases.cases.ts`, which the Karma spec
 * `src/app/shared/utils/codex-aliases.parity.spec.ts` also runs, through the Edge copy and
 * the client copy both. This file is what holds the Edge copy when only the Deno suite runs.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { coerceAliases } from '../codex-aliases.ts';
import { COERCE_ALIASES_CASES } from './codex-aliases.cases.ts';

for (const { name, raw, expected } of COERCE_ALIASES_CASES) {
  Deno.test(`coerceAliases reads ${name}`, () => {
    assertEquals(coerceAliases(raw), expected);
  });
}

Deno.test('coerceAliases reads a string array and its comma-string equivalent identically', () => {
  assertEquals(
    coerceAliases([' der Hexer ', 'Weißhaar', 'der hexer', '']),
    coerceAliases(' der Hexer , Weißhaar, der hexer, '),
  );
});
