/**
 * Research agents: independent model calls with tool access that investigate
 * story data and return focused briefs.
 *
 * Tool calls use an in-memory data cache (populated once by fetchResearchData)
 * to avoid redundant DB queries per tool call.
 *
 * KNOWN RESIDUAL with weak/local models: a model that "calls" a tool by writing
 * `<tool_call>…` into `content` instead of emitting a `tool_calls` array is
 * indistinguishable from one writing prose, so that markup lands in the brief. It is
 * not detected or stripped — the brief is advisory context for the draft, and a
 * heuristic that deletes model output is worse than a stray tag.
 */

import { fetchWithTimeout, isTimeoutError } from '../_shared/timeout.ts';
import { parseModelSlot, resolveUpstream, ModelProviderConfigError } from '../_shared/model-calling.ts';
import { UpstreamError } from '../_shared/api-errors.ts';
import { classifyUpstreamFailure } from '../_shared/upstream-classify.ts';
import type { ResearchTask } from './planner.ts';
import { AGENT_TOOLS, executeAgentToolCall } from './agent-tools.ts';
import type { StoryDataCache } from './agent-tools.ts';
import { getResearchAgentConfig } from './pipeline-prompts.ts';
import { escapeXml } from './research.ts';
import type { CodexEntryData, SceneData } from './research.ts';

const MAX_TOOL_ROUNDS = 4;
/** What a classified research failure calls itself in its relayed sentence. */
const RESEARCH_LABEL = 'Research agent API error';
/**
 * Rounds are sequential per task while tasks run in parallel, so a local server
 * that serialises requests spends this budget one round at a time — research is
 * the phase most likely to time out against a local model.
 */
const TIMEOUT_RESEARCH_AGENT_MS = 25_000;

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
  signal?: AbortSignal,
): Promise<ResearchBrief> {
  const { modelId } = parseModelSlot(modelSlot);
  // Round-invariant — the loop below used to rebuild url/headers per round.
  const target = resolveUpstream(modelSlot, { apiKey, openRouterPrefs });
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  /**
   * Tool definitions are sent on every round (see the request body below). A model
   * with no tool template answers the FIRST call with a 400 — see the retry at
   * round 0.
   */
  let toolsEnabled = true;

  // Build initial user message with pre-fetched data
  let userContent = `Research task: ${task.focus}\n`;

  if (rawData.codexEntries.length > 0) {
    userContent += '\n--- Pre-fetched Codex Entries ---\n';
    for (const entry of rawData.codexEntries) {
      userContent += `[${entry.title}]`;
      const role = (entry.metadata as { storyRole?: string } | null)?.storyRole;
      if (role) userContent += ` (${role})`;
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
    if (signal?.aborted) {
      return { focus: task.focus, brief: '', inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
    }
    const agentConfig = getResearchAgentConfig();
    const postRound = (): Promise<Response> => {
      const body: Record<string, unknown> = {
        model: modelId,
        messages,
        max_tokens: agentConfig.maxTokens,
        temperature: agentConfig.temperature,
        stream: false,
        ...(toolsEnabled ? { tools: AGENT_TOOLS } : {}),
      };
      // AFTER the body is built — bodyExtras overwrites `model` for `included:` slots.
      Object.assign(body, target.bodyExtras);
      return fetchWithTimeout(target.url, {
        method: 'POST',
        headers: target.headers,
        body: JSON.stringify(body),
        timeout: TIMEOUT_RESEARCH_AGENT_MS,
        signal,
      });
    };

    let response = await postRound();

    if (!response.ok) {
      const errorText = (await response.text()).substring(0, 200);
      // A local model with no tool template rejects the tool definitions outright.
      // Retry that round once without them: the loop then degenerates to a single
      // prose brief off the pre-fetched data — degraded, but not a stub.
      //
      // Round 0 ONLY, and that scope is the point rather than a simplification. A
      // later-round failure means the model DID emit tool_calls, so `messages`
      // already holds an assistant turn with tool_calls plus tool-role replies;
      // re-issuing without `tools` declared leaves tool-shaped turns in the
      // conversation, which some backends reject outright — a second, different
      // error this regex would not catch. Let those take the throw-and-log path.
      const looksLikeToolRejection = round === 0 && toolsEnabled
        && /tool|function[_ ]?call/i.test(errorText);
      if (!looksLikeToolRejection) {
        // Classification runs only once the retry is out of the picture — a
        // tool-rejecting provider must keep its second chance.
        throw classifyUpstreamFailure(response.status, errorText, RESEARCH_LABEL);
      }
      console.warn(
        `[ResearchAgent] Model rejected tool definitions (${response.status}: ${errorText}); retrying once without tools`,
      );
      toolsEnabled = false;
      response = await postRound();
      if (!response.ok) {
        const retryText = (await response.text()).substring(0, 200);
        // Classify on the RETRY's body — that is the failure that actually stopped us —
        // then carry the ORIGINAL error in the message. The regex is deliberately broad
        // (a backend that merely mentions `tool_choice` in an unrelated 400 spends one
        // wasted request here), and without this the wasted retry would also *replace*
        // the real reason with whatever the second, differently-shaped request tripped.
        const classified = classifyUpstreamFailure(response.status, retryText, RESEARCH_LABEL);
        throw new UpstreamError(
          classified.code,
          `${classified.message} [after retry without tools; original: ${errorText}]`,
          classified.status,
        );
      }
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
 * Failures no other research agent can make up for, and no retry of the same request
 * fixes. When EVERY agent failed and the first one failed for one of these reasons,
 * `runResearchAgents` stops pretending it produced research and rethrows.
 */
const HARD_RESEARCH_FAILURES: ReadonlySet<string> = new Set(['rate-limited', 'api-key-invalid']);

/**
 * Run all research agents concurrently and return their briefs.
 *
 * **`Promise.allSettled`, and the choice is load-bearing.** These tasks fan out with a
 * plain `.map()`, so `Promise.all` rejects on the FIRST failure and discards the
 * already-resolved briefs of every sibling — turning "one fewer brief" into "the whole
 * research phase dies before /draft runs". The per-agent swallow that used to be here
 * was protecting exactly that property; it just also swallowed the case where *nothing*
 * succeeded, answering HTTP 200 with `briefCount: 0` for a rejected API key.
 *
 * So: partial failure degrades exactly as before, total failure speaks up.
 */
export async function runResearchAgents(
  modelSlot: string,
  tasks: ResearchTask[],
  rawDataMap: Map<string, { codexEntries: CodexEntryData[]; scenes: SceneData[] }>,
  storyOutline: string,
  storyDataCache: StoryDataCache,
  apiKey: string | null,
  openRouterPrefs?: Record<string, unknown>,
  signal?: AbortSignal,
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
        signal,
      );
    } catch (err) {
      if (!(err instanceof ModelProviderConfigError)) {
        const errMsg = isTimeoutError(err) ? 'timed out' : (err as Error).message || 'unknown error';
        console.error(`[ResearchAgent] Agent for "${task.focus}" failed: ${errMsg}`);
      }
      // Rejected rather than swallowed — the caller below decides, because only it can
      // see whether any sibling succeeded.
      throw err;
    }
  });

  const settled = await Promise.allSettled(promises);
  const briefs: ResearchBrief[] = [];
  const failures: unknown[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') briefs.push(result.value);
    else failures.push(result.reason);
  }

  // A provider/config error is not a per-agent runtime failure — swallowing it is
  // exactly how "unset OLLAMA_BASE_URL" used to answer 200 with empty briefs. It is
  // rethrown even when siblings succeeded, because it is a fact about the instance
  // rather than about this task. `validateCommonBody` resolves all four slots up front
  // so this should be unreachable; rethrow rather than rely on that.
  const configError = failures.find(err => err instanceof ModelProviderConfigError);
  if (configError) throw configError;

  // Nothing came back at all. Search ALL the failures, exactly as the config-error
  // check above does — an earlier version looked only at `failures[0]` on the theory
  // that a total failure is homogeneous, and that theory does not hold: the tasks share
  // one rate-limit budget, so one hitting 429 while a sibling's content trips a 400 is
  // an ordinary outcome. Whether the hard failure lands at index 0 then decides between
  // reporting it and answering 200 with `briefCount: 0` — the very bug this replaced.
  const hardFailure = failures.find(err =>
    isTimeoutError(err) || (err instanceof UpstreamError && HARD_RESEARCH_FAILURES.has(err.code)));
  if (briefs.length === 0 && hardFailure) throw hardFailure;

  return briefs;
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
