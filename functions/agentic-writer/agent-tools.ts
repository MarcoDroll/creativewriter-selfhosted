/**
 * Tool definitions and execution for research agents.
 * Codex lookups search an in-memory cache (populated once from fetchResearchData); scene
 * prose is read on first ask and remembered, so the whole manuscript is never downloaded.
 */

import { nameMatches } from './research.ts';
import type { CodexEntryData, SceneRef, StoryDataCache } from './research.ts';

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

/**
 * The scene a title names, best match first (#405): the exact title (case-insensitive),
 * then a scene whose title contains the ask, then one whose title the ask contains. One
 * `find` over both substring directions let "Scene 3" answer for "Scene 39" and the
 * reverse, whichever came first in the index. Ties within a tier go to the first scene in
 * the index, so two scenes with one title still resolve to the same one every time. A
 * scene with a blank title is a substring of every ask, so it only ever answers exactly.
 */
function findScene(scenes: SceneRef[], ask: string): SceneRef | undefined {
  const wanted = ask.toLowerCase();
  const titled = scenes.map(scene => ({ scene, title: scene.title.trim().toLowerCase() }));
  return (
    titled.find(s => s.title === wanted) ??
    titled.find(s => s.title !== '' && s.title.includes(wanted)) ??
    titled.find(s => s.title !== '' && wanted.includes(s.title))
  )?.scene;
}

async function getSceneText(rawTitle: string, cache: StoryDataCache): Promise<string> {
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  if (!title) return 'No title provided';
  if (cache.scenes.length === 0) return 'No scenes available';

  const matched = findScene(cache.scenes, title);

  if (!matched) return `No scene found matching "${title}"`;

  // The loader strips and truncates, so the tool never returns raw HTML or a whole chapter.
  const content = await cache.loadSceneText(matched.id);
  if (content === null) return `Could not read the scene "${matched.title}"`;
  return `[Scene: ${matched.title}]\n${content}`;
}
