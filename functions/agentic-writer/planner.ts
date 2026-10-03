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
 * Parse the planning output JSON from the orchestrator.
 * Gracefully falls back to an empty plan on parse failure.
 */
export function parsePlanningOutput(content: string): ResearchPlan {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[Planner] No JSON found in planning output');
      return { tasks: [] };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    const rawTasks = Array.isArray(parsed.research_tasks) ? parsed.research_tasks : [];

    // Enforce limits
    const tasks: ResearchTask[] = rawTasks.slice(0, 4).map((t: Record<string, unknown>) => ({
      focus: typeof t.focus === 'string' ? t.focus : '',
      entities: Array.isArray(t.entities) ? t.entities.filter((e: unknown) => typeof e === 'string').slice(0, 5) : [],
      scenes: Array.isArray(t.scenes) ? t.scenes.filter((s: unknown) => typeof s === 'string').slice(0, 3) : [],
    }));

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

    // Filter out tasks with no focus
    return { tasks: tasks.filter(t => t.focus.length > 0) };
  } catch (err) {
    console.error('[Planner] Failed to parse planning output:', err);
    return { tasks: [] };
  }
}
