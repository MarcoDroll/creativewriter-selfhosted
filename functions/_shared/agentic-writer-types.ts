/**
 * Wire types shared between the agentic-writer phase endpoints and the
 * frontend orchestrator (agentic-writer-api.service.ts).
 *
 * IMPORTANT: A frontend mirror lives at
 *   src/app/core/models/agentic-writer-pipeline.types.ts
 * because the Deno code under supabase/functions/ cannot be imported into
 * Angular. Keep both copies in sync — this file is the canonical source.
 */

import type { VeniceReasoningEffort } from './model-calling.ts';

export type AgenticPreset = 'balanced' | 'thorough';

export interface AgenticMessage {
  role: string;
  content: string;
}

export interface AgenticModels {
  writing: string;
  research: string;
  refiner: string;
  analyzer: string;
}

/** Body fields shared by every phase request. */
export interface PhaseCommonBody {
  /** Client-generated UUID; also sent as X-Pipeline-Request-Id header. */
  pipelineRequestId: string;
  storyId: string;
  sceneId?: string;
  models: AgenticModels;
  preset: AgenticPreset;
  wordCount: number;
  /** OpenRouter routing prefs (only relevant for openrouter: slots). */
  openRouterPrefs?: Record<string, unknown>;
  /**
   * What the browser resolved for each slot's reasoning (#1064 slice 3), keyed by the slot string
   * as it appears in `models`. The browser holds the model lists and the author's one Reasoning
   * setting; this function mirrors none of those rules and only puts the result on the wire.
   * Validated per provider by `validateCommonBody`.
   *
   * **Present means read strictly**: a slot with no entry, or an entry without a field, sends
   * nothing for it — a Venice slot on "Model default" gets no `reasoning_effort` (#921), an
   * OpenRouter slot that is not a `:reasoning` variant gets no reasoning object. Absent means a
   * client from before this map, and the three older fields below apply exactly as they did.
   */
  reasoning?: Record<string, SlotReasoning>;
  /**
   * Older clients only — superseded by {@link reasoning}, and read only when it is absent. Each
   * Venice slot's `reasoning_effort` (#107); a Venice slot with no entry sends `medium`.
   */
  veniceEfforts?: Record<string, VeniceReasoningEffort>;
  /**
   * Older clients only, like {@link veniceEfforts}: each NanoGPT slot's `reasoning_effort`. A
   * NanoGPT slot with no entry sends no effort at all.
   */
  nanoGptEfforts?: Record<string, VeniceReasoningEffort>;
  /**
   * Older clients only, like {@link veniceEfforts}: each NanoGPT slot's output ceiling, which
   * `maxTokensForSlot` clamps the padded budget to.
   */
  nanoGptMaxOutputs?: Record<string, number>;
}

/**
 * One slot's entry in {@link PhaseCommonBody.reasoning}. Which fields a slot may carry depends on
 * its provider, and `validateCommonBody` refuses any other.
 */
export interface SlotReasoning {
  /** Venice, NanoGPT and Included `deepseek-reasoner` (low/high/max only): the top-level `reasoning_effort`, already rounded to the model's levels. */
  reasoningEffort?: VeniceReasoningEffort;
  /**
   * NanoGPT, and an OpenRouter `:reasoning` slot whose listing gives `max_completion_tokens`
   * (#1068): the model's output ceiling, which the padded budget is clamped to.
   */
  maxOutput?: number;
  /** OpenRouter: the id to send — a `:reasoning` slot with the app's marker stripped. */
  model?: string;
  /** OpenRouter: the `reasoning` object, an effort or `{ enabled: true }` on "Model default". */
  reasoning?: { effort?: VeniceReasoningEffort; enabled?: true };
  /**
   * OpenRouter: reasoning tokens to allow per output token, for the effort sent (share / (100 −
   * share), 1 at medium). Each phase's `max_tokens` is padded by it, within 1024..32000.
   */
  allowanceRatio?: number;
}

// --- /plan ---

export interface PlanRequestBody extends PhaseCommonBody {
  messages: AgenticMessage[];
}

export interface PlanResponseBody {
  /** Raw planning model output — caller passes it back to /research as `plan`. */
  plan: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** True when the model stopped at max_tokens (`finish_reason === 'length'`). Same meaning as RefineSummary. */
  truncated: boolean;
  finishReason: string | null;
}

// --- /research ---

export interface ResearchRequestBody extends PhaseCommonBody {
  /** Verbatim plan string returned by /plan. */
  plan: string;
  /** When true, /research fetches codex_entry_current_state and produces
   *  a non-empty codexStateBlock. Default false (omitted on the wire). */
  useCodexState?: boolean;
}

export interface ResearchResponseBody {
  /** XML-ish consolidated research brief, ready to append to user message. */
  researchContext: string;
  /** Cliché index block (formatted for LLM prompt). */
  clicheBlock: string;
  /** Current-state block built from codex_entry_current_state rows; '' when empty. */
  codexStateBlock: string;
  metadata: {
    briefCount: number;
    codexEntries: number;
    scenes: number;
    tasks: Array<{ focus: string; entities?: string[]; scenes?: string[] }>;
    researchModel: string;
  };
  /** How many of `metadata.briefCount` briefs were cut off at the token limit (`finish_reason === 'length'`). */
  truncatedBriefs: number;
  /** How many briefs ended on a still-pending tool call after the last tool round, so hold no real answer (#415). */
  exhaustedBriefs: number;
  /**
   * False when the `plan` sent in could not be read (prose, broken JSON, no
   * `research_tasks` array, no usable task), so research was skipped for that reason
   * rather than because the planner asked for none (#410). The client copy in
   * `src/app/core/models/agentic-writer-pipeline.types.ts` is optional: absent = read.
   */
  planParsed: boolean;
  inputTokens: number;
  outputTokens: number;
}

// --- /draft (SSE) ---

export interface DraftRequestBody extends PhaseCommonBody {
  messages: AgenticMessage[];
  /**
   * Returned by /research; server appends to last user message. When
   * `useCodexState` is on, the codex XML embedded in `messages` already
   * carries per-entry tracked state, so a separate state block is not needed
   * here (refine still injects state via `codexStateBlock`).
   */
  researchContext: string;
  temperature?: number;
}

/** Wire summary event sent over SSE before sendDone(). */
export interface DraftSummary {
  draftContent: string;
  draftTruncated: boolean;
  finishReason: string | null;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

// --- /analyze ---

export interface AnalyzeRequestBody extends PhaseCommonBody {
  messages: AgenticMessage[];
  draftContent: string;
  /**
   * Returned by /research and carried only this far. `f4e8ea6a` moved the cliché block OUT of
   * the draft and refine prompts deliberately — /analyze is its one consumer, and /refine acts
   * on the findings it produces rather than on a static avoid-list.
   */
  clicheBlock: string;
}

export interface AnalyzeResponseBody {
  findings: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** True when the model stopped at max_tokens (`finish_reason === 'length'`). Same meaning as RefineSummary. */
  truncated: boolean;
  finishReason: string | null;
}

// --- /refine (SSE) ---

export interface RefineRequestBody extends PhaseCommonBody {
  messages: AgenticMessage[];
  draftContent: string;
  researchContext: string;
  analyzerFindings: string;
  /** Returned by /research; injected into refine system prompt when present. */
  codexStateBlock: string;
}

export interface RefineSummary {
  /** Final refined output; same content already streamed. */
  refinedContent: string;
  /** True if either draft or refine hit max_tokens. */
  truncated: boolean;
  finishReason: string | null;
  inputTokens: number;
  outputTokens: number;
  model: string;
  /** True when the server fell back to streaming the draft (refine empty/error). */
  fellBackToDraft: boolean;
  /** True when /analyze reported "No findings." and the refine rewrite was skipped
   *  — the draft was streamed back unchanged as canonical. Distinct from
   *  fellBackToDraft (an error/empty fallback); this is the clean-draft happy path. */
  skippedClean: boolean;
}

// --- Warnings ---

/**
 * The codes the SSE warning frame (`{ warning, code }`, see `sse-helpers.ts`) carries, so the
 * client can translate the warning instead of showing `warning`'s English sentence (#412).
 *
 * The client's list is `DEEP_WRITER_WARNING_CODES` in
 * `src/app/core/models/agentic-writer-pipeline.types.ts`, a superset — the client raises most
 * warnings itself. `npm run check:shared-constants` fails when a code here is missing there.
 * Add a code rather than renaming one: a renamed code reaches an older client as unknown, and
 * it falls back to the English sentence.
 */
export const DEEP_WRITER_WIRE_WARNING_CODES = [
  'draft-truncated',
  'refine-empty',
  'refine-failed',
  'refine-truncated',
] as const;

export type DeepWriterWireWarningCode = (typeof DEEP_WRITER_WIRE_WARNING_CODES)[number];
