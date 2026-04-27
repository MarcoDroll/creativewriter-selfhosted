/**
 * Research agents: independent model calls with tool access that investigate
 * story data and return focused briefs.
 *
 * Tool calls use an in-memory data cache (populated once by fetchResearchData)
 * to avoid redundant DB queries per tool call.
 */

import { fetchWithTimeout, isTimeoutError } from '../_shared/timeout.ts';
import { requireEnv } from '../_shared/stripe-helpers.ts';
import { deepseekRequestFields } from '../_shared/deepseek-model.ts';
import type { ResearchTask } from './planner.ts';
import { AGENT_TOOLS, executeAgentToolCall } from './agent-tools.ts';
import type { StoryDataCache } from './agent-tools.ts';
import { getResearchAgentConfig } from './pipeline-prompts.ts';
import { escapeXml } from './research.ts';
import type { CodexEntryData, SceneData } from './research.ts';

const MAX_TOOL_ROUNDS = 4;

export const RESEARCH_AGENT_SYSTEM_PROMPT = `You are a story research assistant. Investigate the topic below using the provided data and tools.

Instructions:
- Use the pre-fetched data as your starting point
- Use tools to fetch additional data you discover is relevant (e.g., a character mentioned in a scene, a location referenced in a codex entry)
- Focus ONLY on what is relevant to the research task — do not summarize everything
- Prioritize NEW details not obvious from the codex entry alone: prior interactions, emotional arcs, unresolved tensions, characteristic speech patterns
- Note connections, contradictions, or important details between sources
- Flag any entities or scenes you couldn't look up
- Keep your brief concise: 200-500 words
- Output ONLY the research brief, no preamble or meta-commentary`;

export interface ResearchBrief {
  focus: string;
  brief: string;
  inputTokens: number;
  outputTokens: number;
}

interface ModelConfig {
  provider: string;
  modelId: string;
}

function parseModelSlot(slot: string): ModelConfig {
  const [provider, ...rest] = slot.split(':');
  return { provider, modelId: rest.join(':') };
}

/**
 * Run a single research agent with tool access.
 * Tools search the storyDataCache in-memory — no DB queries per tool call.
 */
export async function runResearchAgent(
  modelSlot: string,
  task: ResearchTask,
  rawData: { codexEntries: CodexEntryData[]; scenes: SceneData[] },
  storyOutline: string,
  storyDataCache: StoryDataCache,
  apiKey: string | null,
  openRouterPrefs?: Record<string, unknown>,
): Promise<ResearchBrief> {
  const { provider, modelId } = parseModelSlot(modelSlot);
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Build initial user message with pre-fetched data
  let userContent = `Research task: ${task.focus}\n`;

  if (rawData.codexEntries.length > 0) {
    userContent += '\n--- Pre-fetched Codex Entries ---\n';
    for (const entry of rawData.codexEntries) {
      userContent += `[${entry.title}]`;
      if (entry.story_role) userContent += ` (${entry.story_role})`;
      userContent += `\n${entry.content}\n\n`;
    }
  }

  if (rawData.scenes.length > 0) {
    userContent += '\n--- Pre-fetched Scenes ---\n';
    for (const scene of rawData.scenes) {
      userContent += `[Scene: ${scene.title}]\n${scene.content}\n\n`;
    }
  }

  if (storyOutline) {
    userContent += `\n--- Story Outline ---\n${storyOutline}\n`;
  }

  const messages: Array<{ role: string; content?: string; tool_calls?: unknown[]; tool_call_id?: string; name?: string }> = [
    { role: 'system', content: RESEARCH_AGENT_SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];

  // Agent tool loop — max MAX_TOOL_ROUNDS tool rounds + 1 final answer round
  for (let round = 0; round < MAX_TOOL_ROUNDS + 1; round++) {
    const agentConfig = getResearchAgentConfig();
    const body: Record<string, unknown> = {
      model: modelId,
      messages,
      max_tokens: agentConfig.maxTokens,
      temperature: agentConfig.temperature,
      stream: false,
      tools: AGENT_TOOLS,
    };

    let url: string;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (provider === 'openrouter') {
      url = 'https://openrouter.ai/api/v1/chat/completions';
      headers['Authorization'] = `Bearer ${apiKey}`;
      headers['HTTP-Referer'] = 'https://creativewriter.dev';
      headers['X-Title'] = 'Creative Writer';
      if (openRouterPrefs && Object.keys(openRouterPrefs).length > 0) {
        body.provider = openRouterPrefs;
      }
    } else {
      // included (DeepSeek) — map slot ID to V4 Flash + thinking flag
      Object.assign(body, deepseekRequestFields(modelId));
      url = 'https://api.deepseek.com/v1/chat/completions';
      headers['Authorization'] = `Bearer ${requireEnv('DEEPSEEK_API_KEY')}`;
    }

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      timeout: 30_000,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Research agent API error (${response.status}): ${errorText.substring(0, 200)}`);
    }

    const data = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: Array<{
            id: string;
            type: string;
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    totalInputTokens += data.usage?.prompt_tokens || 0;
    totalOutputTokens += data.usage?.completion_tokens || 0;

    const choice = data.choices?.[0];
    const assistantMessage = choice?.message;

    if (!assistantMessage) {
      return { focus: task.focus, brief: '', inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
    }

    // If model wants to use tools and we haven't exhausted rounds
    // Check tool_calls array presence — some providers return finish_reason='stop' with tool_calls
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0 && round < MAX_TOOL_ROUNDS) {
      // Add assistant message with tool calls
      messages.push({
        role: 'assistant',
        content: assistantMessage.content || undefined,
        tool_calls: assistantMessage.tool_calls,
      });

      // Execute each tool call using in-memory cache (no DB queries)
      for (const toolCall of assistantMessage.tool_calls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          args = {};
        }

        const result = executeAgentToolCall(
          toolCall.function.name,
          args,
          storyDataCache,
        );

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: result,
        });
      }

      // Continue loop for next model call
      continue;
    }

    // Model finished (stop or exhausted tool rounds) — return brief
    return {
      focus: task.focus,
      brief: assistantMessage.content || '',
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
    };
  }

  // Should not reach here, but safety fallback
  return { focus: task.focus, brief: '', inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
}

/**
 * Run all research agents concurrently and return their briefs.
 */
export async function runResearchAgents(
  modelSlot: string,
  tasks: ResearchTask[],
  rawDataMap: Map<string, { codexEntries: CodexEntryData[]; scenes: SceneData[] }>,
  storyOutline: string,
  storyDataCache: StoryDataCache,
  apiKey: string | null,
  openRouterPrefs?: Record<string, unknown>,
): Promise<ResearchBrief[]> {
  const promises = tasks.map(async (task, index) => {
    const taskKey = String(index);
    const rawData = rawDataMap.get(taskKey) || { codexEntries: [], scenes: [] };
    try {
      return await runResearchAgent(
        modelSlot,
        task,
        rawData,
        storyOutline,
        storyDataCache,
        apiKey,
        openRouterPrefs,
      );
    } catch (err) {
      const errMsg = isTimeoutError(err) ? 'timed out' : (err as Error).message || 'unknown error';
      console.error(`[ResearchAgent] Agent for "${task.focus}" failed: ${errMsg}`);
      return null;
    }
  });

  const results = await Promise.all(promises);
  return results.filter((r): r is ResearchBrief => r !== null);
}

/**
 * Consolidate research briefs into an XML block for the writing call.
 */
export function consolidateResearchBriefs(briefs: ResearchBrief[]): string {
  const nonEmpty = briefs.filter(b => b.brief.trim().length > 0);
  if (nonEmpty.length === 0) return '';

  let xml = '<research-context>\n';
  for (const brief of nonEmpty) {
    xml += `<research focus="${escapeXml(brief.focus)}">\n${escapeXml(brief.brief.trim())}\n</research>\n`;
  }
  xml += '</research-context>';
  return xml;
}
