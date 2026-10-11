/**
 * Tool definitions and execution for research agents.
 * Codex lookups search an in-memory cache (populated once from fetchResearchData); scene
 * prose is read on first ask and remembered, so the whole manuscript is never downloaded.
 */

import { nameMatches } from './research.ts';
import type { CodexEntryData, SceneRef, SceneTextLoader } from './research.ts';

/** OpenAI function-calling format tool definitions */
export const AGENT_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'get_codex_entry',
      description: 'Look up a codex entry (character, location, item) by name. Returns the full description and metadata.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The name of the codex entry to look up (character name, location, item, etc.)',
          },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_scene_text',
      description: 'Fetch the full text of a scene by its title. Use this to read prior events or context from other scenes.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'The title of the scene to look up',
          },
        },
        required: ['title'],
      },
    },
  },
];

/**
 * Pre-fetched story data cache shared across all tool calls for a pipeline run.
 * Populated once by fetchResearchData. Codex entries are searched in memory; scenes are
 * matched by title against an index, and their prose is read through `loadSceneText` only
 * when a tool call asks for it (then remembered for the rest of the run).
 */
export interface StoryDataCache {
  codexEntries: CodexEntryData[];
  scenes: SceneRef[];
  loadSceneText: SceneTextLoader;
}

/**
 * Execute an agent tool call. Codex lookups are served from the pre-fetched cache; a scene's
 * prose is read once, on first ask.
 */
export async function executeAgentToolCall(
  toolName: string,
  args: Record<string, unknown>,
  cache: StoryDataCache,
): Promise<string> {
  try {
    if (toolName === 'get_codex_entry') {
      return getCodexEntry(args.name as string, cache.codexEntries);
    }
    if (toolName === 'get_scene_text') {
      return await getSceneText(args.title as string, cache);
    }
    return `Unknown tool: ${toolName}`;
  } catch (err) {
    console.error(`[AgentTools] Tool ${toolName} failed:`, err);
    return `Error executing ${toolName}: ${(err as Error).message || 'unknown error'}`;
  }
}

function getCodexEntry(name: string, codexEntries: CodexEntryData[]): string {
  if (!name) return 'No name provided';
  if (codexEntries.length === 0) return 'No codex entries available';

  const matched = codexEntries.find(entry => nameMatches(entry, name));
  if (!matched) return `No codex entry found matching "${name}"`;

  let result = `[${matched.title}]`;
  const role = (matched.metadata as { storyRole?: string } | null)?.storyRole;
  if (role) result += ` (${role})`;
  result += `\n${matched.content}`;

  const aliases = (matched.metadata as { aliases?: string[] })?.aliases;
  if (Array.isArray(aliases) && aliases.length > 0) {
    result += `\nAliases: ${aliases.join(', ')}`;
  }

  return result;
}

async function getSceneText(title: string, cache: StoryDataCache): Promise<string> {
  if (!title) return 'No title provided';
  if (cache.scenes.length === 0) return 'No scenes available';

  const matched = cache.scenes.find(scene =>
    scene.title.toLowerCase().includes(title.toLowerCase()) ||
    title.toLowerCase().includes(scene.title.toLowerCase())
  );

  if (!matched) return `No scene found matching "${title}"`;

  // The loader strips and truncates, so the tool never returns raw HTML or a whole chapter.
  const content = await cache.loadSceneText(matched.id);
  if (content === null) return `Could not read the scene "${matched.title}"`;
  return `[Scene: ${matched.title}]\n${content}`;
}
