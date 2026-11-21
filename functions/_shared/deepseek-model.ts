/**
 * DeepSeek slot → DeepSeek V4.1 Flash request mapping.
 *
 * `deepseek-chat` and `deepseek-reasoner` here are INTERNAL slot identifiers for
 * the `included:` AI-budget feature — they are NEVER sent to DeepSeek's API. This
 * function always emits `model: 'deepseek-flash'` as the wire model and selects
 * reasoning purely via the top-level `thinking.type` flag. Because the deprecated
 * IDs never leave our backend, DeepSeek's 2026-07-24 deprecation of the
 * `deepseek-chat` / `deepseek-reasoner` API models is a non-event for this code
 * path — no rename or persisted-settings migration is required.
 *
 * **`deepseek-flash`, not `deepseek-v4-flash`.** DeepSeek's pricing page lists the
 * V4 name as a retired legacy alias, still accepted and served by `deepseek-flash`
 * (V4.1 Flash). Probed 2026-10-02: both names answer as `deepseek-flash`, read
 * `image_url` parts (#468), and honour `thinking` on and off — so the canonical
 * name changes nothing today and does not depend on the alias surviving.
 *
 * Whether the model reasons is `thinking.type`, set below from the slot. How hard it reasons
 * is `reasoning_effort`, for the reasoner slot only (#1064 slice 4). This file used to call
 * that field a no-op; probed 2026-11-12 it is not: on `deepseek-flash` with thinking on, `low`
 * thinks least and `max` most, and an unknown value is a 422. DeepSeek's own `none` does not
 * turn thinking off while `thinking.type` is sent, which takes precedence.
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

/**
 * DeepSeek's real `reasoning_effort` levels, weakest first: its docs map every other name onto
 * one of these, and no field means `high`. The only values accepted from a client, which sends
 * the author's level already rounded down to one of them. **Mirrored** from
 * `DEEPSEEK_REASONING_EFFORTS` in `src/app/core/models/reasoning-policy.ts`;
 * `npm run check:shared-constants` compares the two, because a level the browser sends and this
 * refuses is a 400 on every reasoner call.
 */
export const DEEPSEEK_REASONING_EFFORTS = ['low', 'high', 'max'] as const;
export type DeepseekReasoningEffort = typeof DEEPSEEK_REASONING_EFFORTS[number];

export function isDeepseekReasoningEffort(value: unknown): value is DeepseekReasoningEffort {
  return typeof value === 'string' && (DEEPSEEK_REASONING_EFFORTS as readonly string[]).includes(value);
}

/**
 * Why a client's `reasoning_effort` is refused, or null when it is absent or one of
 * {@link DEEPSEEK_REASONING_EFFORTS}. The premium chat route answers a refusal with a 400 before
 * any DeepSeek call, which would otherwise be a 422 one round trip later.
 */
export function deepseekReasoningEffortError(value: unknown): string | null {
  if (value === undefined || isDeepseekReasoningEffort(value)) return null;
  return `reasoning_effort must be one of: ${DEEPSEEK_REASONING_EFFORTS.join(', ')}`;
}

/**
 * The wire model, the thinking flag and, on the reasoner slot, the effort the browser resolved.
 * An effort on the chat slot is dropped: with thinking off there is nothing for it to steer.
 */
export function deepseekRequestFields(slot: string, effort?: DeepseekReasoningEffort): {
  model: string;
  thinking: { type: 'enabled' | 'disabled' };
  reasoning_effort?: DeepseekReasoningEffort;
} {
  const reasoner = slot === 'deepseek-reasoner';
  return {
    model: 'deepseek-flash',
    thinking: { type: reasoner ? 'enabled' : 'disabled' },
    ...(reasoner && effort ? { reasoning_effort: effort } : {}),
  };
}
