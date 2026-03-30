/**
 * Pipeline step prompt templates and configs for the agentic writer.
 */

export const REFINE_SYSTEM_PROMPT = `You are a creative writing refinement assistant. Improve the draft based on the review notes provided.

Rules:
- Address each review point
- Match the author's style instructions when provided — voice, tone, and narrative preferences take priority
- Prioritize transition quality: the opening must flow naturally from the preceding text, and the closing must bridge smoothly
- Maintain continuity with the scene text from context — do not contradict established details
- Preserve the approximate length of the original draft
- Identify and replace clichéd or overused phrases listed in the Cliché Index below — rewrite them with original, context-specific prose and avoid substituting with other phrases from the same category
- Do not add meta-commentary or explanations
- Output ONLY the refined prose`;

export interface PipelineStepConfig {
  maxTokens: number;
  temperature: number;
}

export function getPlanningConfig(): PipelineStepConfig {
  return { maxTokens: 800, temperature: 0.3 };
}

export function getResearchAgentConfig(): PipelineStepConfig {
  return { maxTokens: 600, temperature: 0.3 };
}

export function getDraftConfig(wordCount: number, userTemperature?: number): PipelineStepConfig {
  return {
    maxTokens: Math.min(Math.max(Math.ceil(wordCount * 2.5), 3000), 32000),
    temperature: userTemperature ?? 0.7,
  };
}

export function getRefineConfig(draftLength: number, targetWordCount?: number): PipelineStepConfig {
  // Estimate tokens from draft character count (chars/4, allow 30% growth)
  const fromDraft = Math.ceil(draftLength / 4 * 1.3);
  // Estimate tokens from target word count (same formula as DRAFT)
  const fromTarget = targetWordCount ? Math.ceil(targetWordCount * 2.5) : 0;
  // Use whichever is larger — REFINE must be able to match the target length
  const estimatedTokens = Math.max(fromDraft, fromTarget);
  return {
    maxTokens: Math.min(Math.max(estimatedTokens, 3000), 32000),
    temperature: 0.5,
  };
}
