/**
 * Model-calling helpers shared across agentic-writer phase endpoints — and, for
 * `resolveUpstream` alone, by `premium/`'s portrait generation. Those three call sites
 * take the URL + headers and build their own request: one is an *image* call over the
 * same chat/completions endpoint, so `callModel`/`streamToClient` do not fit them.
 * That is the intended granularity — the resolver is the shared thing, not the call.
 *
 * Supported slot providers — `<provider>:<modelId>`, provider matched lowercased:
 *   - 'openrouter:<modelId>'       — OpenRouter, uses the user-supplied API key
 *   - 'venice:<modelId>'           — Venice, uses the user-supplied API key
 *   - 'included:<slot>'            — DeepSeek, uses DEEPSEEK_API_KEY env (hosted only)
 *   - 'ollama:<modelId>'           — self-hosted only, OLLAMA_BASE_URL env
 *   - 'openaiCompatible:<modelId>' — self-hosted only, OPENAI_COMPATIBLE_BASE_URL env
 *
 * `resolveUpstream` is the ONE place a slot turns into a URL + headers. It used to be
 * four hand-copied `if (openrouter) {…} else { DeepSeek }` branches whose `else` was an
 * unguarded fallthrough — an `ollama:llama3` slot was POSTed to api.deepseek.com with the
 * platform key. The switch is exhaustive and throws on anything it does not know.
 *
 * Two call modes:
 *   - callModel:      non-streaming, system+user pair (planning, analyzer)
 *   - streamToClient: streaming, writes content chunks to an SSE writer (draft, refine)
 */

import { fetchWithTimeout } from './timeout.ts';
import { requireEnv } from './stripe-helpers.ts';
import { deepseekRequestFields } from './deepseek-model.ts';
import { sendContentChunk } from './sse-helpers.ts';
import { UpstreamError } from './api-errors.ts';
import { classifyUpstreamFailure } from './upstream-classify.ts';

export interface ModelConfig {
  provider: string; // 'openrouter', 'included', 'ollama' or 'openaiCompatible'
  modelId: string;  // e.g., 'deepseek/deepseek-chat' or 'deepseek-chat'
}

export interface CallModelResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: string | null;
}

/** Parse an `<provider>:<modelId>` slot. */
export function parseModelSlot(slot: string): ModelConfig {
  const [provider, ...rest] = slot.split(':');
  return { provider, modelId: rest.join(':') };
}

/**
 * A slot's provider, lowercased — the form every policy decision must compare.
 *
 * `slot.startsWith('included:')` is the shape this replaces: it silently answers
 * false for `Included:deepseek-chat`, which `resolveUpstream` serves perfectly well,
 * so a budget or credential guard written that way can be walked around by casing.
 */
export function slotProvider(slot: string): string {
  return parseModelSlot(slot).provider.toLowerCase();
}

/** Extract human-readable model name from a slot like 'openrouter:anthropic/claude-3.5-sonnet' → 'claude-3.5-sonnet' */
export function shortModelName(slot: string): string {
  const afterColon = slot.includes(':') ? slot.split(':').slice(1).join(':') : slot;
  const lastSegment = afterColon.split('/').pop() || afterColon;
  // Strip OpenRouter suffixes like :free, :extended
  return lastSegment.replace(/:(?:free|extended|beta|nitro)$/, '');
}

// ---------------------------------------------------------------------------
// Upstream resolution — slot → URL + headers + body extras
// ---------------------------------------------------------------------------

/** Where a slot's request goes, and what has to be added to it. */
export interface UpstreamTarget {
  url: string;
  headers: Record<string, string>;
  /**
   * Fields to merge into the request body **after** it is built.
   * Order matters: `deepseekRequestFields()` overwrites `body.model` (the
   * `included:` slot ids are internal, never wire model names). Merge these
   * first and an `included:` call silently sends the wrong model id.
   */
  bodyExtras: Record<string, unknown>;
}

/**
 * A slot names a provider this instance cannot serve, or the operator config it
 * needs is missing/malformed. Callers map this to **400**, not 500 — the message
 * is operator-authored config guidance and is meant to be shown.
 */
export class ModelProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelProviderConfigError';
  }
}

const DOCS_ANCHOR = 'docs/configuration.md#local-ai-providers-for-deep-writer-self-hosted';

/**
 * Providers whose upstream is a server the **operator** runs, keyed lowercased.
 *
 * SSRF invariants — these are the whole reason a local provider is safe here, and
 * "let the client send its baseUrl" is the obvious future "improvement" that breaks
 * every one of them:
 *
 * - The base URL comes from `Deno.env` ONLY. No request field carries it and none
 *   may be added. A client-supplied URL turns every authenticated user into an
 *   arbitrary-origin POST proxy *inside the operator's Docker network*, with reach
 *   to `db:5432` and `kong:8000`.
 * - The slot's `modelId` only ever becomes the JSON body's `model` field. It is
 *   never interpolated into the URL path.
 * - Scheme allowlist: `http:` / `https:` (see {@link toChatCompletionsUrl}).
 * - Unset env + a local slot → throw, naming the env var. Never a fallback: an
 *   operator who does nothing gets no new egress at all.
 * - Accepted residual: upstream error bodies are echoed truncated to 200 chars.
 *   Against a *fixed operator-chosen* URL that is a debugging aid rather than a
 *   scanning primitive — and it stays true only because the URL is not variable.
 */
const LOCAL_PROVIDERS: Record<string, { label: string; baseUrlEnv: string; apiKeyEnv: string }> = {
  ollama: {
    label: 'Ollama',
    baseUrlEnv: 'OLLAMA_BASE_URL',
    apiKeyEnv: 'OLLAMA_API_KEY',
  },
  openaicompatible: {
    label: 'OpenAI-compatible provider',
    baseUrlEnv: 'OPENAI_COMPATIBLE_BASE_URL',
    apiKeyEnv: 'OPENAI_COMPATIBLE_API_KEY',
  },
};

/**
 * Normalise the five spellings operators actually write into a chat-completions URL:
 * `http://h:11434`, `http://h:11434/`, `…/v1`, `…/v1/`, `…/v1/chat/completions`.
 *
 * Rejects any scheme but http/https, and anything that is not a URL at all.
 */
export function toChatCompletionsUrl(base: string): string {
  const trimmed = (base || '').trim();
  if (!trimmed) {
    throw new ModelProviderConfigError('base URL is empty');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ModelProviderConfigError(`"${trimmed}" is not a valid URL`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ModelProviderConfigError(
      `only http:// and https:// base URLs are supported (got "${trimmed}")`,
    );
  }

  // Suffix matching is case-INSENSITIVE: `/V1` is a spelling operators paste, and a
  // case-sensitive `endsWith('/v1')` appended a second one — `http://h:11434/V1`
  // became `…/V1/v1/chat/completions`, a 404 with a baffling message. The operator's
  // own casing is preserved in what we send; the upstream server decides on it.
  const path = parsed.pathname.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(path)) {
    parsed.pathname = path;
  } else if (/\/v1$/i.test(path)) {
    parsed.pathname = `${path}/chat/completions`;
  } else {
    parsed.pathname = `${path}/v1/chat/completions`;
  }
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function resolveLocalUpstream(providerKey: string): UpstreamTarget {
  const cfg = LOCAL_PROVIDERS[providerKey];

  // Defense in depth. `checkSlotProviders` is the gate; this makes the resolver
  // itself refuse to open local egress on a hosted instance even if a call site
  // ever forgets to run the gate first. Read at call time, never at module scope.
  if (Deno.env.get('SELF_HOSTED') !== 'true') {
    throw new ModelProviderConfigError(
      `${cfg.label} models are only available on self-hosted instances`,
    );
  }

  const rawBase = Deno.env.get(cfg.baseUrlEnv) || '';
  if (!rawBase.trim()) {
    throw new ModelProviderConfigError(
      `${cfg.label} is not configured on this server — set ${cfg.baseUrlEnv} on the functions container. See ${DOCS_ANCHOR}`,
    );
  }

  let url: string;
  try {
    url = toChatCompletionsUrl(rawBase);
  } catch (err) {
    throw new ModelProviderConfigError(
      `${cfg.baseUrlEnv} is invalid: ${(err as Error).message}. See ${DOCS_ANCHOR}`,
    );
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // Optional — Ollama behind an authenticating proxy, or vLLM's --api-key. The
  // credential must belong to whoever owns the URL, so it comes from the
  // operator's env and NEVER from the request's X-API-Key (that header
  // unambiguously means "the OpenRouter key" at three call sites).
  const localKey = Deno.env.get(cfg.apiKeyEnv);
  if (localKey) headers['Authorization'] = `Bearer ${localKey}`;

  return { url, headers, bodyExtras: {} };
}

/**
 * Resolve a `<provider>:<modelId>` slot to its upstream endpoint.
 *
 * The switch is **exhaustive and throws on anything unknown** — that is the point.
 * The provider is lowercased first because `ModelService` mints `openaiCompatible:`
 * with a capital C while every comparison here is lowercase; that exact casing
 * mismatch has already been a real bug (see `core/models/text-model-providers.ts`).
 */
export function resolveUpstream(
  slot: string,
  opts: {
    /**
     * The author's own key for **this slot's** provider — OpenRouter's or Venice's.
     *
     * It used to mean "the OpenRouter key". Widening the meaning rather than adding a second
     * field is what keeps `callModel`, `callModelStream` and `runResearchAgents`
     * untouched: each already receives the slot beside the key, so the CALLER picks which key
     * belongs to it (`keyForSlot` in the router). A second field here would have had to be
     * threaded through their positional signatures instead. (There was a fourth,
     * `analyzeCliches`, until the cliché-index build moved into the browser.)
     *
     * Never forwarded to a local provider — see `resolveLocalUpstream`.
     */
    apiKey: string | null;
    openRouterPrefs?: Record<string, unknown>;
    /**
     * Pin a different DeepSeek model than the `included:` slot names.
     *
     * **Retained with no current caller.** Its only one was `analyzeCliches`, which pinned
     * 'deepseek-chat' because analysis is non-reasoning by design; that moved into the browser
     * and took the option's last use with it. Removing the option is a reasonable follow-up and
     * is deliberately not folded into that move — it also touches
     * `model-calling-upstream.test.ts` and `premium/index.ts`'s comment about it.
     */
    deepseekSlotOverride?: string;
  },
): UpstreamTarget {
  const { provider, modelId } = parseModelSlot(slot);

  switch (provider.toLowerCase()) {
    case 'openrouter': {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${opts.apiKey}`,
        'HTTP-Referer': 'https://creativewriter.dev',
        'X-Title': 'Creative Writer',
      };
      const bodyExtras: Record<string, unknown> = {};
      if (opts.openRouterPrefs && Object.keys(opts.openRouterPrefs).length > 0) {
        bodyExtras.provider = opts.openRouterPrefs;
      }
      return { url: 'https://openrouter.ai/api/v1/chat/completions', headers, bodyExtras };
    }

    case 'included': {
      let deepseekKey: string;
      try {
        deepseekKey = requireEnv('DEEPSEEK_API_KEY');
      } catch {
        // Same status + wording as setupBudgetContext's own check, so hoisting the
        // resolve into validateCommonBody does not change what a caller sees.
        throw new ModelProviderConfigError('Included AI models require DEEPSEEK_API_KEY to be configured');
      }
      return {
        url: 'https://api.deepseek.com/v1/chat/completions',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${deepseekKey}`,
        },
        bodyExtras: deepseekRequestFields(opts.deepseekSlotOverride ?? modelId),
      };
    }

    case 'venice': {
      // The author's own key, forwarded from the browser exactly as OpenRouter's is. Venice
      // is OpenAI-shaped, so the body `callModel`/`callModelStream` already builds needs no
      // extras — deliberately including `venice_parameters`, which the browser-side
      // `VeniceApiService` also omits. Setting one here and not there would make the same
      // model answer differently depending on which surface called it.
      return {
        url: 'https://api.venice.ai/api/v1/chat/completions',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${opts.apiKey}`,
        },
        bodyExtras: {},
      };
    }

    case 'ollama':
      return resolveLocalUpstream('ollama');

    case 'openaicompatible':
      return resolveLocalUpstream('openaicompatible');

    default:
      throw new ModelProviderConfigError(
        `Unsupported model provider "${provider}" — Deep Writer slots must name a provider this instance can serve`,
      );
  }
}

// ---------------------------------------------------------------------------
// Provider gate — which providers may appear in a Deep Writer slot at all
// ---------------------------------------------------------------------------

/**
 * Providers a hosted instance can serve server-side.
 *
 * `openrouter` and `venice` are here because both are ordinary remote HTTPS APIs the
 * function can reach with a key the author forwards. `gemini` and `claude` are not, and
 * cannot be: the app reaches those through browser-side proxies.
 */
const HOSTED_SLOT_PROVIDERS: readonly string[] = ['openrouter', 'included', 'venice'];

/** …plus the operator's own local servers, on self-hosted. */
const SELF_HOSTED_SLOT_PROVIDERS: readonly string[] = ['ollama', 'openaicompatible'];

/**
 * Lowercased providers allowed in a slot on this instance.
 *
 * Reads `SELF_HOSTED` at **call time**, never at module scope: the Deno test run
 * loads every function's tests into one process, and one of them sets
 * `SELF_HOSTED=true` while its module is evaluated.
 *
 * `included` deliberately stays in the self-hosted set. Dropping it would replace
 * `setupBudgetContext`'s precise 403 ("Included AI is not available on self-hosted
 * instances") — which designates itself the guard for a stale `included:` slot —
 * with a vague 400 from here. Shape and policy stay separate concerns:
 * `isValidModelSlot` checks the shape, this checks the policy, and the budget
 * guard owns the included-AI entitlement.
 */
export function allowedSlotProviders(): ReadonlySet<string> {
  const allowed = new Set(HOSTED_SLOT_PROVIDERS);
  if (Deno.env.get('SELF_HOSTED') === 'true') {
    for (const p of SELF_HOSTED_SLOT_PROVIDERS) allowed.add(p);
  }
  return allowed;
}

/**
 * Check every slot's provider against {@link allowedSlotProviders}.
 * Returns an error message for the first offending field, or null when all pass.
 */
export function checkSlotProviders(slots: Record<string, string>): string | null {
  const allowed = allowedSlotProviders();
  for (const [field, slot] of Object.entries(slots)) {
    const provider = parseModelSlot(slot).provider.toLowerCase();
    if (!allowed.has(provider)) {
      return `Model provider "${provider}" is not available on this instance (${field}). Allowed: ${[...allowed].sort().join(', ')}`;
    }
  }
  return null;
}

/**
 * Reasoning allowance, mirroring `REASONING_CONSTRAINTS` in
 * `src/app/core/models/model-variants.config.ts`.
 *
 * **A deliberate second copy**, like the `ApiErrorCode`/`ProviderErrorCode` wire contract:
 * an Edge Function cannot import from `src/`. Change one and change the other, or the same
 * Venice model gets a different budget depending on which surface called it — which is the
 * exact failure this padding exists to prevent.
 *
 * `npm run check:shared-constants` compares the two numerically and fails the build on a
 * difference, so this is a guarded duplicate rather than a hoped-for one. Add a row there
 * for any new pair — the check cannot discover one by itself.
 */
const REASONING_MIN_TOKENS = 1024;
const REASONING_MAX_TOKENS = 32_000;
/** Reasoning budget as a multiple of the output budget. Carried explicitly rather than folded
 *  away: the client's `calculateReasoningBudget` multiplies by it, and the two copies are equal
 *  today only BECAUSE it is 1. Writing `min(maxTokens, …)` here would make a future change to
 *  the client's ratio silently diverge instead of obviously so. */
const REASONING_RATIO = 1.0;

/**
 * The `max_tokens` to send for this slot.
 *
 * On Venice, `max_tokens` is **one shared budget**: hidden `<think>` tokens come out of the
 * same pool as the visible completion. Venice's own docs say so of the sibling field it now
 * prefers — `max_completion_tokens` is "an upper bound … including visible output tokens and
 * reasoning tokens" — and nothing in a slot id says whether the chosen model reasons.
 *
 * That is survivable on `/draft` and `/refine` (3000-32000 tokens of budget) and not on the
 * three small phases: planning and research get 800, the analyzer 600. A thinking model can
 * spend all of it before writing a visible word, and neither `handlePlan` nor `handleAnalyze`
 * warns on truncation — a plan cut to nothing propagates silently into the next phase.
 *
 * **Call it from any body you hand-build.** `callModel` and `streamToClient` apply it, but
 * they are not the only things that POST to a slot: `research-agent.ts` assembles its own body
 * and has to ask. A first version of this helper covered only the two shared callers while its
 * own comment claimed research was handled — which is worse than not padding at all, because it
 * reads as finished.
 *
 * So Venice slots get the same padding `VeniceApiService.withReasoningHeadroom` already
 * applies in the browser, for the same reason and by the same arithmetic. Harmless for a
 * non-reasoning model: it raises a ceiling, and cost follows tokens actually generated.
 *
 * **Not** `venice_parameters.disable_thinking`, which Venice does offer. Turning off a
 * model's reasoning is not this app's call to make — the browser path settled that — and
 * doing it on one surface only would be worse than either choice made consistently.
 */
export function maxTokensForSlot(slot: string, maxTokens: number): number {
  if (parseModelSlot(slot).provider.toLowerCase() !== 'venice') return maxTokens;
  const scaled = Math.max(
    REASONING_MIN_TOKENS,
    Math.min(Math.ceil(maxTokens * REASONING_RATIO), REASONING_MAX_TOKENS),
  );
  return maxTokens + scaled;
}

/**
 * Call a model (non-streaming). Used for planning + analyzer.
 * Accepts a systemPrompt + userContent pair (always builds a 2-message array).
 */
export async function callModel(
  modelSlot: string,
  systemPrompt: string,
  userContent: string,
  config: { maxTokens: number; temperature: number },
  apiKey: string | null,
  openRouterPrefs?: Record<string, unknown>,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<CallModelResult> {
  const { modelId } = parseModelSlot(modelSlot);

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  const body: Record<string, unknown> = {
    model: modelId,
    messages,
    max_tokens: maxTokensForSlot(modelSlot, config.maxTokens),
    temperature: config.temperature,
    stream: false,
  };

  const target = resolveUpstream(modelSlot, { apiKey, openRouterPrefs });
  // AFTER the body is built — bodyExtras overwrites `model` for `included:` slots.
  Object.assign(body, target.bodyExtras);

  const response = await fetchWithTimeout(target.url, {
    method: 'POST',
    headers: target.headers,
    body: JSON.stringify(body),
    timeout: timeoutMs,
    signal,
  });

  if (!response.ok) {
    // Classified here, where the status still exists. The cap lives in the classifier.
    throw classifyUpstreamFailure(response.status, await response.text(), 'Model API error');
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
 * Call a model with streaming. Writes content chunks to the supplied SSE
 * writer as they arrive. Returns the accumulated content + usage at the end.
 */
export async function streamToClient(
  writer: WritableStreamDefaultWriter,
  modelSlot: string,
  systemPrompt: string | null,
  userContent: string,
  messages: Array<{ role: string; content: string }> | null,
  config: { maxTokens: number; temperature: number },
  apiKey: string | null,
  openRouterPrefs?: Record<string, unknown>,
  timeoutMs = 120_000,
  signal?: AbortSignal,
  preview = false,
): Promise<CallModelResult> {
  const { modelId } = parseModelSlot(modelSlot);

  const requestMessages = messages || [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    { role: 'user', content: userContent },
  ];

  const body: Record<string, unknown> = {
    model: modelId,
    messages: requestMessages,
    max_tokens: maxTokensForSlot(modelSlot, config.maxTokens),
    temperature: config.temperature,
    stream: true,
    // Unconditional. Ollama, vLLM and LM Studio all accept it; a bare llama.cpp
    // shim may 400. The only consequence of dropping it would be zeroed token
    // counts, and `trackUsageIfIncluded` is a no-op for non-`included:` slots anyway.
    //
    // Venice accepts it too — checked against Venice's own API reference rather than
    // assumed, because that schema is `additionalProperties: false` and so REJECTS an
    // unknown field instead of ignoring it. Every field this body sends is in it.
    stream_options: { include_usage: true },
  };

  const target = resolveUpstream(modelSlot, { apiKey, openRouterPrefs });
  // AFTER the body is built — see UpstreamTarget.bodyExtras.
  Object.assign(body, target.bodyExtras);

  const response = await fetchWithTimeout(target.url, {
    method: 'POST',
    headers: target.headers,
    body: JSON.stringify(body),
    timeout: timeoutMs,
    signal,
  });

  if (!response.ok) {
    throw classifyUpstreamFailure(response.status, await response.text(), 'Model API error');
  }

  if (!response.body) {
    // A 2xx with nothing to read: upstream answered, and the answer is unusable.
    throw new UpstreamError('provider-unavailable', 'Empty response body from model API', 502);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let accumulatedContent = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason: string | null = null;

  while (true) {
    if (signal?.aborted) {
      try { await reader.cancel(); } catch { /* ignore */ }
      return { content: accumulatedContent, inputTokens, outputTokens, finishReason };
    }
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
        if (parsed.usage) {
          inputTokens = parsed.usage.prompt_tokens || 0;
          outputTokens = parsed.usage.completion_tokens || 0;
        }
        if (parsed.choices?.[0]?.finish_reason) {
          finishReason = parsed.choices[0].finish_reason;
        }
        const delta = parsed.choices?.[0]?.delta;
        if (delta?.content) {
          accumulatedContent += delta.content;
          const ok = await sendContentChunk(writer, delta.content, preview);
          if (!ok) {
            try { await reader.cancel(); } catch { /* ignore */ }
            return { content: accumulatedContent, inputTokens, outputTokens, finishReason };
          }
        }
      } catch { /* ignore parse errors */ }
    }
  }

  return { content: accumulatedContent, inputTokens, outputTokens, finishReason };
}
