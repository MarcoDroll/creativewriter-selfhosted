import { corsHeaders, handleCorsPreflightIfNeeded, jsonResponse } from '../_shared/cors.ts';
import { extractAuthFromRequest } from '../_shared/auth.ts';
import { rateLimitResponse } from '../_shared/rate-limit.ts';
import { fetchWithTimeout, isTimeoutError } from '../_shared/timeout.ts';
import { validateJwtAndGetSubscription, requireEnv } from '../_shared/stripe-helpers.ts';
import { getAdminClient } from '../_shared/supabase-admin.ts';
import { getUserClient } from '../_shared/supabase-user.ts';
import type { ErrorResponse } from '../_shared/types.ts';
import {
  ANALYZE_SYSTEM_PROMPT,
  PLAN_SYSTEM_PROMPT,
  REVIEW_SYSTEM_PROMPT,
  REFINE_SYSTEM_PROMPT,
  getAnalyzeConfig,
  getPlanConfig,
  getReviewConfig,
  getDraftConfig,
  getRefineConfig,
} from './pipeline-prompts.ts';
import { parseAnalysisOutput, runResearch } from './research.ts';

console.log('[AgenticWriter] Module loaded');

// --- DeepSeek pricing (same as premium/index.ts) ---
const DEEPSEEK_PRICING = {
  inputPerMillionTokens: 0.28,
  outputPerMillionTokens: 0.42,
  monthlyBudgetUsd: 5.00,
};

function getCycleMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString().split('T')[0];
}

async function getMonthlyUsage(customerId: string, cycleMonth: string): Promise<number> {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from('ai_usage')
    .select('total_cost_usd')
    .eq('stripe_customer_id', customerId)
    .eq('cycle_month', cycleMonth)
    .maybeSingle();
  if (error) {
    console.error('[AgenticWriter] DB error reading monthly usage:', error.message);
    return 0;
  }
  return data ? parseFloat(data.total_cost_usd) || 0 : 0;
}

async function logUsage(customerId: string, cycleMonth: string, inputTokens: number, outputTokens: number): Promise<void> {
  const supabase = getAdminClient();
  const cost = (inputTokens / 1_000_000) * DEEPSEEK_PRICING.inputPerMillionTokens
             + (outputTokens / 1_000_000) * DEEPSEEK_PRICING.outputPerMillionTokens;
  const { error } = await supabase.rpc('increment_ai_usage', {
    p_customer_id: customerId,
    p_cycle_month: cycleMonth,
    p_cost: cost,
  });
  if (error) {
    console.error('[AgenticWriter] Failed to log AI usage:', error.message);
  }
}

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
  detail?: string
): Promise<boolean> {
  const payload: Record<string, unknown> = { status, step, totalSteps };
  if (detail) payload.detail = detail;
  return sendSSE(writer, JSON.stringify(payload));
}

async function sendContentChunk(writer: WritableStreamDefaultWriter, content: string): Promise<boolean> {
  return sendSSE(writer, JSON.stringify({
    choices: [{ delta: { content }, finish_reason: null }],
  }));
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

function parseModelSlot(slot: string): ModelConfig {
  const [provider, ...rest] = slot.split(':');
  return { provider, modelId: rest.join(':') };
}

interface CallModelResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Call a model (non-streaming). Used for analyze, plan, review steps.
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
    headers['HTTP-Referer'] = 'https://creativewriter.app';
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
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };

  return {
    content: data.choices?.[0]?.message?.content || '',
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
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
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
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
    headers['HTTP-Referer'] = 'https://creativewriter.app';
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
        const delta = parsed.choices?.[0]?.delta;
        if (delta?.content) {
          accumulatedContent += delta.content;
          const ok = await sendContentChunk(writer, delta.content);
          if (!ok) {
            // Client disconnected, cancel upstream
            try { await reader.cancel(); } catch { /* ignore */ }
            return { content: accumulatedContent, inputTokens, outputTokens };
          }
        }
      } catch { /* ignore parse errors */ }
    }
  }

  return { content: accumulatedContent, inputTokens, outputTokens };
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
    headers['HTTP-Referer'] = 'https://creativewriter.app';
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
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };

  return {
    content: data.choices?.[0]?.message?.content || '',
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
  };
}

// --- Budget tracking for included models ---

interface BudgetContext {
  customerId: string | null;
  cycleMonth: string;
  usesIncluded: boolean;
}

async function setupBudgetContext(
  request: Request,
  headers: Record<string, string>,
  models: { thinking: string; research: string; writing: string }
): Promise<BudgetContext | Response> {
  const usesIncluded = [models.thinking, models.research, models.writing]
    .some(m => m.startsWith('included:'));

  if (!usesIncluded) {
    return { customerId: null, cycleMonth: getCycleMonth(), usesIncluded: false };
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
    return { customerId: null, cycleMonth: getCycleMonth(), usesIncluded: true };
  }

  // Hosted: validate subscription and check budget
  const validation = await validateJwtAndGetSubscription(request, headers);
  if (validation instanceof Response) return validation;
  if (!validation.valid || validation.tier !== 'premium') {
    return jsonResponse<ErrorResponse>(
      { error: 'Premium subscription required for included AI models' },
      403,
      headers
    );
  }

  const customerId = validation.customerId!;
  const cycleMonth = getCycleMonth();
  const totalCostUsd = await getMonthlyUsage(customerId, cycleMonth);
  if (totalCostUsd >= DEEPSEEK_PRICING.monthlyBudgetUsd) {
    return jsonResponse<ErrorResponse>(
      { error: 'Monthly AI budget exceeded' },
      429,
      headers
    );
  }

  return { customerId, cycleMonth, usesIncluded: true };
}

async function trackUsageIfIncluded(
  modelSlot: string,
  budget: BudgetContext,
  inputTokens: number,
  outputTokens: number
): Promise<void> {
  if (!budget.usesIncluded || !budget.customerId) return;
  if (!modelSlot.startsWith('included:')) return;
  await logUsage(budget.customerId, budget.cycleMonth, inputTokens, outputTokens);
}

async function checkBudgetBetweenSteps(budget: BudgetContext): Promise<boolean> {
  if (!budget.usesIncluded || !budget.customerId) return true;
  const totalCostUsd = await getMonthlyUsage(budget.customerId, budget.cycleMonth);
  return totalCostUsd < DEEPSEEK_PRICING.monthlyBudgetUsd;
}

// --- Pipeline ---

interface PipelineConfig {
  messages: Array<{ role: string; content: string }>;
  storyId: string;
  wordCount: number;
  preset: 'balanced' | 'thorough';
  models: { thinking: string; research: string; writing: string };
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
  const steps = config.preset === 'thorough'
    ? ['analyze', 'research', 'plan', 'draft', 'review', 'refine']
    : ['analyze', 'research', 'draft'];
  const totalSteps = steps.length;

  const researchModel = config.models.research || config.models.thinking;

  try {
    // --- STEP 1: ANALYZE ---
    let stepIndex = 1;
    if (!await sendStatus(writer, 'analyzing', stepIndex, totalSteps)) return;

    // Build analysis input from the user's messages
    const userMessages = config.messages.filter(m => m.role === 'user');
    const systemMessages = config.messages.filter(m => m.role === 'system');
    const analysisInput = [
      ...(systemMessages.length > 0 ? [`Story context:\n${systemMessages[0].content.substring(0, 2000)}`] : []),
      `Beat generation request:\n${userMessages.map(m => m.content).join('\n')}`,
    ].join('\n\n');

    const analyzeResult = await callModel(
      researchModel,
      ANALYZE_SYSTEM_PROMPT,
      analysisInput,
      getAnalyzeConfig(),
      config.apiKey,
      config.openRouterPrefs,
    );
    await trackUsageIfIncluded(researchModel, config.budget, analyzeResult.inputTokens, analyzeResult.outputTokens);

    const analysis = parseAnalysisOutput(analyzeResult.content);

    // --- STEP 2: RESEARCH ---
    stepIndex = 2;
    const researchDetail = analysis.entities.length > 0
      ? `Looking up ${analysis.entities.length} codex ${analysis.entities.length === 1 ? 'entry' : 'entries'}`
      : 'Checking story context';
    if (!await sendStatus(writer, 'researching', stepIndex, totalSteps, researchDetail)) return;

    let researchContext = '';
    if (config.storyId && (analysis.entities.length > 0 || analysis.scenes.length > 0)) {
      const userClient = getUserClient(config.userJwt);
      researchContext = await runResearch(analysis, config.storyId, userClient);
    }

    // Budget check between steps
    if (!await checkBudgetBetweenSteps(config.budget)) {
      await sendError(writer, 'Monthly AI budget exceeded during pipeline');
      return;
    }

    // --- STEP 3: PLAN (thorough only) ---
    let plan = '';
    if (config.preset === 'thorough') {
      stepIndex = 3;
      if (!await sendStatus(writer, 'planning', stepIndex, totalSteps)) return;

      const planInput = [
        `Original prompt:\n${userMessages.map(m => m.content).join('\n')}`,
        researchContext ? `\n${researchContext}` : '',
        analysis.focus.length > 0 ? `\nNarrative focus:\n${analysis.focus.map(f => `- ${f}`).join('\n')}` : '',
      ].join('\n');

      const planResult = await callModel(
        config.models.thinking,
        PLAN_SYSTEM_PROMPT,
        planInput,
        getPlanConfig(),
        config.apiKey,
        config.openRouterPrefs,
      );
      await trackUsageIfIncluded(config.models.thinking, config.budget, planResult.inputTokens, planResult.outputTokens);
      plan = planResult.content;

      if (!await checkBudgetBetweenSteps(config.budget)) {
        await sendError(writer, 'Monthly AI budget exceeded during pipeline');
        return;
      }
    }

    // --- STEP N: DRAFT ---
    const draftStepIndex = config.preset === 'thorough' ? 4 : 3;
    if (!await sendStatus(writer, 'drafting', draftStepIndex, totalSteps)) return;

    // Enrich the original messages with research context and plan
    const enrichedMessages = [...config.messages];
    if (researchContext || plan) {
      // Find the last user message and append context
      const lastUserIdx = enrichedMessages.map(m => m.role).lastIndexOf('user');
      if (lastUserIdx >= 0) {
        let supplement = '';
        if (researchContext) supplement += `\n\n${researchContext}`;
        if (plan) supplement += `\n\n<beat-plan>\n${plan}\n</beat-plan>`;
        enrichedMessages[lastUserIdx] = {
          ...enrichedMessages[lastUserIdx],
          content: enrichedMessages[lastUserIdx].content + supplement,
        };
      }
    }

    const draftConfig = getDraftConfig(config.wordCount, config.temperature);
    let draftContent: string;
    let draftInputTokens = 0;
    let draftOutputTokens = 0;

    if (config.preset === 'thorough') {
      // Thorough: collect draft internally (don't stream to client)
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
    }
    await trackUsageIfIncluded(config.models.writing, config.budget, draftInputTokens, draftOutputTokens);

    // --- REVIEW (thorough only) ---
    // In balanced mode, draft was already streamed — skip review to save tokens
    if (config.preset !== 'thorough') {
      await sendDone(writer);
      return;
    }

    if (!await sendStatus(writer, 'reviewing', 5, totalSteps)) return;

    if (!await checkBudgetBetweenSteps(config.budget)) {
      // Stream the draft as fallback since nothing has been streamed yet in thorough mode
      for (let i = 0; i < draftContent.length; i += 100) {
        const chunk = draftContent.substring(i, i + 100);
        if (!await sendContentChunk(writer, chunk)) return;
      }
      await sendDone(writer);
      return;
    }

    const reviewInput = [
      `Original prompt:\n${userMessages.map(m => m.content).join('\n')}`,
      researchContext ? `\n${researchContext}` : '',
      `\nDraft:\n${draftContent}`,
    ].join('\n');

    let reviewResult: CallModelResult;
    try {
      reviewResult = await callModel(
        config.models.thinking,
        REVIEW_SYSTEM_PROMPT,
        reviewInput,
        getReviewConfig(),
        config.apiKey,
        config.openRouterPrefs,
      );
      await trackUsageIfIncluded(config.models.thinking, config.budget, reviewResult.inputTokens, reviewResult.outputTokens);
    } catch (err) {
      console.error('[AgenticWriter] Review step failed:', err);
      // Stream the draft as fallback
      for (let i = 0; i < draftContent.length; i += 100) {
        const chunk = draftContent.substring(i, i + 100);
        if (!await sendContentChunk(writer, chunk)) return;
      }
      await sendDone(writer);
      return;
    }

    // --- STEP N+2: REFINE (thorough only) ---
    if (config.preset === 'thorough') {
      const needsRefinement = reviewResult.content.includes('needs_refinement');

      if (needsRefinement) {
        if (!await sendStatus(writer, 'refining', 6, totalSteps)) return;

        if (!await checkBudgetBetweenSteps(config.budget)) {
          // Stream the draft as fallback
          for (let i = 0; i < draftContent.length; i += 100) {
            const chunk = draftContent.substring(i, i + 100);
            if (!await sendContentChunk(writer, chunk)) return;
          }
          await sendDone(writer);
          return;
        }

        const refineInput = [
          `Original draft:\n${draftContent}`,
          `\nReview notes:\n${reviewResult.content}`,
          `\nOriginal prompt:\n${userMessages.map(m => m.content).join('\n')}`,
        ].join('\n');

        const refineConfig = getRefineConfig(draftContent.length);
        const refineStreamResult = await streamToClient(
          writer,
          config.models.writing,
          REFINE_SYSTEM_PROMPT,
          refineInput,
          null,
          refineConfig,
          config.apiKey,
          config.openRouterPrefs,
        );
        await trackUsageIfIncluded(config.models.writing, config.budget, refineStreamResult.inputTokens, refineStreamResult.outputTokens);
      } else {
        // Review says acceptable, stream the draft directly
        for (let i = 0; i < draftContent.length; i += 100) {
          const chunk = draftContent.substring(i, i + 100);
          if (!await sendContentChunk(writer, chunk)) return;
        }
      }
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
    wordCount?: number;
    preset?: 'balanced' | 'thorough';
    models?: { thinking: string; research: string; writing: string };
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
  if (body.models.thinking !== undefined) {
    if (typeof body.models.thinking !== 'string' || body.models.thinking.length > 200) {
      return jsonResponse<ErrorResponse>({ error: 'models.thinking must be a string of at most 200 characters' }, 400, headers);
    }
  }
  if (body.models.research !== undefined) {
    if (typeof body.models.research !== 'string' || body.models.research.length > 200) {
      return jsonResponse<ErrorResponse>({ error: 'models.research must be a string of at most 200 characters' }, 400, headers);
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

  if (body.openRouterPrefs !== undefined) {
    if (!body.openRouterPrefs || typeof body.openRouterPrefs !== 'object' || Array.isArray(body.openRouterPrefs)) {
      return jsonResponse<ErrorResponse>({ error: 'openRouterPrefs must be a plain object' }, 400, headers);
    }
  }

  const models = {
    thinking: body.models.thinking || body.models.writing,
    research: body.models.research || body.models.thinking || body.models.writing,
    writing: body.models.writing,
  };

  // API key from header (for OpenRouter models)
  const apiKey = request.headers.get('X-API-Key') || null;
  const usesOpenRouter = [models.thinking, models.research, models.writing]
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
    messages: body.messages,
    storyId: body.storyId || '',
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
