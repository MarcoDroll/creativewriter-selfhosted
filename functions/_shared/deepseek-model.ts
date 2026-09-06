/**
 * DeepSeek slot → V4 Flash request mapping.
 *
 * `deepseek-chat` and `deepseek-reasoner` here are INTERNAL slot identifiers for
 * the `included:` AI-budget feature — they are NEVER sent to DeepSeek's API. This
 * function always emits `model: 'deepseek-v4-flash'` as the wire model and selects
 * reasoning purely via the top-level `thinking.type` flag. Because the deprecated
 * IDs never leave our backend, DeepSeek's 2026-07-24 deprecation of the
 * `deepseek-chat` / `deepseek-reasoner` API models is a non-event for this code
 * path — no rename or persisted-settings migration is required.
 *
 * Reasoning is controlled SOLELY by `thinking.type` set below. Note that DeepSeek
 * V4 Flash ignores `reasoning_effort`, so that field is a no-op for these slots.
 *
 * NOTE: `thinking` is sent at the request body's top level. `extra_body` is an
 * OpenAI Python SDK convention that lifts those fields to the top level on
 * serialization — when calling DeepSeek's HTTP API directly via fetch, the
 * field must already be at the top level or DeepSeek will ignore it.
 *
 * CAVEAT: OpenRouter routing slugs a user may have selected (e.g.
 * `openrouter:deepseek/deepseek-chat`) are a SEPARATE concern — they go to
 * OpenRouter, not through this function. See the `project_openrouter_deepseek_slug`
 * follow-up for that risk surface.
 */

export type IncludedDeepseekSlot = 'deepseek-chat' | 'deepseek-reasoner';

export function deepseekRequestFields(slot: string): {
  model: string;
  thinking: { type: 'enabled' | 'disabled' };
} {
  return {
    model: 'deepseek-v4-flash',
    thinking: { type: slot === 'deepseek-reasoner' ? 'enabled' : 'disabled' },
  };
}
