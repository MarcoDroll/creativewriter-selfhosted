/**
 * The cache-hit count in an OpenAI-shaped `usage` object (#473): DeepSeek's own
 * `prompt_cache_hit_tokens`, else the OpenAI-standard `prompt_tokens_details.cached_tokens` it also
 * sends. 0 when neither is there — which meters the full input rate, the safe direction.
 *
 * Its own module, dependency-free, so `model-calling.ts` can read it without importing
 * `ai-usage.ts` and the admin client behind it.
 */
export function cachedTokensOf(usage: unknown): number {
  if (!usage || typeof usage !== 'object') return 0;
  const record = usage as Record<string, unknown>;
  const direct = record['prompt_cache_hit_tokens'];
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  const details = record['prompt_tokens_details'] as Record<string, unknown> | undefined;
  const nested = details?.['cached_tokens'];
  return typeof nested === 'number' && Number.isFinite(nested) ? nested : 0;
}
