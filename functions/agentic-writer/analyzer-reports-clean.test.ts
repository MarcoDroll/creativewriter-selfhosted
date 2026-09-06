/**
 * Deno tests for `analyzerReportsClean` — the /refine clean-skip detector.
 *
 * Run locally with:
 *   deno test supabase/functions/agentic-writer/analyzer-reports-clean.test.ts
 *
 * Run in CI via the "Test (Edge Functions / Deno)" step in ci.yml's
 * lint-and-test job (deno test over supabase/functions/). It guards the
 * detector's weakest point: it must recognise the
 * analyzer's positive "clean" contract without ever false-positiving when a
 * real finding exists (that would silently drop the finding).
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { analyzerReportsClean } from './pipeline-prompts.ts';

const cases: { name: string; input: string; expected: boolean }[] = [
  { name: 'canonical clean line', input: 'No findings.', expected: true },
  { name: 'lowercase, no period', input: 'no findings', expected: true },
  { name: 'clean with a praise tail', input: 'No findings. Nicely done.', expected: true },
  { name: 'numbered/prefixed clean line', input: '1. No findings.', expected: true },
  { name: 'empty string (analyze failed / short-circuited)', input: '', expected: false },
  { name: 'whitespace only', input: '   \n  ', expected: false },
  { name: 'real cliché finding present', input: "1. [Cliché] 'her piercing eyes' — replace with a scene-specific rewrite.", expected: false },
  { name: 'voice finding present', input: '2. [Voice] POV slip in the second paragraph.', expected: false },
  { name: 'dialogue finding present', input: '1. [Dialogue] "I would be delighted" — too formal for a gruff dockworker.', expected: false },
  // Pins the [Dialogue] regex guard specifically: this input WOULD start with
  // "no findings" (the fallback path returns true) — only the dimension-tag
  // regex forces the correct `false`. Regress the regex and this flips to true.
  { name: 'dialogue tag after a "no findings" prefix', input: 'No findings — wait, 1. [Dialogue] "line" — too formal.', expected: false },
  { name: 'near-miss phrasing falls through to refine', input: 'None found.', expected: false },
];

for (const c of cases) {
  Deno.test(`analyzerReportsClean: ${c.name}`, () => {
    assertEquals(analyzerReportsClean(c.input), c.expected);
  });
}
