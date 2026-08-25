/**
 * Wire types shared between the agentic-writer phase endpoints and the
 * frontend orchestrator (agentic-writer-api.service.ts).
 *
 * IMPORTANT: A frontend mirror lives at
 *   src/app/core/models/agentic-writer-pipeline.types.ts
 * because the Deno code under supabase/functions/ cannot be imported into
 * Angular. Keep both copies in sync — this file is the canonical source.
 */

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
  /** Returned by /research; carried for /analyze. */
  clicheBlock: string;
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
  clicheBlock: string;
}

export interface AnalyzeResponseBody {
  findings: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

// --- /refine (SSE) ---

export interface RefineRequestBody extends PhaseCommonBody {
  messages: AgenticMessage[];
  draftContent: string;
  researchContext: string;
  analyzerFindings: string;
  clicheBlock: string;
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
