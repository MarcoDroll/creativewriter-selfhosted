/**
 * Tool definitions and execution for research agents.
 * Tools search an in-memory data cache (populated once from fetchResearchData)
 * to avoid redundant DB queries per tool call.
 */

import { nameMatches, stripHtml } from './research.ts';
import type { CodexEntryData, SceneData } from './research.ts';

const MAX_SCENE_TEXT_LENGTH = 15_000;

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
 * Populated once by fetchResearchData, searched in-memory by tools.
 */
export interface StoryDataCache {
  codexEntries: CodexEntryData[];
  scenes: SceneData[];
}

/**
 * Execute an agent tool call using the in-memory data cache.
 * No DB queries are made — all data comes from the pre-fetched cache.
 */
export function executeAgentToolCall(
  toolName: string,
  args: Record<string, unknown>,
  cache: StoryDataCache,
): string {
  try {
    if (toolName === 'get_codex_entry') {
      return getCodexEntry(args.name as string, cache.codexEntries);
    }
    if (toolName === 'get_scene_text') {
      return getSceneText(args.title as string, cache.scenes);
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
  if (matched.story_role) result += ` (${matched.story_role})`;
  result += `\n${matched.content}`;

  const aliases = (matched.metadata as { aliases?: string[] })?.aliases;
  if (Array.isArray(aliases) && aliases.length > 0) {
    result += `\nAliases: ${aliases.join(', ')}`;
  }

  return result;
}

function getSceneText(title: string, scenes: SceneData[]): string {
  if (!title) return 'No title provided';
  if (scenes.length === 0) return 'No scenes available';

  const matched = scenes.find(scene =>
    scene.title.toLowerCase().includes(title.toLowerCase()) ||
    title.toLowerCase().includes(scene.title.toLowerCase())
  );

  if (!matched) return `No scene found matching "${title}"`;

  // scenes are already stripped/truncated by fetchAllScenes
  return `[Scene: ${matched.title}]\n${matched.content}`;
}
