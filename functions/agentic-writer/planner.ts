/**
 * Planning step: the orchestrator (Writing Model) analyzes the beat prompt
 * and identifies what research the agents should investigate.
 */

export const PLANNING_SYSTEM_PROMPT = `You are a story writing orchestrator. Analyze the beat generation request and identify what research would improve the writing.

You receive the full context: the author's style instructions (system message), story outline, always-include codex entries, and the beat prompt with surrounding scene text.

Your job: decide what ADDITIONAL context the research agents should investigate from the story's codex and scenes.

Output a JSON object with exactly this structure:
{
  "research_tasks": [
    {
      "focus": "What the agent should investigate and why",
      "entities": ["character or location name to look up in codex"],
      "scenes": ["scene title to look up for relevant context"]
    }
  ]
}

Rules:
- Each task's "focus" should describe what the agent needs to find/analyze, not just "look up X"
- "entities" are codex entry names (characters, locations, items) — the agent will get their full descriptions
- "scenes" are scene titles whose text may contain relevant prior events
- Max 4 research tasks
- Max 5 unique entities total across all tasks
- Max 3 unique scenes total across all tasks
- Do NOT request entities or scenes already visible in the system message (always-include codex entries are already there)
- If the prompt and existing context are sufficient, return {"research_tasks": []}
- Output ONLY the JSON object, no other text`;

export interface ResearchTask {
  focus: string;
  entities: string[];
  scenes: string[];
}

export interface ResearchPlan {
  tasks: ResearchTask[];
}

/**
 * What `parsePlanningOutput` returns: the plan, plus whether the planner's answer could
 * be read at all (#410). `{"research_tasks": []}` is `parsed: true` with no tasks — the
 * planner asked for nothing. Prose, a broken object, an object without a
 * `research_tasks` array, or tasks none of which has a usable `focus` are
 * `parsed: false`, also with no tasks: research is skipped either way, but only this one
 * deserves a warning. `/research` reports it as `planParsed`.
 */
export interface ParsedResearchPlan extends ResearchPlan {
  parsed: boolean;
}

const unreadable = (): ParsedResearchPlan => ({ tasks: [], parsed: false });

/**
 * Parse the planning output JSON from the orchestrator.
 * Falls back to an empty plan, flagged `parsed: false`, on a parse failure.
 */
export function parsePlanningOutput(content: string): ParsedResearchPlan {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[Planner] No JSON found in planning output');
      return unreadable();
    }
    const parsed = JSON.parse(jsonMatch[0]);
    // `jsonMatch[0]` starts with `{`, so `parsed` is an object (or the parse threw).
    if (!Array.isArray(parsed.research_tasks)) {
      console.warn('[Planner] Planning output has no research_tasks array');
      return unreadable();
    }
    const asked = parsed.research_tasks as unknown[];

    // Keep the usable tasks — an object with a non-empty string `focus` — BEFORE the
    // 4-task cap, so junk entries (null, a bare string, no focus) neither take a slot
    // nor spend the entity/scene budget below.
    const tasks: ResearchTask[] = asked
      .filter((t): t is Record<string, unknown> =>
        typeof t === 'object' && t !== null && typeof (t as Record<string, unknown>).focus === 'string'
        && ((t as Record<string, unknown>).focus as string).length > 0)
      .slice(0, 4)
      .map((t) => ({
        focus: t.focus as string,
        entities: Array.isArray(t.entities) ? t.entities.filter((e: unknown) => typeof e === 'string').slice(0, 5) : [],
        scenes: Array.isArray(t.scenes) ? t.scenes.filter((s: unknown) => typeof s === 'string').slice(0, 3) : [],
      }));

    // Tasks asked for and none of them usable is a plan that could not be read, not
    // one that asked for nothing.
    if (asked.length > 0 && tasks.length === 0) {
      console.warn('[Planner] No planning task has a usable focus');
      return unreadable();
    }

    // Enforce global limits: max 5 unique entities, 3 unique scenes
    const seenEntities = new Set<string>();
    const seenScenes = new Set<string>();
    for (const task of tasks) {
      task.entities = task.entities.filter(e => {
        if (seenEntities.size >= 5) return false;
        const lower = e.toLowerCase();
        if (seenEntities.has(lower)) return true; // already counted
        seenEntities.add(lower);
        return true;
      });
      task.scenes = task.scenes.filter(s => {
        if (seenScenes.size >= 3) return false;
        const lower = s.toLowerCase();
        if (seenScenes.has(lower)) return true;
        seenScenes.add(lower);
        return true;
      });
    }

    return { tasks, parsed: true };
  } catch (err) {
    console.error('[Planner] Failed to parse planning output:', err);
    return unreadable();
  }
}
