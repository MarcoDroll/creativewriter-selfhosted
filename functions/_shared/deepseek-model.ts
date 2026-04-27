/**
 * DeepSeek slot → V4 Flash request mapping.
 *
 * Both included slot IDs (`deepseek-chat` and `deepseek-reasoner`) now resolve
 * to the unified `deepseek-v4-flash` model. Reasoning is selected via the
 * top-level `thinking.type` flag instead of a separate model ID.
 *
 * NOTE: `thinking` is sent at the request body's top level. `extra_body` is an
 * OpenAI Python SDK convention that lifts those fields to the top level on
 * serialization — when calling DeepSeek's HTTP API directly via fetch, the
 * field must already be at the top level or DeepSeek will ignore it.
 *
 * Slot IDs are kept stable to avoid migrating persisted Settings.model rows.
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
