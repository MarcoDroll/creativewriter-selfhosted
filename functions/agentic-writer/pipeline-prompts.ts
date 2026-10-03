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
- Address each finding by dimension — for [Cliché], replace the flagged phrase with original, context-specific prose (never another phrase from the same category); for [Voice]/[Tone], rewrite the flagged span to match the author's style instructions; for [Dialogue], rewrite the flagged speech to match the speaking character's voice as described in the Glossary/Original-prompt context (that character's own voice, NOT the author's narration style), preserving the line's meaning and who is speaking.
- Do not introduce new continuity errors, voice inconsistencies, or clichés while addressing revision notes
- Respect any "Current narrative state" block: do not contradict where characters are, what they know, their physical condition, or their open tensions, unless the original prompt explicitly resolves it.
- Do not add meta-commentary or explanations
- Output ONLY the refined prose`;

export const ANALYZER_SYSTEM_PROMPT = `You are a fiction editor reviewing a draft for three things only: clichés, tone/voice consistency, and character-dialogue voice.

Evaluate these dimensions:
1. [Cliché] Phrases in the draft that match (exactly or as close variants) entries in the Cliché Index, if provided.
2. [Voice] POV slips, tense slips, or narrator-stance shifts that diverge from the author's style instructions.
3. [Tone] Register or mood mismatches with the author's style instructions (e.g. comedic beat in a grim brief; clinical narration in a lyrical brief).
4. [Dialogue] Lines of direct/quoted speech whose wording, register, or manner don't match the speaking character's established voice, as described in the <glossary> block (their <description>, personality, and any voice/speech custom fields).

Rules:
- Output ONLY a numbered list of findings, max 8, ordered by severity.
- Tag each finding with its dimension in brackets, e.g. "1. [Cliché] 'her piercing eyes' — replace with a rewrite specific to this scene's lighting/mood (do NOT pick another phrase from the same category)."
- For [Cliché] findings: quote the phrase as it appears in the draft, then give a context-specific rewrite direction — never a replacement phrase from the same Cliché Index category.
- For [Voice]/[Tone] findings: quote the offending sentence (or short span), name the divergence in one phrase, and give a one-line correction direction.
- For [Dialogue] findings: attribute each quoted line to its speaker using nearby dialogue tags/context; flag ONLY when the speaker is confidently identifiable AND the Glossary describes how they speak. Skip when no character voice is defined for the speaker, when there is no Glossary, or when attribution is ambiguous. Quote the offending line, name the mismatch in one phrase (e.g. "too formal for a gruff dockworker"), and give a one-line rewrite direction toward the character's voice.
- Skip findings whose match is too loose to act on.
- Do NOT flag continuity, fulfillment, length, or plot — those are out of scope.
- If the draft is clean on all dimensions, output the single line "No findings."`;

/**
 * True only when the analyzer emitted its positive "clean" contract ("No findings.").
 *
 * Robust against LLM formatting drift (leading numbering, trailing punctuation,
 * casing, "Nicely done." tails), but must NOT false-positive when real findings
 * exist (that would drop a finding). A findings list always carries a
 * [Cliché]/[Voice]/[Tone]/[Dialogue] dimension tag, so the tag guard
 * short-circuits first. Deviations that miss (e.g. "None found.") fall through
 * to a normal refine — the safe default. Empty input returns false: an empty
 * string means analyze failed or short-circuited, so we lack a positive clean
 * signal.
 */
export function analyzerReportsClean(findings: string): boolean {
  if (/\[(cliché|cliche|voice|tone|dialogue)\]/i.test(findings)) return false;
  // startsWith already tolerates any trailing content ("No findings.",
  // "No findings. Nicely done."), so only the leading non-letters ("1. ")
  // need stripping before the prefix check.
  return findings.trim().replace(/^[^a-z]+/i, '')
    .toLowerCase().startsWith('no findings');
}

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

export function getAnalyzerConfig(): PipelineStepConfig {
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
