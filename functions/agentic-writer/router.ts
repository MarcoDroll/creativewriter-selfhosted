import { corsHeaders, handleCorsPreflightIfNeeded, jsonResponse } from '../_shared/cors.ts';
import { extractAuthFromRequest } from '../_shared/auth.ts';
import { rateLimitResponse } from '../_shared/rate-limit.ts';
import { isTimeoutError } from '../_shared/timeout.ts';
import { validateJwtAndGetSubscription, getOrCreateCustomer, getStripe } from '../_shared/stripe-helpers.ts';
import { getUserClient } from '../_shared/supabase-user.ts';
import { getCycleMonth, getMonthlyUsage, logUsage, getMonthlyBudget, resolveIncludedAiTier } from '../_shared/ai-usage.ts';
import type { ErrorResponse } from '../_shared/types.ts';
import { UpstreamError, upstreamErrorResponse } from '../_shared/api-errors.ts';
import {
  REFINE_SYSTEM_PROMPT,
  RESEARCH_CONTEXT_PREAMBLE,
  ANALYZER_SYSTEM_PROMPT,
  analyzerReportsClean,
  getAnalyzerConfig,
  getPlanningConfig,
  getDraftConfig,
  getRefineConfig,
} from './pipeline-prompts.ts';
import { PLANNING_SYSTEM_PROMPT, parsePlanningOutput } from './planner.ts';
import { fetchResearchData, fetchStoryOutline } from './research.ts';
import { runResearchAgents, consolidateResearchBriefs } from './research-agent.ts';
import { analyzeCliches, fetchStoryClicheIndex, formatClicheIndexForPrompt } from './cliche-analyzer.ts';
import { fetchStoryCodexStates, formatCodexStateForPrompt } from './codex-state.ts';
import {
  sendContentChunk,
  sendWarning,
  sendDone,
  sendError,
  sendSummary,
  startHeartbeat,
} from '../_shared/sse-helpers.ts';
import {
  callModel,
  streamToClient,
  shortModelName,
  slotProvider,
  checkSlotProviders,
  resolveUpstream,
  ModelProviderConfigError,
} from '../_shared/model-calling.ts';
import { setupPhaseWatchdog, WATCHDOG_CODE, SLOW_STEP_CODE } from '../_shared/phase-watchdog.ts';
import type {
  PlanRequestBody,
  PlanResponseBody,
  ResearchRequestBody,
  ResearchResponseBody,
  DraftRequestBody,
  DraftSummary,
  AnalyzeRequestBody,
  AnalyzeResponseBody,
  RefineRequestBody,
  RefineSummary,
  AgenticModels,
} from '../_shared/agentic-writer-types.ts';

console.log('[AgenticWriter] Module loaded');

// --- Per-LLM-call timeouts (sub-150s guards against runaway model calls) ---

const TIMEOUT_PLANNING_MS = 25_000;
const TIMEOUT_DRAFT_BALANCED_MS = 90_000;
const TIMEOUT_DRAFT_THOROUGH_MS = 90_000;
const TIMEOUT_ANALYZER_MS = 25_000;
const TIMEOUT_REFINE_MS = 130_000;

/**
 * Relay a phase failure on an already-open SSE stream, carrying its code when it has one.
 *
 * The SSE twin of the JSON catches below, and it keeps the same order for the same
 * reasons: a config error is operator guidance and stays uncoded, a timeout is a raw
 * `DOMException` that no classifier ever wrapped, and only then can the error be an
 * `UpstreamError`. `fallback` is what an unclassified failure says — the old code said
 * only that, for everything.
 */
async function sendClassifiedError(
  writer: WritableStreamDefaultWriter,
  err: unknown,
  fallback: string,
): Promise<void> {
  if (err instanceof ModelProviderConfigError) {
    await sendError(writer, err.message);
  } else if (isTimeoutError(err)) {
    await sendError(writer, 'AI provider timed out', 'provider-timeout');
  } else if (err instanceof UpstreamError) {
    await sendError(writer, err.message, err.code);
  } else {
    await sendError(writer, fallback);
  }
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
  models: { writing: string; research: string; refiner: string; analyzer: string }
): Promise<BudgetContext | Response> {
  const usesIncluded = [models.writing, models.research, models.refiner, models.analyzer]
    .some(m => slotProvider(m) === 'included');

  if (!usesIncluded) {
    return { customerId: null, cycleMonth: getCycleMonth(), usesIncluded: false, budgetUsd: 0 };
  }

  // Included AI is hosted-only. Self-hosted floors the subscription tier to 'basic',
  // but the included transport is disabled there — so mirror premium/ai/chat, which
  // returns 403 for included models on self-hosted. The frontend already never lists
  // included models on self-hosted (ModelService + AIProviderValidationService guards);
  // this is defense-in-depth against a stale persisted `included:` slot reaching here.
  if (Deno.env.get('SELF_HOSTED') === 'true') {
    return jsonResponse<ErrorResponse>(
      { error: 'Included AI is not available on self-hosted instances' },
      403,
      headers
    );
  }

  if (!Deno.env.get('DEEPSEEK_API_KEY')) {
    return jsonResponse<ErrorResponse>(
      { error: 'Included AI models require DEEPSEEK_API_KEY to be configured' },
      400,
      headers
    );
  }

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
  if (slotProvider(modelSlot) !== 'included') return;
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
    return true;
  }
}

// --- Body validation helpers ---

interface ParsedPhaseHeader {
  apiKey: string | null;
  pipelineRequestId: string;
  models: AgenticModels;
}

function isValidModelSlot(slot: unknown): slot is string {
  return typeof slot === 'string' && slot.length > 0 && slot.length <= 200 && slot.includes(':');
}

function validateCommonBody(
  body: Record<string, unknown> | null | undefined,
  headers: Record<string, string>,
): ParsedPhaseHeader | Response {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse<ErrorResponse>({ error: 'Request body must be a JSON object' }, 400, headers);
  }

  const pipelineRequestId = body['pipelineRequestId'];
  if (typeof pipelineRequestId !== 'string' || pipelineRequestId.length === 0 || pipelineRequestId.length > 100) {
    return jsonResponse<ErrorResponse>({ error: 'pipelineRequestId must be a non-empty string of at most 100 characters' }, 400, headers);
  }

  const models = body['models'] as Record<string, unknown> | undefined;
  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    return jsonResponse<ErrorResponse>({ error: 'models is required' }, 400, headers);
  }
  if (!isValidModelSlot(models['writing'])) {
    return jsonResponse<ErrorResponse>({ error: 'models.writing must be a non-empty <provider>:<id> string' }, 400, headers);
  }
  for (const field of ['research', 'refiner', 'analyzer'] as const) {
    if (models[field] !== undefined && !isValidModelSlot(models[field])) {
      return jsonResponse<ErrorResponse>({ error: `models.${field} must be a non-empty <provider>:<id> string` }, 400, headers);
    }
  }
  const resolved: AgenticModels = {
    writing: models['writing'] as string,
    research: (models['research'] as string) || (models['writing'] as string),
    refiner: (models['refiner'] as string) || (models['writing'] as string),
    analyzer: (models['analyzer'] as string) || (models['refiner'] as string) || (models['writing'] as string),
  };

  // Policy gate. Iterating `resolved` (not `models`) is what covers the defaulted
  // research/refiner/analyzer slots. `isValidModelSlot` above stays shape-only —
  // shape and policy are different concerns.
  const providerError = checkSlotProviders(resolved as unknown as Record<string, string>);
  if (providerError) {
    return jsonResponse<ErrorResponse>({ error: providerError }, 400, headers);
  }

  // Resolve every slot eagerly and discard the result, purely so a config error
  // ("unset OLLAMA_BASE_URL") becomes a 400 here rather than dying in a container
  // log. Two of the four call sites sit behind a catch whose whole job is to keep a
  // run going — `runResearchAgents` degrades to fewer briefs, `handleRefine`'s inner
  // catch streams the draft — and a missing env var is not something either should
  // absorb. Both single it out and rethrow, but only this loop can answer it with a
  // real 400: it is pure, cheap, and runs before any SSE response is opened, which is
  // what makes a 400 structurally possible on /draft and /refine at all.
  try {
    for (const slot of Object.values(resolved)) {
      resolveUpstream(slot, { apiKey: null });
    }
  } catch (err) {
    if (err instanceof ModelProviderConfigError) {
      return jsonResponse<ErrorResponse>({ error: err.message }, 400, headers);
    }
    throw err;
  }

  if (body['storyId'] !== undefined) {
    const sid = body['storyId'];
    if (typeof sid !== 'string' || sid.length === 0 || sid.length > 100) {
      return jsonResponse<ErrorResponse>({ error: 'storyId must be a non-empty string of at most 100 characters' }, 400, headers);
    }
  }
  if (body['sceneId'] !== undefined && (typeof body['sceneId'] !== 'string' || (body['sceneId'] as string).length > 100)) {
    return jsonResponse<ErrorResponse>({ error: 'sceneId must be a string of at most 100 characters' }, 400, headers);
  }
  if (body['preset'] !== undefined && body['preset'] !== 'balanced' && body['preset'] !== 'thorough') {
    return jsonResponse<ErrorResponse>({ error: 'preset must be balanced or thorough' }, 400, headers);
  }
  if (body['wordCount'] !== undefined) {
    const wc = body['wordCount'];
    if (typeof wc !== 'number' || !Number.isFinite(wc) || wc <= 0) {
      return jsonResponse<ErrorResponse>({ error: 'wordCount must be a positive finite number' }, 400, headers);
    }
  }
  if (body['openRouterPrefs'] !== undefined) {
    const prefs = body['openRouterPrefs'];
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
      return jsonResponse<ErrorResponse>({ error: 'openRouterPrefs must be a plain object' }, 400, headers);
    }
  }

  return {
    apiKey: null, // resolved separately by caller
    pipelineRequestId,
    models: resolved,
  };
}

function validateMessages(
  messages: unknown,
  headers: Record<string, string>,
): Array<{ role: string; content: string }> | Response {
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonResponse<ErrorResponse>({ error: 'messages array is required' }, 400, headers);
  }
  if (messages.length > 200) {
    return jsonResponse<ErrorResponse>({ error: 'messages array exceeds maximum of 200 items' }, 400, headers);
  }
  const out: Array<{ role: string; content: string }> = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return jsonResponse<ErrorResponse>({ error: 'Each message must be an object' }, 400, headers);
    }
    const m = msg as { role?: unknown; content?: unknown };
    if (typeof m.role !== 'string') {
      return jsonResponse<ErrorResponse>({ error: 'Each message must have a string role' }, 400, headers);
    }
    if (m.content !== null && m.content !== undefined && typeof m.content !== 'string') {
      return jsonResponse<ErrorResponse>({ error: 'Message content must be a string or null' }, 400, headers);
    }
    out.push({ role: m.role, content: (m.content as string | null | undefined) ?? '' });
  }
  return out;
}

interface ApiAuthContext {
  userJwt: string;
  apiKey: string | null;
}

function checkApiKeyForOpenRouter(
  request: Request,
  models: AgenticModels,
  headers: Record<string, string>,
): ApiAuthContext | Response {
  const userJwt = request.headers.get('Authorization')!.slice(7);
  const apiKey = request.headers.get('X-API-Key') || null;
  const usesOpenRouter = [models.writing, models.research, models.refiner, models.analyzer]
    .some(m => slotProvider(m) === 'openrouter');
  if (usesOpenRouter && !apiKey) {
    return jsonResponse<ErrorResponse>({ error: 'X-API-Key header required for OpenRouter models' }, 400, headers);
  }
  return { userJwt, apiKey };
}

// --- Phase handlers ---
//
// **Exported for tests, and for nothing else — go through `handleRequest`.** Each one
// assumes work that only the router does: `validateCommonBody` has resolved all four
// `body.models` slots (an absent `research`/`refiner`/`analyzer` reaches
// `parseModelSlot` as `undefined.split(':')` — an uncaught TypeError the browser sees as
// a bare CORS failure, which is the bug the comment at the bottom of this file
// describes), `checkSlotProviders` has run the provider policy, and
// `extractAuthFromRequest` has actually verified the JWT — `checkApiKeyForOpenRouter`
// only slices the header, and its `!` is safe solely because of that.
//
// Calling one directly from another edge function would skip all three. If a second
// caller is ever genuinely wanted, give it the router's front half, not these.

export async function handlePlan(
  request: Request,
  body: PlanRequestBody,
  headers: Record<string, string>,
): Promise<Response> {
  const authCtx = checkApiKeyForOpenRouter(request, body.models, headers);
  if (authCtx instanceof Response) return authCtx;

  const messages = validateMessages(body.messages, headers);
  if (messages instanceof Response) return messages;

  const budgetResult = await setupBudgetContext(request, headers, body.models);
  if (budgetResult instanceof Response) return budgetResult;

  const phaseStart = Date.now();
  const wd = setupPhaseWatchdog(null, phaseStart);
  try {
    const planningInput = messages.map(m => `[${m.role}]\n${m.content}`).join('\n\n');
    const planningConfig = getPlanningConfig();

    const result = await callModel(
      body.models.writing,
      PLANNING_SYSTEM_PROMPT,
      planningInput,
      planningConfig,
      authCtx.apiKey,
      body.openRouterPrefs,
      TIMEOUT_PLANNING_MS,
      wd.signal,
    );
    await trackUsageIfIncluded(body.models.writing, budgetResult, result.inputTokens, result.outputTokens);

    const response: PlanResponseBody = {
      plan: result.content,
      model: shortModelName(body.models.writing),
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
    return jsonResponse(response, 200, headers);
  } catch (err) {
    if (wd.fired) {
      // SLOW_STEP_CODE, not WATCHDOG_CODE: this phase reads neither wordCount nor
      // preset, so "try a smaller word count or the balanced preset" is advice about
      // a different phase. See phase-watchdog.ts.
      return jsonResponse<ErrorResponse>(
        { error: 'Planning exceeded time budget', code: SLOW_STEP_CODE }, 504, headers,
      );
    }
    // Config errors are operator-authored guidance, and a 400 says "fix your
    // config", not "the server broke". validateCommonBody resolves every slot up
    // front, so this is a backstop.
    if (err instanceof ModelProviderConfigError) {
      return jsonResponse<ErrorResponse>({ error: err.message }, 400, headers);
    }
    console.error('[AgenticWriter] /plan error:', err);
    // Timeout stays ABOVE the UpstreamError arm in every catch here: `fetchWithTimeout`
    // aborts with a raw `DOMException` that nothing wraps, so it is never an
    // UpstreamError — and it is a 504, which the old code answered as a 500.
    if (isTimeoutError(err)) {
      return jsonResponse<ErrorResponse>({ error: 'AI provider timed out', code: 'provider-timeout' }, 504, headers);
    }
    if (err instanceof UpstreamError) return upstreamErrorResponse(err, headers);
    return jsonResponse<ErrorResponse>({ error: 'Planning error' }, 500, headers);
  } finally {
    wd.dispose();
  }
}

export async function handleResearch(
  request: Request,
  body: ResearchRequestBody,
  headers: Record<string, string>,
): Promise<Response> {
  const authCtx = checkApiKeyForOpenRouter(request, body.models, headers);
  if (authCtx instanceof Response) return authCtx;

  if (typeof body.plan !== 'string') {
    return jsonResponse<ErrorResponse>({ error: 'plan must be a string' }, 400, headers);
  }
  if (typeof body.storyId !== 'string' || body.storyId.length === 0) {
    return jsonResponse<ErrorResponse>({ error: 'storyId is required for /research' }, 400, headers);
  }
  if (body.useCodexState !== undefined && typeof body.useCodexState !== 'boolean') {
    return jsonResponse<ErrorResponse>({ error: 'useCodexState must be a boolean' }, 400, headers);
  }

  const budgetResult = await setupBudgetContext(request, headers, body.models);
  if (budgetResult instanceof Response) return budgetResult;
  if (!await checkBudgetBetweenSteps(budgetResult)) {
    return jsonResponse<ErrorResponse>({ error: 'Monthly AI budget exceeded' }, 429, headers);
  }

  const phaseStart = Date.now();
  const wd = setupPhaseWatchdog(null, phaseStart);
  try {
    const plan = parsePlanningOutput(body.plan);
    const userClient = getUserClient(authCtx.userJwt);

    let researchContext = '';
    let clicheBlock = '';
    let codexStateBlock = '';
    let totalIn = 0;
    let totalOut = 0;
    let briefCount = 0;
    let codexCount = 0;
    let sceneCount = 0;
    const tasksMetadata = plan.tasks.map(t => ({
      focus: t.focus, entities: t.entities, scenes: t.scenes,
    }));

    const useCodexState = body.useCodexState === true;

    if (plan.tasks.length > 0) {
      const [researchData, storyOutline, clicheEntries, codexStateRows] = await Promise.all([
        fetchResearchData(plan, body.storyId, userClient, body.sceneId),
        fetchStoryOutline(body.storyId, userClient),
        fetchStoryClicheIndex(userClient, body.storyId),
        useCodexState ? fetchStoryCodexStates(userClient, body.storyId) : Promise.resolve([] as Awaited<ReturnType<typeof fetchStoryCodexStates>>),
      ]);
      clicheBlock = formatClicheIndexForPrompt(clicheEntries);
      // Single block shared by /draft and /refine. We intentionally do NOT
      // exclude `body.sceneId` here — the same-scene refine edge case (state
      // extracted from the very scene being refined) is rare in practice
      // (refine normally runs after generation, before any state extraction)
      // and skipping the dual-block plumbing keeps the wire shape simple.
      codexStateBlock = formatCodexStateForPrompt(
        codexStateRows,
        researchData.fullCache.codexEntries,
      );

      const briefs = await runResearchAgents(
        body.models.research,
        plan.tasks,
        researchData.taskDataMap,
        storyOutline,
        researchData.fullCache,
        authCtx.apiKey,
        body.openRouterPrefs,
        wd.signal,
      );
      for (const brief of briefs) {
        await trackUsageIfIncluded(body.models.research, budgetResult, brief.inputTokens, brief.outputTokens);
        totalIn += brief.inputTokens;
        totalOut += brief.outputTokens;
      }
      researchContext = consolidateResearchBriefs(briefs);
      briefCount = briefs.length;
      codexCount = researchData.fullCache.codexEntries.length;
      sceneCount = researchData.fullCache.scenes.length;
    } else {
      const clicheEntries = await fetchStoryClicheIndex(userClient, body.storyId);
      clicheBlock = formatClicheIndexForPrompt(clicheEntries);
      // No plan tasks → codex entries are never loaded for this run, so the
      // state block has nothing to anchor to. Skip the fetch entirely.
    }

    const response: ResearchResponseBody = {
      researchContext,
      clicheBlock,
      codexStateBlock,
      metadata: {
        briefCount,
        codexEntries: codexCount,
        scenes: sceneCount,
        tasks: tasksMetadata,
        researchModel: shortModelName(body.models.research),
      },
      inputTokens: totalIn,
      outputTokens: totalOut,
    };
    return jsonResponse(response, 200, headers);
  } catch (err) {
    if (wd.fired) {
      // SLOW_STEP_CODE, not WATCHDOG_CODE: this phase reads neither wordCount nor
      // preset, so "try a smaller word count or the balanced preset" is advice about
      // a different phase. See phase-watchdog.ts.
      return jsonResponse<ErrorResponse>(
        { error: 'Research exceeded time budget', code: SLOW_STEP_CODE }, 504, headers,
      );
    }
    if (err instanceof ModelProviderConfigError) {
      return jsonResponse<ErrorResponse>({ error: err.message }, 400, headers);
    }
    console.error('[AgenticWriter] /research error:', err);
    if (isTimeoutError(err)) {
      return jsonResponse<ErrorResponse>(
        { error: 'AI provider timed out during research', code: 'provider-timeout' }, 504, headers,
      );
    }
    // Only reached when EVERY research agent failed — a partial failure still answers
    // 200 with the surviving briefs. See runResearchAgents.
    if (err instanceof UpstreamError) return upstreamErrorResponse(err, headers);
    return jsonResponse<ErrorResponse>({ error: 'Research error' }, 500, headers);
  } finally {
    wd.dispose();
  }
}

export async function handleDraft(
  request: Request,
  body: DraftRequestBody,
  headers: Record<string, string>,
): Promise<Response> {
  const authCtx = checkApiKeyForOpenRouter(request, body.models, headers);
  if (authCtx instanceof Response) return authCtx;

  const messages = validateMessages(body.messages, headers);
  if (messages instanceof Response) return messages;

  if (typeof body.researchContext !== 'string') {
    return jsonResponse<ErrorResponse>({ error: 'researchContext must be a string' }, 400, headers);
  }
  if (body.temperature !== undefined) {
    if (typeof body.temperature !== 'number' || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2) {
      return jsonResponse<ErrorResponse>({ error: 'temperature must be between 0 and 2' }, 400, headers);
    }
  }

  const budgetResult = await setupBudgetContext(request, headers, body.models);
  if (budgetResult instanceof Response) return budgetResult;
  if (!await checkBudgetBetweenSteps(budgetResult)) {
    return jsonResponse<ErrorResponse>({ error: 'Monthly AI budget exceeded' }, 429, headers);
  }

  const wordCount = body.wordCount || 400;
  const preset = body.preset === 'thorough' ? 'thorough' : 'balanced';

  // Build streaming response
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const phaseStart = Date.now();
  const wd = setupPhaseWatchdog(writer, phaseStart);
  const stopHeartbeat = startHeartbeat(writer, phaseStart);

  // Run async — writes to `writer`. Don't await; return the stream immediately.
  (async () => {
    try {
      // Append research brief to last user message (server-side enrichment).
      // Codex state (when enabled) is already embedded inside the codex XML
      // assembled client-side, so /draft no longer receives a separate
      // codexStateBlock — only /refine does.
      const enrichedMessages = [...messages];
      if (body.researchContext) {
        const lastUserIdx = enrichedMessages.map(m => m.role).lastIndexOf('user');
        if (lastUserIdx >= 0) {
          enrichedMessages[lastUserIdx] = {
            ...enrichedMessages[lastUserIdx],
            content: enrichedMessages[lastUserIdx].content
              + '\n\n---\n\n' + RESEARCH_CONTEXT_PREAMBLE + '\n' + body.researchContext,
          };
        }
      }

      const draftConfig = getDraftConfig(wordCount, body.temperature);
      const timeoutMs = preset === 'thorough' ? TIMEOUT_DRAFT_THOROUGH_MS : TIMEOUT_DRAFT_BALANCED_MS;
      const isPreview = preset === 'thorough';

      const result = await streamToClient(
        writer,
        body.models.writing,
        null,
        '',
        enrichedMessages,
        draftConfig,
        authCtx.apiKey,
        body.openRouterPrefs,
        timeoutMs,
        wd.signal,
        isPreview,
      );
      await trackUsageIfIncluded(body.models.writing, budgetResult, result.inputTokens, result.outputTokens);

      const draftTruncated = result.finishReason === 'length';
      if (draftTruncated) {
        console.warn(`[AgenticWriter] Draft truncated: finish_reason=length, wordCount=${wordCount}, maxTokens=${draftConfig.maxTokens}, outputTokens=${result.outputTokens}`);
      }
      if (
        result.inputTokens === 0 &&
        result.outputTokens === 0 &&
        slotProvider(body.models.writing) === 'included'
      ) {
        console.warn(
          `[AgenticWriter] Draft streaming returned no usage data (model=${body.models.writing}); usage tracking skipped`,
        );
      }

      // Balanced mode is the final canonical output → warn on truncation, then DONE.
      // Thorough mode preview chunks already streamed; client will call /analyze + /refine next.
      if (preset === 'balanced' && draftTruncated) {
        await sendWarning(writer, 'Output was truncated because it exceeded the token limit. Try reducing the word count or splitting into smaller beats.');
      }

      const summary: DraftSummary = {
        draftContent: result.content,
        draftTruncated,
        finishReason: result.finishReason,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        model: shortModelName(body.models.writing),
      };
      await sendSummary(writer, summary);
      await sendDone(writer);
    } catch (err) {
      if (wd.fired) {
        await wd.errorSent;
        return;
      }
      console.error('[AgenticWriter] /draft error:', err);
      // The SSE response is already open here, so a config error can only be
      // relayed as an error event — validateCommonBody is what turns it into a
      // real 400, before this stream exists. Uncoded on purpose: the message is
      // operator-authored guidance no catalog key improves on.
      await sendClassifiedError(writer, err, 'Draft error');
    } finally {
      wd.dispose();
      stopHeartbeat();
    }
  })();

  return new Response(stream.readable, {
    status: 200,
    headers: {
      ...headers,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

export async function handleAnalyze(
  request: Request,
  body: AnalyzeRequestBody,
  headers: Record<string, string>,
): Promise<Response> {
  const authCtx = checkApiKeyForOpenRouter(request, body.models, headers);
  if (authCtx instanceof Response) return authCtx;

  const messages = validateMessages(body.messages, headers);
  if (messages instanceof Response) return messages;

  if (typeof body.draftContent !== 'string') {
    return jsonResponse<ErrorResponse>({ error: 'draftContent must be a string' }, 400, headers);
  }
  if (typeof body.clicheBlock !== 'string') {
    return jsonResponse<ErrorResponse>({ error: 'clicheBlock must be a string' }, 400, headers);
  }

  const budgetResult = await setupBudgetContext(request, headers, body.models);
  if (budgetResult instanceof Response) return budgetResult;
  if (!await checkBudgetBetweenSteps(budgetResult)) {
    return jsonResponse<ErrorResponse>({ error: 'Monthly AI budget exceeded' }, 429, headers);
  }

  const phaseStart = Date.now();
  const wd = setupPhaseWatchdog(null, phaseStart);
  try {
    const systemMsg = messages.find(m => m.role === 'system');
    const userMessages = messages.filter(m => m.role === 'user');

    const COMPACT_STYLE_LIMIT = 8000;
    const styleForRefine = systemMsg?.content
      ? (systemMsg.content.length > COMPACT_STYLE_LIMIT
        ? systemMsg.content.substring(0, COMPACT_STYLE_LIMIT) + '...[truncated]'
        : systemMsg.content)
      : '';

    if (body.clicheBlock === '' && styleForRefine === '') {
      // Nothing to analyze — return empty findings, refine still runs.
      const empty: AnalyzeResponseBody = {
        findings: '',
        model: shortModelName(body.models.analyzer),
        inputTokens: 0,
        outputTokens: 0,
      };
      return jsonResponse(empty, 200, headers);
    }

    const analyzerUserContent = [
      styleForRefine ? `Author's style instructions:\n${styleForRefine}` : '',
      `Original prompt:\n${userMessages.map(m => m.content).join('\n')}`,
      body.clicheBlock ? body.clicheBlock : '',
      `Draft to review:\n${body.draftContent}`,
    ].filter(Boolean).join('\n\n');

    const analyzerConfig = getAnalyzerConfig();
    const result = await callModel(
      body.models.analyzer,
      ANALYZER_SYSTEM_PROMPT,
      analyzerUserContent,
      analyzerConfig,
      authCtx.apiKey,
      body.openRouterPrefs,
      TIMEOUT_ANALYZER_MS,
      wd.signal,
    );
    await trackUsageIfIncluded(body.models.analyzer, budgetResult, result.inputTokens, result.outputTokens);

    const response: AnalyzeResponseBody = {
      findings: result.content,
      model: shortModelName(body.models.analyzer),
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
    return jsonResponse(response, 200, headers);
  } catch (err) {
    if (wd.fired) {
      return jsonResponse<ErrorResponse>(
        { error: 'Analyze exceeded time budget', code: WATCHDOG_CODE }, 504, headers,
      );
    }
    if (err instanceof ModelProviderConfigError) {
      return jsonResponse<ErrorResponse>({ error: err.message }, 400, headers);
    }
    console.error('[AgenticWriter] /analyze error:', err);
    if (isTimeoutError(err)) {
      return jsonResponse<ErrorResponse>({ error: 'AI provider timed out', code: 'provider-timeout' }, 504, headers);
    }
    if (err instanceof UpstreamError) return upstreamErrorResponse(err, headers);
    return jsonResponse<ErrorResponse>({ error: 'Analyze error' }, 500, headers);
  } finally {
    wd.dispose();
  }
}

export async function handleRefine(
  request: Request,
  body: RefineRequestBody,
  headers: Record<string, string>,
): Promise<Response> {
  const authCtx = checkApiKeyForOpenRouter(request, body.models, headers);
  if (authCtx instanceof Response) return authCtx;

  const messages = validateMessages(body.messages, headers);
  if (messages instanceof Response) return messages;

  if (typeof body.draftContent !== 'string') {
    return jsonResponse<ErrorResponse>({ error: 'draftContent must be a string' }, 400, headers);
  }
  if (typeof body.researchContext !== 'string') {
    return jsonResponse<ErrorResponse>({ error: 'researchContext must be a string' }, 400, headers);
  }
  if (typeof body.analyzerFindings !== 'string') {
    return jsonResponse<ErrorResponse>({ error: 'analyzerFindings must be a string' }, 400, headers);
  }
  // Backward-compat: see handleDraft — missing field is treated as empty.
  if (body.codexStateBlock !== undefined && typeof body.codexStateBlock !== 'string') {
    return jsonResponse<ErrorResponse>({ error: 'codexStateBlock must be a string' }, 400, headers);
  }

  const budgetResult = await setupBudgetContext(request, headers, body.models);
  if (budgetResult instanceof Response) return budgetResult;
  if (!await checkBudgetBetweenSteps(budgetResult)) {
    return jsonResponse<ErrorResponse>({ error: 'Monthly AI budget exceeded' }, 429, headers);
  }

  const wordCount = body.wordCount || 400;
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const phaseStart = Date.now();
  const wd = setupPhaseWatchdog(writer, phaseStart);
  const stopHeartbeat = startHeartbeat(writer, phaseStart);

  (async () => {
    try {
      // Positive clean signal from /analyze → skip the temperature-0.5 rewrite of an
      // already-clean draft. Stream the draft back as canonical (same fallback loop as
      // the empty/error paths) and report skippedClean. No callModel, no usage tracking,
      // no warning. Empty analyzerFindings does NOT trigger this (analyze failed or
      // short-circuited → no positive clean signal) — analyzerReportsClean('') is false.
      if (analyzerReportsClean(body.analyzerFindings)) {
        console.log(`[AgenticWriter] Analyzer reported a clean draft — skipping refine rewrite; streaming draft as canonical (model=${body.models.refiner})`);
        for (let i = 0; i < body.draftContent.length; i += 100) {
          const chunk = body.draftContent.substring(i, i + 100);
          if (!await sendContentChunk(writer, chunk)) return;
        }
        const cleanSummary: RefineSummary = {
          refinedContent: body.draftContent,
          truncated: false,
          finishReason: null,
          inputTokens: 0,
          outputTokens: 0,
          model: shortModelName(body.models.refiner),
          fellBackToDraft: false,
          skippedClean: true,
        };
        await sendSummary(writer, cleanSummary);
        await sendDone(writer);
        return;
      }

      const systemMsg = messages.find(m => m.role === 'system');
      const userMessages = messages.filter(m => m.role === 'user');

      const COMPACT_STYLE_LIMIT = 8000;
      const styleForRefine = systemMsg?.content
        ? (systemMsg.content.length > COMPACT_STYLE_LIMIT
          ? systemMsg.content.substring(0, COMPACT_STYLE_LIMIT) + '...[truncated]'
          : systemMsg.content)
        : '';

      const refineSystemContent = [
        REFINE_SYSTEM_PROMPT,
        styleForRefine ? `\nAuthor's style instructions:\n${styleForRefine}` : '',
        body.researchContext ? `\nFact-check reference (do not contradict):\n${body.researchContext}` : '',
        body.codexStateBlock ? `\nCurrent narrative state (do not contradict):\n${body.codexStateBlock}` : '',
      ].filter(Boolean).join('\n');

      const refineUserContent = [
        `Original draft:\n${body.draftContent}`,
        body.analyzerFindings ? `\nFindings to address:\n${body.analyzerFindings}` : '',
        `\nOriginal prompt:\n${userMessages.map(m => m.content).join('\n')}`,
      ].filter(Boolean).join('\n');

      const refineMessages = [
        { role: 'system', content: refineSystemContent },
        { role: 'user', content: refineUserContent },
      ];

      const refineConfig = getRefineConfig(body.draftContent.length, wordCount);
      let truncatedOutput = false;
      let fellBackToDraft = false;
      let refinedContent = '';
      let refineFinishReason: string | null = null;
      let refineInputTokens = 0;
      let refineOutputTokens = 0;

      try {
        const refineStreamResult = await streamToClient(
          writer,
          body.models.refiner,
          null,
          '',
          refineMessages,
          refineConfig,
          authCtx.apiKey,
          body.openRouterPrefs,
          TIMEOUT_REFINE_MS,
          wd.signal,
        );
        await trackUsageIfIncluded(body.models.refiner, budgetResult, refineStreamResult.inputTokens, refineStreamResult.outputTokens);
        refinedContent = refineStreamResult.content;
        refineFinishReason = refineStreamResult.finishReason;
        refineInputTokens = refineStreamResult.inputTokens;
        refineOutputTokens = refineStreamResult.outputTokens;

        if (refineStreamResult.content.trim().length === 0) {
          console.warn(`[AgenticWriter] Refine returned empty output: finish_reason=${refineStreamResult.finishReason}, model=${body.models.refiner}; streaming draft as fallback`);
          for (let i = 0; i < body.draftContent.length; i += 100) {
            const chunk = body.draftContent.substring(i, i + 100);
            if (!await sendContentChunk(writer, chunk)) return;
          }
          await sendWarning(writer, 'Refinement step produced no output — showing the original draft. Try a different refiner model.');
          fellBackToDraft = true;
          refinedContent = body.draftContent;
        } else if (refineStreamResult.finishReason === 'length') {
          console.warn(`[AgenticWriter] Refine truncated: finish_reason=length, wordCount=${wordCount}, maxTokens=${refineConfig.maxTokens}, draftLength=${body.draftContent.length}, outputTokens=${refineStreamResult.outputTokens}`);
          truncatedOutput = true;
        }
      } catch (err) {
        if (wd.fired) {
          await wd.errorSent;
          return;
        }
        // "Try a different refiner model" is the wrong advice for a misconfigured
        // provider, and this catch is what used to bury that guidance in the
        // container log. Let the outer catch relay the real message.
        //
        // Same reasoning, three more reasons: a throttle, a rejected key and a timeout
        // are all things a *different refiner model* does not fix, and answering them
        // with the draft plus "try a different refiner model" tells the author a story
        // that is simply untrue. /refine makes exactly one attempt, so this is a clean
        // binary — everything else (a model that errored, a malformed body) still falls
        // back to the draft, which is worth more than an error.
        if (err instanceof ModelProviderConfigError) throw err;
        if (isTimeoutError(err)) throw err;
        if (err instanceof UpstreamError && (err.code === 'rate-limited' || err.code === 'api-key-invalid')) {
          throw err;
        }
        console.warn('[AgenticWriter] Refine failed, streaming draft as fallback:', (err as Error).message);
        for (let i = 0; i < body.draftContent.length; i += 100) {
          const chunk = body.draftContent.substring(i, i + 100);
          if (!await sendContentChunk(writer, chunk)) return;
        }
        await sendWarning(writer, 'Refinement step failed — showing the original draft. Try a different refiner model.');
        fellBackToDraft = true;
        refinedContent = body.draftContent;
      }

      if (truncatedOutput) {
        await sendWarning(writer, 'Output may be incomplete — the draft exceeded the token limit. Try reducing the word count or splitting into smaller beats.');
      }

      const summary: RefineSummary = {
        refinedContent,
        truncated: truncatedOutput,
        finishReason: refineFinishReason,
        inputTokens: refineInputTokens,
        outputTokens: refineOutputTokens,
        model: shortModelName(body.models.refiner),
        fellBackToDraft,
        skippedClean: false,
      };
      await sendSummary(writer, summary);
      await sendDone(writer);
    } catch (err) {
      if (wd.fired) {
        await wd.errorSent;
        return;
      }
      console.error('[AgenticWriter] /refine error:', err);
      await sendClassifiedError(writer, err, 'Refine error');
    } finally {
      wd.dispose();
      stopHeartbeat();
    }
  })();

  return new Response(stream.readable, {
    status: 200,
    headers: {
      ...headers,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// --- Main router ---

/**
 * The whole function, as an ordinary async function.
 *
 * It lives here rather than inline in `Deno.serve` so a test can call it — and call the
 * phase handlers below — without binding a port. `index.ts` is the entry point and does
 * nothing but hand this to `Deno.serve`; splitting the file physically is what makes
 * that possible, since importing a module that calls `Deno.serve` at top level starts a
 * server as a side effect of the import.
 */
export async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin') || '';
  const headers = corsHeaders(origin);

  const preflight = handleCorsPreflightIfNeeded(request, headers);
  if (preflight) return preflight;

  const rl = rateLimitResponse(request, headers, 50, 60_000, 'agentic-writer');
  if (rl) return rl;

  const path = url.pathname.replace(/^\/agentic-writer/, '') || '/';

  // Cliché analysis tool — unchanged behavior.
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

    const providerError = checkSlotProviders({ model: analyzeBody.model });
    if (providerError) {
      return jsonResponse<ErrorResponse>({ error: providerError }, 400, headers);
    }

    const provider = slotProvider(analyzeBody.model);
    const apiKey = request.headers.get('X-API-Key') || null;
    if (provider === 'openrouter' && !apiKey) {
      return jsonResponse<ErrorResponse>({ error: 'X-API-Key header required for OpenRouter models' }, 400, headers);
    }

    let budgetCtx: BudgetContext | null = null;
    if (provider === 'included') {
      const budgetResult = await setupBudgetContext(request, headers, {
        writing: analyzeBody.model,
        research: analyzeBody.model,
        refiner: analyzeBody.model,
        analyzer: analyzeBody.model,
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

      if (budgetCtx) {
        await trackUsageIfIncluded(analyzeBody.model, budgetCtx, result.inputTokens, result.outputTokens);
      }

      return jsonResponse({ success: true, count: result.count, categories: result.categories }, 200, headers);
    } catch (err) {
      if (err instanceof ModelProviderConfigError) {
        return jsonResponse<ErrorResponse>({ error: err.message }, 400, headers);
      }
      console.error('[AgenticWriter] Cliché analysis error:', err);
      if (isTimeoutError(err)) {
        return jsonResponse<ErrorResponse>({ error: 'AI provider timed out', code: 'provider-timeout' }, 504, headers);
      }
      if (err instanceof UpstreamError) return upstreamErrorResponse(err, headers);
      const message = err instanceof Error ? err.message : 'Analysis failed';
      return jsonResponse<ErrorResponse>({ error: message }, 500, headers);
    }
  }

  // Phase endpoints — all POST.
  const isPhaseEndpoint = (
    path === '/plan' ||
    path === '/research' ||
    path === '/draft' ||
    path === '/analyze' ||
    path === '/refine'
  );
  if (!isPhaseEndpoint || request.method !== 'POST') {
    return jsonResponse<ErrorResponse>({ error: 'Not found' }, 404, headers);
  }

  const auth = await extractAuthFromRequest(request, headers);
  if (auth instanceof Response) return auth;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonResponse<ErrorResponse>({ error: 'Invalid request body' }, 400, headers);
  }

  const validated = validateCommonBody(body, headers);
  if (validated instanceof Response) return validated;

  // Hand the handlers the RESOLVED four slots. They read `body.models` directly, and
  // the client omits a key entirely when its slot is unset
  // (`beat-ai-stream.dispatcher.ts` spreads `analyzer` in only when truthy), so
  // `models.analyzer` could be `undefined` at runtime despite the type saying string.
  // Every `[writing, research, refiner, analyzer].some(…)` walks all four when none
  // matches — an all-local or all-OpenRouter pipeline with no analyzer slot reached
  // `undefined.split(':')` and threw a TypeError OUTSIDE any try/catch, so the
  // browser saw a CORS failure rather than a message. `validateCommonBody` already
  // computed the safe defaults (analyzer → refiner → writing) and then discarded
  // them; this is where they were meant to land. /analyze also stops calling
  // `callModel(undefined)`.
  body['models'] = validated.models as unknown as Record<string, unknown>;

  // Dispatch
  switch (path) {
    case '/plan':
      return handlePlan(request, body as unknown as PlanRequestBody, headers);
    case '/research':
      return handleResearch(request, body as unknown as ResearchRequestBody, headers);
    case '/draft':
      return handleDraft(request, body as unknown as DraftRequestBody, headers);
    case '/analyze':
      return handleAnalyze(request, body as unknown as AnalyzeRequestBody, headers);
    case '/refine':
      return handleRefine(request, body as unknown as RefineRequestBody, headers);
    default:
      return jsonResponse<ErrorResponse>({ error: 'Not found' }, 404, headers);
  }
}
