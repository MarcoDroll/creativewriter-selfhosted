/**
 * `parsePlanningOutput` must tell "the planner asked for no research" apart from "the
 * planner's answer could not be read" (#410). Both give no tasks, and only the second
 * deserves a warning: before `parsed`, an unreadable plan skipped research while the
 * client said "No additional research needed".
 */
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { parsePlanningOutput } from './planner.ts';

const VALID = JSON.stringify({
  research_tasks: [{ focus: 'the protagonist', entities: ['Ada'], scenes: ['Opening'] }],
});

Deno.test('a plan that asks for no research is parsed, with no tasks', () => {
  assertEquals(parsePlanningOutput('{"research_tasks": []}'), { tasks: [], parsed: true });
});

Deno.test('a valid plan is parsed, with its tasks', () => {
  const plan = parsePlanningOutput(VALID);
  assertEquals(plan.parsed, true);
  assertEquals(plan.tasks, [{ focus: 'the protagonist', entities: ['Ada'], scenes: ['Opening'] }]);
});

Deno.test('a fenced plan with nothing outside the fence is parsed', () => {
  assertEquals(parsePlanningOutput('```json\n' + VALID + '\n```').parsed, true);
});

Deno.test('prose with no JSON object is not parsed (#410)', () => {
  assertEquals(parsePlanningOutput('I think the scene needs more about Ada.'), { tasks: [], parsed: false });
});

Deno.test('an empty plan is not parsed (#410)', () => {
  assertEquals(parsePlanningOutput('').parsed, false);
});

Deno.test('fenced JSON followed by a stray brace is not parsed (#410)', () => {
  const plan = parsePlanningOutput('```json\n' + VALID + '\n```\nNote: entities use {name} form.');
  assertEquals(plan, { tasks: [], parsed: false });
});

Deno.test('an object without a research_tasks array is not parsed (#410)', () => {
  assertEquals(parsePlanningOutput('{}').parsed, false);
  assertEquals(parsePlanningOutput('{"tasks": [{"focus": "x"}]}').parsed, false);
  assertEquals(parsePlanningOutput('{"research_tasks": null}').parsed, false);
});

Deno.test('tasks that all lack a usable focus are not parsed (#410)', () => {
  const plan = parsePlanningOutput('{"research_tasks": [{"description": "Ada"}, {"focus": ""}]}');
  assertEquals(plan, { tasks: [], parsed: false });
});

Deno.test('junk entries take no slot under the four-task cap and spend no entity budget (#410 review)', () => {
  const junk = Array.from({ length: 4 }, () => ({ description: 'x', entities: ['A', 'B', 'C', 'D', 'E'] }));
  const plan = parsePlanningOutput(JSON.stringify({
    research_tasks: [...junk, { focus: 'the setting', entities: ['Harbour'] }],
  }));
  assertEquals(plan, { tasks: [{ focus: 'the setting', entities: ['Harbour'], scenes: [] }], parsed: true });
});

Deno.test('a lone null task is not parsed, and one among valid tasks is skipped, not fatal (#410)', () => {
  assertEquals(parsePlanningOutput('{"research_tasks": [null]}'), { tasks: [], parsed: false });
  const plan = parsePlanningOutput('{"research_tasks": [null, "Ada", {"focus": "the setting"}]}');
  assertEquals(plan.parsed, true);
  assertEquals(plan.tasks, [{ focus: 'the setting', entities: [], scenes: [] }]);
});
