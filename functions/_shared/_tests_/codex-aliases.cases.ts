/**
 * The one case table both copies of `coerceAliases` must pass (#898): the Edge copy
 * (`_shared/codex-aliases.ts`) in `codex-aliases.test.ts` under Deno, and the Edge copy AND
 * the client copy (`src/app/shared/utils/codex-aliases.util.ts`) in the Karma spec
 * `src/app/shared/utils/codex-aliases.parity.spec.ts`. One table rather than two
 * hand-typed ones, so the tests cannot drift apart the way the code could.
 *
 * Imports nothing: Karma bundles this file as well as Deno running it.
 */
export interface CoerceAliasesCase {
  name: string;
  raw: unknown;
  expected: string[];
}

export const COERCE_ALIASES_CASES: CoerceAliasesCase[] = [
  { name: 'a comma-string, trimmed', raw: 'der Hexer, Weißhaar , Geralt', expected: ['der Hexer', 'Weißhaar', 'Geralt'] },
  { name: 'a string array, verbatim', raw: ['der Hexer', 'Weißhaar'], expected: ['der Hexer', 'Weißhaar'] },
  // 00048 canonicalized stored arrays to comma-strings but deliberately left any array whose
  // element contains a comma: as a comma-string it would read back as two aliases.
  {
    name: 'a comma inside an array element, as ONE alias',
    raw: ['von Clausewitz, Karl', 'Carl', 'VON CLAUSEWITZ, KARL'],
    expected: ['von Clausewitz, Karl', 'Carl'],
  },
  {
    name: 'a mixed-shape array',
    raw: ['Karl', 5, null, 'von Clausewitz, Karl'],
    expected: ['Karl', 'von Clausewitz, Karl'],
  },
  { name: 'case-insensitive dedupe, first seen wins', raw: 'Geralt, geralt, GERALT, Roach', expected: ['Geralt', 'Roach'] },
  { name: 'blank segments', raw: 'a, , ,b,   ', expected: ['a', 'b'] },
  { name: 'blank and padded array members', raw: [' der Hexer ', '', '  ', 'der hexer'], expected: ['der Hexer'] },
  { name: 'non-string array members', raw: ['ok', 42, null, undefined, 'also'], expected: ['ok', 'also'] },
  { name: 'only separators', raw: ' , ,', expected: [] },
  { name: 'undefined', raw: undefined, expected: [] },
  { name: 'null', raw: null, expected: [] },
  { name: 'an empty string', raw: '', expected: [] },
  { name: 'a whitespace string', raw: '   ', expected: [] },
  { name: 'a number', raw: 42, expected: [] },
  { name: 'an object', raw: { aliases: 'x' }, expected: [] },
  {
    name: 'more than ten, uncapped',
    raw: Array.from({ length: 15 }, (_, i) => `alias${i}`).join(', '),
    expected: Array.from({ length: 15 }, (_, i) => `alias${i}`),
  },
];
