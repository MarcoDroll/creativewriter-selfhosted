/**
 * Edge reader for a codex entry's `metadata.aliases` (#898).
 *
 * TWIN OF `src/app/shared/utils/codex-aliases.util.ts` `coerceAliases`. An Edge Function
 * cannot import from `src/`, so the logic is written twice; change both together.
 * `check:shared-constants` compares values, not functions, so the pair is pinned by one case
 * table, `_tests_/codex-aliases.cases.ts`, which `_tests_/codex-aliases.test.ts` runs here
 * under Deno and `src/app/shared/utils/codex-aliases.parity.spec.ts` runs through BOTH
 * copies under Karma. Keep this file free of imports and of anything Deno-only, or Karma can
 * no longer bundle it and the parity spec stops compiling.
 *
 * The canonical stored shape is a COMMA-JOINED STRING (`"der Hexer, Weißhaar"`), which every
 * writer persists and migration 00048 rewrote the legacy arrays to. A `string[]` still
 * arrives for the arrays 00048 deliberately left (a comma inside an element,
 * `["von Clausewitz, Karl"]`) and for `metadata` copied verbatim by codex transfer or `.cwx`
 * restore; an array element is never split.
 *
 * Trims, drops blanks (a blank alias is a substring of every name), skips non-strings,
 * dedupes case-insensitively, and keeps first-seen order. Uncapped.
 */
export function coerceAliases(raw: unknown): string[] {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const norm = item.trim();
    if (!norm) continue;
    const key = norm.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(norm);
  }
  return out;
}
