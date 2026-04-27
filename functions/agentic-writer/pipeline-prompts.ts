/**
 * Pipeline step prompt templates and configs for the agentic writer.
 */

export const RESEARCH_CONTEXT_PREAMBLE = `The following research briefs were gathered by research agents who investigated the story's codex and prior scenes to ensure accuracy.

- Treat facts in these briefs as authoritative — they reflect established story canon
- The Glossary above is the canonical source for character/location descriptions; research briefs provide supplementary context (prior interactions, emotional arcs, unresolved tensions)
- Weave researched details naturally into the prose — do NOT reference the research or briefs explicitly
`;

export const REFINE_SYSTEM_PROMPT = `You are a creative writing refinement assistant. You receive a draft and may receive targeted revision notes from an editor.

Your task: if revision notes are provided, systematically address each one while preserving the draft's strengths. If no revision notes are provided, perform a general quality pass focusing on transitions, prose clarity, and cliché replacement.

Rules:
- Address each revision note specifically — do not ignore any
- Preserve the author's voice, tone, and narrative style as established in the draft
- Match the author's style instructions below when provided — these take priority over the draft's voice if they conflict
- Preserve the approximate length of the original draft
- Replace clichéd or overused phrases from the Cliché Index with original, context-specific prose — avoid substituting with other phrases from the same category
- Do not introduce new continuity errors, voice inconsistencies, or clichés while addressing revision notes
- Do not add meta-commentary or explanations
- Output ONLY the refined prose`;

export const CRITIQUE_SYSTEM_PROMPT = `You are a fiction editor reviewing a draft against the original beat prompt. Produce a concise critique the writer can use to improve it.

Evaluate these dimensions:
1. [Transitions] Does the opening flow from the preceding text? Does the closing provide a natural stop?
2. [Continuity] Any contradictions with the research context, codex entries, or prior scene text?
3. [Voice] Are characters speaking and acting consistently? Does the narrative voice match the author's style instructions?
4. [Prose] Overused phrases, telling-not-showing, pacing issues?
5. [Fulfillment] Does the prose accomplish what the beat prompt requested?
6. [Length] Does the draft approximately match the requested word count? Any bloat or significant omissions?

Rules:
- Output ONLY a numbered list of specific, actionable revision notes
- Tag each note with its dimension in brackets, e.g. "1. [Continuity] Marcus has blue eyes here but brown eyes in the codex"
- Order notes by severity, most critical first
- Max 8 notes. If the draft is strong, say so briefly and list only minor improvements
- Do NOT suggest changes to fundamental story decisions (POV, tense, plot direction, character arcs) — focus on execution quality`;

export interface PipelineStepConfig {
  maxTokens: number;
  temperature: number;
}

export function getPlanningConfig(): PipelineStepConfig {
  return { maxTokens: 800, temperature: 0.3 };
}

export function getResearchAgentConfig(): PipelineStepConfig {
  return { maxTokens: 800, temperature: 0.3 };
}

export function getCritiqueConfig(): PipelineStepConfig {
  return { maxTokens: 600, temperature: 0.3 };
}

export function getDraftConfig(wordCount: number, userTemperature?: number): PipelineStepConfig {
  return {
    maxTokens: Math.min(Math.max(Math.ceil(wordCount * 3), 3000), 32000),
    temperature: userTemperature ?? 0.7,
  };
}

export function getRefineConfig(draftLength: number, targetWordCount?: number): PipelineStepConfig {
  // Estimate tokens from draft character count (chars/4, allow 30% growth)
  const fromDraft = Math.ceil(draftLength / 4 * 1.3);
  // Estimate tokens from target word count (same formula as DRAFT)
  const fromTarget = targetWordCount ? Math.ceil(targetWordCount * 3) : 0;
  // Use whichever is larger — REFINE must be able to match the target length
  const estimatedTokens = Math.max(fromDraft, fromTarget);
  return {
    maxTokens: Math.min(Math.max(estimatedTokens, 3000), 32000),
    temperature: 0.5,
  };
}
