import { corsHeaders, handleCorsPreflightIfNeeded, jsonResponse } from '../_shared/cors.ts';
import { extractAuthFromRequest } from '../_shared/auth.ts';
import { rateLimitResponse } from '../_shared/rate-limit.ts';
import { fetchWithTimeout, isTimeoutError } from '../_shared/timeout.ts';
import { validateJwtAndGetSubscription, requireEnv, getOrCreateCustomer, getStripe } from '../_shared/stripe-helpers.ts';
import { getUserClient } from '../_shared/supabase-user.ts';
import { getCycleMonth, getMonthlyUsage, logUsage, getMonthlyBudget, resolveIncludedAiTier } from '../_shared/ai-usage.ts';
import type { ErrorResponse } from '../_shared/types.ts';
import {
  REFINE_SYSTEM_PROMPT,
  RESEARCH_CONTEXT_PREAMBLE,
  CRITIQUE_SYSTEM_PROMPT,
  getCritiqueConfig,
  getPlanningConfig,
  getDraftConfig,
  getRefineConfig,
} from './pipeline-prompts.ts';
import { PLANNING_SYSTEM_PROMPT, parsePlanningOutput } from './planner.ts';
import { fetchResearchData, fetchStoryOutline } from './research.ts';
import { runResearchAgents, consolidateResearchBriefs } from './research-agent.ts';
import { analyzeCliches, fetchStoryClicheIndex, formatClicheIndexForPrompt } from './cliche-analyzer.ts';

console.log('[AgenticWriter] Module loaded');

// --- SSE helpers ---

const encoder = new TextEncoder();

async function sendSSE(writer: WritableStreamDefaultWriter, data: string): Promise<boolean> {
  try {
    await writer.write(encoder.encode(`data: ${data}\n\n`));
    return true;
  } catch {
    return false; // Client disconnected
  }
}

async function sendStatus(
  writer: WritableStreamDefaultWriter,
  status: string,
  step: number,
  totalSteps: number,
  detail?: string,
  metadata?: Record<string, unknown>
): Promise<boolean> {
  const payload: Record<string, unknown> = { status, step, totalSteps };
  if (detail) payload.detail = detail;
  if (metadata) payload.metadata = metadata;
  return sendSSE(writer, JSON.stringify(payload));
}

async function sendContentChunk(writer: WritableStreamDefaultWriter, content: string): Promise<boolean> {
  return sendSSE(writer, JSON.stringify({
    choices: [{ delta: { content }, finish_reason: null }],
  }));
}

async function sendWarning(writer: WritableStreamDefaultWriter, message: string): Promise<boolean> {
  return sendSSE(writer, JSON.stringify({ warning: message }));
}

async function sendDone(writer: WritableStreamDefaultWriter): Promise<void> {
  await sendSSE(writer, JSON.stringify({
    choices: [{ delta: {}, finish_reason: 'stop' }],
  }));
  await sendSSE(writer, '[DONE]');
  try { await writer.close(); } catch { /* already closed */ }
}

async function sendError(writer: WritableStreamDefaultWriter, message: string): Promise<void> {
  await sendSSE(writer, JSON.stringify({ error: message }));
  try { await writer.close(); } catch { /* already closed */ }
}

// --- Model calling ---

interface ModelConfig {
  provider: string; // 'openrouter' or 'included'
  modelId: string;  // e.g., 'deepseek/deepseek-chat' or 'deepseek-chat'
}

/** Extract human-readable model name from a slot like 'openrouter:anthropic/claude-3.5-sonnet' → 'claude-3.5-sonnet' */
function shortModelName(slot: string): string {
  const afterColon = slot.includes(':') ? slot.split(':').slice(1).join(':') : slot;
  const lastSegment = afterColon.split('/').pop() || afterColon;
  // Strip OpenRouter suffixes like :free, :extended
  return lastSegment.replace(/:(?:free|extended|beta|nitro)$/, '');
}

function parseModelSlot(slot: string): ModelConfig {
  const [provider, ...rest] = slot.split(':');
  return { provider, modelId: rest.join(':') };
}

interface CallModelResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: string | null;
}

/**
 * Call a model (non-streaming). Used for the planning step.
 * Accepts either a systemPrompt+userContent pair or a full messages array.
 */
async function callModel(
  modelSlot: string,
  systemPrompt: string,
  userContent: string,
  config: { maxTokens: number; temperature: number },
  apiKey: string | null,
  openRouterPrefs?: Record<string, unknown>,
  timeoutMs = 30_000
): Promise<CallModelResult> {
  const { provider, modelId } = parseModelSlot(modelSlot);

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  const body: Record<string, unknown> = {
    model: modelId,
    messages,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    stream: false,
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
    // included (DeepSeek)
    url = 'https://api.deepseek.com/v1/chat/completions';
    headers['Authorization'] = `Bearer ${requireEnv('DEEPSEEK_API_KEY')}`;
  }

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    timeout: timeoutMs,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Model API error (${response.status}): ${errorText.substring(0, 200)}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };

  const finishReason = data.choices?.[0]?.finish_reason || null;

  return {
    content: data.choices?.[0]?.message?.content || '',
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
    finishReason,
  };
}

/**
 * Call a model with streaming. Used for draft and refine steps.
 * Streams content chunks to the SSE writer.
 */
async function streamToClient(
  writer: WritableStreamDefaultWriter,
  modelSlot: string,
  systemPrompt: string | null,
  userContent: string,
  messages: Array<{ role: string; content: string }> | null,
  config: { maxTokens: number; temperature: number },
  apiKey: string | null,
  openRouterPrefs?: Record<string, unknown>,
  timeoutMs = 120_000
): Promise<CallModelResult> {
  const { provider, modelId } = parseModelSlot(modelSlot);

  const requestMessages = messages || [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    { role: 'user', content: userContent },
  ];

  const body: Record<string, unknown> = {
    model: modelId,
    messages: requestMessages,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    stream: true,
    stream_options: { include_usage: true },
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
    url = 'https://api.deepseek.com/v1/chat/completions';
    headers['Authorization'] = `Bearer ${requireEnv('DEEPSEEK_API_KEY')}`;
  }

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    timeout: timeoutMs,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Model API error (${response.status}): ${errorText.substring(0, 200)}`);
  }

  if (!response.body) {
    throw new Error('Empty response body from model API');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulatedContent = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      const data = line.slice(6);
      try {
        const parsed = JSON.parse(data);
        // Extract usage data
        if (parsed.usage) {
          inputTokens = parsed.usage.prompt_tokens || 0;
          outputTokens = parsed.usage.completion_tokens || 0;
        }
        // Track finish_reason from the last chunk that has one
        if (parsed.choices?.[0]?.finish_reason) {
          finishReason = parsed.choices[0].finish_reason;
        }
        const delta = parsed.choices?.[0]?.delta;
        if (delta?.content) {
          accumulatedContent += delta.content;
          const ok = await sendContentChunk(writer, delta.content);
          if (!ok) {
            // Client disconnected, cancel upstream
            try { await reader.cancel(); } catch { /* ignore */ }
            return { content: accumulatedContent, inputTokens, outputTokens, finishReason };
          }
        }
      } catch { /* ignore parse errors */ }
    }
  }

  return { content: accumulatedContent, inputTokens, outputTokens, finishReason };
}

/**
 * Call a model non-streaming and collect the result (used for draft in thorough mode).
 */
async function callModelCollect(
  modelSlot: string,
  systemPrompt: string | null,
  userContent: string,
  messages: Array<{ role: string; content: string }> | null,
  config: { maxTokens: number; temperature: number },
  apiKey: string | null,
  openRouterPrefs?: Record<string, unknown>,
  timeoutMs = 120_000
): Promise<CallModelResult> {
  const { provider, modelId } = parseModelSlot(modelSlot);

  const requestMessages = messages || [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    { role: 'user', content: userContent },
  ];

  const body: Record<string, unknown> = {
    model: modelId,
    messages: requestMessages,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    stream: false,
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
    url = 'https://api.deepseek.com/v1/chat/completions';
    headers['Authorization'] = `Bearer ${requireEnv('DEEPSEEK_API_KEY')}`;
  }

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    timeout: timeoutMs,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Model API error (${response.status}): ${errorText.substring(0, 200)}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };

  const finishReason = data.choices?.[0]?.finish_reason || null;

  return {
    content: data.choices?.[0]?.message?.content || '',
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
    finishReason,
  };
}

// --- Budget tracking for included models ---

interface BudgetContext {
  customerId: string | null;
  cycleMonth: string;
  usesIncluded: boolean;
  budgetUsd: number;
}

async function setupBudgetContext(
  request: Request,
  headers: Record<string, string>,
  models: { writing: string; research: string; refiner: string }
): Promise<BudgetContext | Response> {
  const usesIncluded = [models.writing, models.research, models.refiner]
    .some(m => m.startsWith('included:'));

  if (!usesIncluded) {
    return { customerId: null, cycleMonth: getCycleMonth(), usesIncluded: false, budgetUsd: 0 };
  }

  // Check if DeepSeek API key is available
  if (!Deno.env.get('DEEPSEEK_API_KEY')) {
    return jsonResponse<ErrorResponse>(
      { error: 'Included AI models require DEEPSEEK_API_KEY to be configured' },
      400,
      headers
    );
  }

  // For self-hosted, skip subscription check
  if (Deno.env.get('SELF_HOSTED') === 'true') {
    return { customerId: null, cycleMonth: getCycleMonth(), usesIncluded: true, budgetUsd: 0 };
  }

  // Hosted: validate subscription and check budget
  const validation = await validateJwtAndGetSubscription(request, headers);
  if (validation instanceof Response) return validation;
  const budgetTier = resolveIncludedAiTier(validation);
  if (!budgetTier) {
    return jsonResponse<ErrorResponse>(
      { error: 'Subscription required for included AI models' },
      403,
      headers
    );
  }
  const budgetUsd = getMonthlyBudget(budgetTier);

  let customerId = validation.customerId;
  if (!customerId) {
    customerId = await getOrCreateCustomer(getStripe()!, validation.email!, validation.userId!);
  }
  const cycleMonth = getCycleMonth();
  const totalCostUsd = await getMonthlyUsage(customerId, cycleMonth);
  if (totalCostUsd >= budgetUsd) {
    return jsonResponse<ErrorResponse>(
      { error: 'Monthly AI budget exceeded' },
      429,
      headers
    );
  }

  return { customerId, cycleMonth, usesIncluded: true, budgetUsd };
}

async function trackUsageIfIncluded(
  modelSlot: string,
  budget: BudgetContext,
  inputTokens: number,
  outputTokens: number
): Promise<void> {
  if (!budget.usesIncluded || !budget.customerId) return;
  if (!modelSlot.startsWith('included:')) return;
  try {
    const model = modelSlot.split(':').slice(1).join(':') || 'deepseek-chat';
    await logUsage(budget.customerId, budget.cycleMonth, inputTokens, outputTokens, model);
  } catch (err) {
    console.error('[AgenticWriter] Failed to track usage:', err);
  }
}

async function checkBudgetBetweenSteps(budget: BudgetContext): Promise<boolean> {
  if (!budget.usesIncluded || !budget.customerId) return true;
  try {
    const totalCostUsd = await getMonthlyUsage(budget.customerId, budget.cycleMonth);
    return totalCostUsd < budget.budgetUsd;
  } catch (err) {
    console.error('[AgenticWriter] Budget check failed, allowing continuation:', err);
    return true; // Permissive fallback — don't block generation on billing DB outage
  }
}

// --- Pipeline ---

interface PipelineConfig {
  messages: Array<{ role: string; content: string }>;
  storyId: string;
  sceneId?: string;
  wordCount: number;
  preset: 'balanced' | 'thorough';
  models: { writing: string; research: string; refiner: string };
  temperature?: number;
  apiKey: string | null;
  userJwt: string;
  openRouterPrefs?: Record<string, unknown>;
  budget: BudgetContext;
}

async function runPipeline(
  writer: WritableStreamDefaultWriter,
  config: PipelineConfig
): Promise<void> {
  const pipelineStartTime = Date.now();
  const totalSteps = config.preset === 'thorough' ? 4 : 3;
  const researchModel = config.models.research;
  const refinerModel = config.models.refiner;

  try {
    // --- STEP 1: PLANNING ---
    if (!await sendStatus(writer, 'planning', 1, totalSteps, undefined, { model: shortModelName(config.models.writing) })) return;

    // Build planning input from the full original messages
    const planningInput = config.messages
      .map(m => `[${m.role}]\n${m.content}`)
      .join('\n\n');

    const planningConfig = getPlanningConfig();
    const planResult = await callModel(
      config.models.writing,
      PLANNING_SYSTEM_PROMPT,
      planningInput,
      planningConfig,
      config.apiKey,
      config.openRouterPrefs,
    );
    await trackUsageIfIncluded(config.models.writing, config.budget, planResult.inputTokens, planResult.outputTokens);

    const plan = parsePlanningOutput(planResult.content);
    console.log(`[AgenticWriter] Planning produced ${plan.tasks.length} research tasks`);

    // Budget check after planning
    if (!await checkBudgetBetweenSteps(config.budget)) {
      await sendError(writer, 'Monthly AI budget exceeded during pipeline');
      return;
    }

    // --- STEP 2: RESEARCH AGENTS ---
    let researchContext = '';
    let researchBriefCount = 0;
    let researchCodexCount = 0;
    let researchSceneCount = 0;
    let clicheBlock = '';

    if (plan.tasks.length > 0 && config.storyId) {
      const taskCount = plan.tasks.length;
      const tasksMetadata = plan.tasks.map(t => ({
        focus: t.focus, entities: t.entities, scenes: t.scenes,
      }));
      if (!await sendStatus(writer, 'researching', 2, totalSteps,
        `Researching ${taskCount} topic${taskCount === 1 ? '' : 's'}...`,
        { tasks: tasksMetadata, model: shortModelName(researchModel) }
      )) return;

      const userClient = getUserClient(config.userJwt);

      // Parallel: fetch raw data + story outline + cliché index
      const [researchData, storyOutline, clicheEntries] = await Promise.all([
        fetchResearchData(plan, config.storyId, userClient, config.sceneId),
        fetchStoryOutline(config.storyId, userClient),
        fetchStoryClicheIndex(userClient, config.storyId),
      ]);
      clicheBlock = formatClicheIndexForPrompt(clicheEntries);

      // Run research agents concurrently — tools use the fullCache (no DB queries per tool call)
      const briefs = await runResearchAgents(
        researchModel,
        plan.tasks,
        researchData.taskDataMap,
        storyOutline,
        researchData.fullCache,
        config.apiKey,
        config.openRouterPrefs,
      );

      // Track usage for all agent calls
      for (const brief of briefs) {
        await trackUsageIfIncluded(researchModel, config.budget, brief.inputTokens, brief.outputTokens);
      }

      researchContext = consolidateResearchBriefs(briefs);
      researchBriefCount = briefs.length;
      researchCodexCount = researchData.fullCache.codexEntries.length;
      researchSceneCount = researchData.fullCache.scenes.length;
      console.log(`[AgenticWriter] Research completed: ${briefs.length} briefs, context length ${researchContext.length}`);
    } else {
      // No research needed — skip but still show status briefly
      if (!await sendStatus(writer, 'researching', 2, totalSteps, 'No additional research needed', { model: shortModelName(researchModel) })) return;

      // Still fetch cliché index if we have a storyId
      if (config.storyId) {
        const userClient = getUserClient(config.userJwt);
        const clicheEntries = await fetchStoryClicheIndex(userClient, config.storyId);
        clicheBlock = formatClicheIndexForPrompt(clicheEntries);
      }
    }

    // Budget check after research
    if (!await checkBudgetBetweenSteps(config.budget)) {
      await sendError(writer, 'Monthly AI budget exceeded during pipeline');
      return;
    }

    // --- STEP 3: WRITING ---
    const writingStep = 3;
    const writingMeta: Record<string, unknown> = { model: shortModelName(config.models.writing) };
    if (researchContext) {
      writingMeta.researchSummary = {
        briefCount: researchBriefCount,
        codexEntries: researchCodexCount,
        scenes: researchSceneCount,
      };
    }
    if (!await sendStatus(writer, 'writing', writingStep, totalSteps, undefined, writingMeta)) return;

    // Enrich original messages: append research preamble + context to last user message
    const enrichedMessages = [...config.messages];
    if (researchContext) {
      const lastUserIdx = enrichedMessages.map(m => m.role).lastIndexOf('user');
      if (lastUserIdx >= 0) {
        enrichedMessages[lastUserIdx] = {
          ...enrichedMessages[lastUserIdx],
          content: enrichedMessages[lastUserIdx].content +
            '\n\n---\n\n' + RESEARCH_CONTEXT_PREAMBLE + '\n' + researchContext,
        };
      }
    }

    // Inject cliché index into system message for draft step (benefits both balanced + thorough)
    if (clicheBlock) {
      const sysIdx = enrichedMessages.findIndex(m => m.role === 'system');
      if (sysIdx >= 0) {
        enrichedMessages[sysIdx] = {
          ...enrichedMessages[sysIdx],
          content: enrichedMessages[sysIdx].content + '\n' + clicheBlock,
        };
      }
    }

    const draftConfig = getDraftConfig(config.wordCount, config.temperature);
    let draftContent: string;
    let draftInputTokens = 0;
    let draftOutputTokens = 0;
    let draftFinishReason: string | null = null;

    if (config.preset === 'thorough') {
      // Thorough: collect draft internally (don't stream to client yet)
      const draftResult = await callModelCollect(
        config.models.writing,
        null,
        '',
        enrichedMessages,
        draftConfig,
        config.apiKey,
        config.openRouterPrefs,
      );
      draftContent = draftResult.content;
      draftInputTokens = draftResult.inputTokens;
      draftOutputTokens = draftResult.outputTokens;
      draftFinishReason = draftResult.finishReason;
    } else {
      // Balanced: stream draft directly to client
      const result = await streamToClient(
        writer,
        config.models.writing,
        null,
        '',
        enrichedMessages,
        draftConfig,
        config.apiKey,
        config.openRouterPrefs,
      );
      draftContent = result.content;
      draftInputTokens = result.inputTokens;
      draftOutputTokens = result.outputTokens;
      draftFinishReason = result.finishReason;
    }
    await trackUsageIfIncluded(config.models.writing, config.budget, draftInputTokens, draftOutputTokens);

    const draftTruncated = draftFinishReason === 'length';
    if (draftTruncated) {
      console.warn(`[AgenticWriter] Draft truncated: finish_reason=length, wordCount=${config.wordCount}, maxTokens=${draftConfig.maxTokens}, outputTokens=${draftOutputTokens}`);
    }

    // Hoist declarations needed by both critique and refine
    const systemMsg = config.messages.find(m => m.role === 'system');
    const userMessages = config.messages.filter(m => m.role === 'user');

    // In balanced mode, draft was already streamed — done
    if (config.preset !== 'thorough') {
      if (draftTruncated) {
        await sendWarning(writer, 'Output was truncated because it exceeded the token limit. Try reducing the word count or splitting into smaller beats.');
      }
      await sendDone(writer);
      return;
    }

    // --- STEP 4: REFINE (thorough only) ---
    if (!await sendStatus(writer, 'refining', 4, totalSteps, 'Analyzing draft...', { model: shortModelName(refinerModel) })) return;

    // Budget check before critique+refine
    if (!await checkBudgetBetweenSteps(config.budget)) {
      // Stream the draft as fallback since nothing has been streamed yet in thorough mode
      for (let i = 0; i < draftContent.length; i += 100) {
        const chunk = draftContent.substring(i, i + 100);
        if (!await sendContentChunk(writer, chunk)) return;
      }
      await sendDone(writer);
      return;
    }

    // Elapsed-time guard: skip critique if <60s remaining (free tier is 150s)
    const elapsedMs = Date.now() - pipelineStartTime;
    const skipCritique = elapsedMs > 90_000; // leave ≥60s for refine

    // Generate critique notes (non-streaming sub-step)
    let critiqueNotes = '';
    if (!skipCritique) {
      try {
        const critiqueUserContent = [
          `Original prompt:\n${userMessages.map(m => m.content).join('\n')}`,
          researchContext ? `\nResearch context:\n${researchContext}` : '',
          clicheBlock ? `\n${clicheBlock}` : '',
          `\nDraft to review:\n${draftContent}`,
        ].filter(Boolean).join('\n');

        const critiqueConfig = getCritiqueConfig();
        const critiqueResult = await callModel(
          refinerModel,
          CRITIQUE_SYSTEM_PROMPT,
          critiqueUserContent,
          critiqueConfig,
          config.apiKey,
          config.openRouterPrefs,
          45_000,
        );
        await trackUsageIfIncluded(refinerModel, config.budget, critiqueResult.inputTokens, critiqueResult.outputTokens);
        critiqueNotes = critiqueResult.content;
        console.log(`[AgenticWriter] Critique generated: ${critiqueNotes.length} chars`);
      } catch (err) {
        console.warn('[AgenticWriter] Critique failed, continuing without:', (err as Error).message);
      }
    } else {
      console.log(`[AgenticWriter] Skipping critique (elapsed ${elapsedMs}ms)`);
    }

    // Budget check after critique
    if (!await checkBudgetBetweenSteps(config.budget)) {
      for (let i = 0; i < draftContent.length; i += 100) {
        const chunk = draftContent.substring(i, i + 100);
        if (!await sendContentChunk(writer, chunk)) return;
      }
      await sendDone(writer);
      return;
    }

    // Sub-status update before refine streaming
    if (!await sendStatus(writer, 'refining', 4, totalSteps, 'Applying revisions...', { model: shortModelName(refinerModel) })) return;

    // Build refine messages with compact style context
    const COMPACT_STYLE_LIMIT = 2000;
    const styleForRefine = systemMsg?.content
      ? (systemMsg.content.length > COMPACT_STYLE_LIMIT
        ? systemMsg.content.substring(0, COMPACT_STYLE_LIMIT) + '...[truncated]'
        : systemMsg.content)
      : '';

    const refineSystemContent = [
      REFINE_SYSTEM_PROMPT,
      styleForRefine ? `\nAuthor's style instructions:\n${styleForRefine}` : '',
      researchContext ? `\nFact-check reference (do not contradict):\n${researchContext}` : '',
      clicheBlock,
    ].filter(Boolean).join('\n');

    const refineUserContent = [
      `Original draft:\n${draftContent}`,
      critiqueNotes ? `\nRevision notes:\n${critiqueNotes}` : '',
      `\nOriginal prompt:\n${userMessages.map(m => m.content).join('\n')}`,
    ].filter(Boolean).join('\n');

    const refineMessages = [
      { role: 'system', content: refineSystemContent },
      { role: 'user', content: refineUserContent },
    ];

    const refineConfig = getRefineConfig(draftContent.length, config.wordCount);
    let truncatedOutput = false;

    // Dynamic timeout: leave headroom before free-tier 150s limit
    const refineElapsedMs = Date.now() - pipelineStartTime;
    const refineTimeoutMs = Math.max(150_000 - refineElapsedMs - 5_000, 15_000);

    try {
      const refineStreamResult = await streamToClient(
        writer,
        refinerModel,
        null,
        '',
        refineMessages,
        refineConfig,
        config.apiKey,
        config.openRouterPrefs,
        refineTimeoutMs,
      );
      await trackUsageIfIncluded(refinerModel, config.budget, refineStreamResult.inputTokens, refineStreamResult.outputTokens);

      if (refineStreamResult.finishReason === 'length') {
        console.warn(`[AgenticWriter] Refine truncated: finish_reason=length, wordCount=${config.wordCount}, maxTokens=${refineConfig.maxTokens}, draftLength=${draftContent.length}, outputTokens=${refineStreamResult.outputTokens}`);
        truncatedOutput = true;
      } else if (draftTruncated) {
        // Draft was truncated but refine completed — output may be shorter than expected
        truncatedOutput = true;
      }
    } catch (err) {
      // Refine failed — stream unrefined draft as fallback
      console.warn('[AgenticWriter] Refine failed, streaming draft as fallback:', (err as Error).message);
      for (let i = 0; i < draftContent.length; i += 100) {
        const chunk = draftContent.substring(i, i + 100);
        if (!await sendContentChunk(writer, chunk)) return;
      }
      if (draftTruncated) truncatedOutput = true;
    }

    if (truncatedOutput) {
      await sendWarning(writer, 'Output may be incomplete — the draft exceeded the token limit. Try reducing the word count or splitting into smaller beats.');
    }
    await sendDone(writer);
  } catch (err) {
    console.error('[AgenticWriter] Pipeline error:', err);
    const message = isTimeoutError(err) ? 'AI provider timed out' : 'Pipeline error occurred';
    await sendError(writer, message);
  }
}

// --- Main handler ---

Deno.serve(async (request: Request) => {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin') || '';
  const headers = corsHeaders(origin);

  const preflight = handleCorsPreflightIfNeeded(request, headers);
  if (preflight) return preflight;

  // Rate limit: 10 req/min per user
  const rl = rateLimitResponse(request, headers, 10, 60_000, 'agentic-writer');
  if (rl) return rl;

  const path = url.pathname.replace(/^\/agentic-writer/, '') || '/';

  // --- /analyze-cliches endpoint ---
  if (path === '/analyze-cliches' && request.method === 'POST') {
    const analyzeRl = rateLimitResponse(request, headers, 5, 60_000, 'agentic-writer-analyze');
    if (analyzeRl) return analyzeRl;

    const auth = await extractAuthFromRequest(request, headers);
    if (auth instanceof Response) return auth;

    const userJwt = request.headers.get('Authorization')!.slice(7);

    let analyzeBody: { storyId?: string; model?: string; openRouterPrefs?: Record<string, unknown> };
    try {
      analyzeBody = await request.json();
    } catch {
      return jsonResponse<ErrorResponse>({ error: 'Invalid request body' }, 400, headers);
    }

    if (!analyzeBody?.storyId || typeof analyzeBody.storyId !== 'string') {
      return jsonResponse<ErrorResponse>({ error: 'storyId is required' }, 400, headers);
    }
    if (!analyzeBody?.model || typeof analyzeBody.model !== 'string') {
      return jsonResponse<ErrorResponse>({ error: 'model is required' }, 400, headers);
    }

    const [provider] = analyzeBody.model.split(':');
    if (provider !== 'included' && provider !== 'openrouter') {
      return jsonResponse<ErrorResponse>({ error: 'model must use included: or openrouter: prefix' }, 400, headers);
    }

    const apiKey = request.headers.get('X-API-Key') || null;
    if (provider === 'openrouter' && !apiKey) {
      return jsonResponse<ErrorResponse>({ error: 'X-API-Key header required for OpenRouter models' }, 400, headers);
    }

    // Budget check before analysis (prevents running LLM call if over budget)
    let budgetCtx: BudgetContext | null = null;
    if (provider === 'included') {
      const budgetResult = await setupBudgetContext(request, headers, {
        writing: analyzeBody.model,
        research: analyzeBody.model,
        refiner: analyzeBody.model,
      });
      if (budgetResult instanceof Response) return budgetResult;
      budgetCtx = budgetResult;
    }

    try {
      const userClient = getUserClient(userJwt);
      const userId = auth.userId || '';
      const result = await analyzeCliches(
        userClient,
        analyzeBody.storyId,
        userId,
        analyzeBody.model,
        apiKey,
        analyzeBody.openRouterPrefs,
      );

      // Track usage for included models
      if (budgetCtx) {
        await trackUsageIfIncluded(analyzeBody.model, budgetCtx, result.inputTokens, result.outputTokens);
      }

      return jsonResponse({ success: true, count: result.count, categories: result.categories }, 200, headers);
    } catch (err) {
      console.error('[AgenticWriter] Cliché analysis error:', err);
      const message = err instanceof Error ? err.message : 'Analysis failed';
      return jsonResponse<ErrorResponse>({ error: message }, 500, headers);
    }
  }

  // --- /generate endpoint ---
  if (path !== '/generate' || request.method !== 'POST') {
    return jsonResponse<ErrorResponse>({ error: 'Not found' }, 404, headers);
  }

  // Auth
  const auth = await extractAuthFromRequest(request, headers);
  if (auth instanceof Response) return auth;

  // Extract JWT for user-scoped client
  const userJwt = request.headers.get('Authorization')!.slice(7);

  // Parse body
  let body: {
    messages?: Array<{ role: string; content: string | null }>;
    storyId?: string;
    sceneId?: string;
    wordCount?: number;
    preset?: 'balanced' | 'thorough';
    models?: {
      writing: string;
      research?: string;
      refiner?: string;
      // Backward compat: old client sends 'thinking' instead of 'refiner'
      thinking?: string;
    };
    temperature?: number;
    openRouterPrefs?: Record<string, unknown>;
  };
  try {
    body = await request.json();
  } catch {
    return jsonResponse<ErrorResponse>({ error: 'Invalid request body' }, 400, headers);
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse<ErrorResponse>({ error: 'Request body must be a JSON object' }, 400, headers);
  }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonResponse<ErrorResponse>({ error: 'messages array is required' }, 400, headers);
  }
  if (body.messages.length > 200) {
    return jsonResponse<ErrorResponse>({ error: 'messages array exceeds maximum of 200 items' }, 400, headers);
  }
  for (const msg of body.messages) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return jsonResponse<ErrorResponse>({ error: 'Each message must be an object' }, 400, headers);
    }
    if (typeof msg.role !== 'string') {
      return jsonResponse<ErrorResponse>({ error: 'Each message must have a string role' }, 400, headers);
    }
    if (msg.content !== null && msg.content !== undefined && typeof msg.content !== 'string') {
      return jsonResponse<ErrorResponse>({ error: 'Message content must be a string or null' }, 400, headers);
    }
  }

  if (!body.models?.writing) {
    return jsonResponse<ErrorResponse>({ error: 'models.writing is required' }, 400, headers);
  }
  if (typeof body.models.writing !== 'string' || body.models.writing.length > 200) {
    return jsonResponse<ErrorResponse>({ error: 'models.writing must be a string of at most 200 characters' }, 400, headers);
  }
  // Validate optional model fields
  for (const field of ['research', 'refiner', 'thinking'] as const) {
    if (body.models[field] !== undefined) {
      if (typeof body.models[field] !== 'string' || (body.models[field] as string).length > 200) {
        return jsonResponse<ErrorResponse>({ error: `models.${field} must be a string of at most 200 characters` }, 400, headers);
      }
    }
  }

  if (body.wordCount !== undefined) {
    if (typeof body.wordCount !== 'number' || !Number.isFinite(body.wordCount)) {
      return jsonResponse<ErrorResponse>({ error: 'wordCount must be a finite number' }, 400, headers);
    }
    if (body.wordCount <= 0) {
      return jsonResponse<ErrorResponse>({ error: 'wordCount must be positive' }, 400, headers);
    }
  }

  if (body.temperature !== undefined) {
    if (typeof body.temperature !== 'number' || !Number.isFinite(body.temperature)) {
      return jsonResponse<ErrorResponse>({ error: 'temperature must be a finite number' }, 400, headers);
    }
    if (body.temperature < 0 || body.temperature > 2) {
      return jsonResponse<ErrorResponse>({ error: 'temperature must be between 0 and 2' }, 400, headers);
    }
  }

  if (body.storyId !== undefined) {
    if (typeof body.storyId !== 'string' || body.storyId.length > 100) {
      return jsonResponse<ErrorResponse>({ error: 'storyId must be a string of at most 100 characters' }, 400, headers);
    }
  }

  if (body.sceneId !== undefined) {
    if (typeof body.sceneId !== 'string' || body.sceneId.length > 100) {
      return jsonResponse<ErrorResponse>({ error: 'sceneId must be a string of at most 100 characters' }, 400, headers);
    }
  }

  if (body.openRouterPrefs !== undefined) {
    if (!body.openRouterPrefs || typeof body.openRouterPrefs !== 'object' || Array.isArray(body.openRouterPrefs)) {
      return jsonResponse<ErrorResponse>({ error: 'openRouterPrefs must be a plain object' }, 400, headers);
    }
  }

  // Resolve model slots with backward compat: 'thinking' → 'refiner'
  const refinerSlot = body.models.refiner || body.models.thinking || body.models.writing;
  const models = {
    writing: body.models.writing,
    research: body.models.research || body.models.writing,
    refiner: refinerSlot,
  };

  // API key from header (for OpenRouter models)
  const apiKey = request.headers.get('X-API-Key') || null;
  const usesOpenRouter = [models.writing, models.research, models.refiner]
    .some(m => m.startsWith('openrouter:'));
  if (usesOpenRouter && !apiKey) {
    return jsonResponse<ErrorResponse>({ error: 'X-API-Key header required for OpenRouter models' }, 400, headers);
  }

  // Budget setup for included models
  const budgetResult = await setupBudgetContext(request, headers, models);
  if (budgetResult instanceof Response) return budgetResult;

  // Create streaming response
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  // Run pipeline async
  const pipelineConfig: PipelineConfig = {
    messages: body.messages.map(m => ({ role: m.role, content: m.content ?? '' })),
    storyId: body.storyId || '',
    sceneId: body.sceneId,
    wordCount: body.wordCount || 400,
    preset: body.preset === 'thorough' ? 'thorough' : 'balanced',
    models,
    temperature: body.temperature,
    apiKey,
    userJwt,
    openRouterPrefs: body.openRouterPrefs,
    budget: budgetResult,
  };

  // Don't await — runs in background, writes to stream
  runPipeline(writer, pipelineConfig).catch(async (err) => {
    console.error('[AgenticWriter] Unhandled pipeline error:', err);
    try {
      await sendError(writer, 'Internal pipeline error');
    } catch { /* stream already closed */ }
  });

  return new Response(stream.readable, {
    status: 200,
    headers: {
      ...headers,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});
