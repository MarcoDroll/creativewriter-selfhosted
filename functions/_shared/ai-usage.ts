import { getAdminClient } from './supabase-admin.ts';
import type { JwtValidationResult } from './types.ts';

// --- DeepSeek pricing (per million tokens, USD) ---
// Both legacy slot IDs now resolve to deepseek-v4-flash on the API side; pricing is unified.

const DEEPSEEK_PRICING: Record<string, { inputPerMillionTokens: number; outputPerMillionTokens: number }> = {
  // Legacy slot IDs — what callers actually pass today.
  'deepseek-chat':     { inputPerMillionTokens: 0.14, outputPerMillionTokens: 0.28 },
  'deepseek-reasoner': { inputPerMillionTokens: 0.14, outputPerMillionTokens: 0.28 },
  // Defensive — future-proofs callers that log the API model ID directly.
  'deepseek-v4-flash': { inputPerMillionTokens: 0.14, outputPerMillionTokens: 0.28 },
};

// --- Included image generation flat-cost (USD per image) ---
// fal-ai/flux/schnell is ≈ $0.003 at 1024². We add a small overhead for the CDN
// fetch and the DeepSeek prompt-build call on the portrait path, landing at a
// flat ~$0.004/image. The shared monthly budget therefore covers roughly
// 125 (app-trial $0.50) / 250 (basic $1) / 1250 (premium $5) images.
export const IMAGE_COST_USD = 0.004;

export type BudgetTier = 'app_trial' | 'basic' | 'premium';

const MONTHLY_BUDGET_BY_TIER: Record<BudgetTier, number> = {
  app_trial: 0.50,
  basic: 1.00,
  premium: 5.00,
};

/**
 * How many character references the included image tier allows.
 *
 * **This is a product differentiator, and deliberately not a cost control** — worth stating
 * plainly, because it was designed as one and the design was wrong.
 * `scripts/probes/included-klein-4b.sh` measured `x-fal-billable-units` at 1, 2, 3 and 4
 * references on `fal-ai/flux-2/klein/4b/edit`: **identical at every count** (0.75 for
 * `landscape_4_3`, 1.00 for `square_hd`). Units track OUTPUT megapixels, not inputs, so a
 * four-reference render costs exactly what a one-reference render costs. What actually bounds the
 * charge is the output size, capped separately where the request is validated.
 *
 * Enforced here as well as in the browser: the client knows the author's tier, but a client that
 * lies about it must not get four.
 *
 * `app_trial` sits with `basic` — a trial is a look at the Basic tier, not at Premium.
 */
export const REFERENCE_CAP_BY_TIER: Record<BudgetTier, number> = {
  app_trial: 2,
  basic: 2,
  premium: 4,
};

export function getMonthlyBudget(tier: string): number {
  // Cast is safe: `?? 0` covers any tier string that isn't a BudgetTier key.
  return MONTHLY_BUDGET_BY_TIER[tier as BudgetTier] ?? 0;
}

export function resolveIncludedAiTier(validation: JwtValidationResult): BudgetTier | null {
  if (!validation.valid) return null;
  if (validation.tier !== 'basic' && validation.tier !== 'premium') return null;
  return validation.subData?.status === 'app_trial' ? 'app_trial' : validation.tier!;
}

// --- Cycle helpers ---

export function getCycleMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString().split('T')[0];
}

// --- Usage tracking ---

export async function getMonthlyUsage(customerId: string, cycleMonth: string): Promise<number> {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from('ai_usage')
    .select('total_cost_usd')
    .eq('stripe_customer_id', customerId)
    .eq('cycle_month', cycleMonth)
    .maybeSingle();
  if (error) {
    console.error('DB error reading monthly usage:', error.message);
    return 0;
  }
  return data ? parseFloat(data.total_cost_usd) || 0 : 0;
}

/** Atomic usage increment via Postgres RPC — avoids read-modify-write race conditions */
export async function logUsage(
  customerId: string,
  cycleMonth: string,
  inputTokens: number,
  outputTokens: number,
  model = 'deepseek-chat',
): Promise<void> {
  const supabase = getAdminClient();
  const pricing = DEEPSEEK_PRICING[model] || DEEPSEEK_PRICING['deepseek-chat'];
  const cost = (inputTokens / 1_000_000) * pricing.inputPerMillionTokens
             + (outputTokens / 1_000_000) * pricing.outputPerMillionTokens;

  const { error } = await supabase.rpc('increment_ai_usage', {
    p_customer_id: customerId,
    p_cycle_month: cycleMonth,
    p_cost: cost,
  });

  if (error) {
    console.error('Failed to log AI usage:', error.message);
  }
}

/**
 * What fal charges per billable unit on `fal-ai/flux-2/klein/4b/edit`.
 *
 * Published as "$0.01 per megapixel" on the model's own page (read 2026-08-28), and
 * `x-fal-billable-units` is that megapixel count, quantised — measured 0.75 against a 0.786 MP
 * output and 1.00 against 1.048 MP.
 *
 * **Model-specific on purpose.** `fal-ai/flux/schnell` is a different rate, so the schnell path
 * keeps its flat {@link IMAGE_COST_USD} rather than multiplying its header by this number.
 */
export const FAL_USD_PER_BILLABLE_UNIT = 0.01;

/**
 * The cost fal actually billed, read from its own response header.
 *
 * `x-fal-billable-units` is the metering primitive this replaces a guess with: a real per-request
 * figure, no dashboard and no estimation. It is still multiplied by a rate we hold as a constant,
 * because fal publishes the rate on a pricing page rather than in the API — so the *units* are
 * measured and the *rate* is transcribed.
 *
 * Falls back rather than throwing. A missing or unparseable header must not lose the charge
 * entirely, which would be a silently free render; `fallbackUsd` should be the worst case the
 * caller could have been billed, so an unreadable header over-meters rather than under-meters.
 */
export function imageCostFromBillableUnits(
  header: string | null,
  usdPerUnit: number,
  fallbackUsd: number,
): number {
  const units = header === null ? NaN : Number(header);
  if (!Number.isFinite(units) || units <= 0) {
    if (header !== null) console.warn('Unreadable x-fal-billable-units:', header);
    return fallbackUsd;
  }
  return units * usdPerUnit;
}

/**
 * Atomic cost increment for an included image generation.
 *
 * Mirrors {@link logUsage} but takes a cost in dollars rather than deriving one from tokens. The
 * `increment_ai_usage` RPC bumps `request_count` by exactly 1 per call, so this is one render.
 *
 * **The parameter is dollars, not a count.** It used to be `count`, multiplied by a flat
 * {@link IMAGE_COST_USD} — which cannot express the reference path, where the charge is the
 * output megapixels fal reports. A caller passing `2` meaning "two images" would now log two
 * dollars, so there is deliberately no numeric overlap between the old meaning and the new one at
 * the only call site.
 */
export async function logImageUsage(
  customerId: string,
  cycleMonth: string,
  costUsd = IMAGE_COST_USD,
): Promise<void> {
  const supabase = getAdminClient();
  const { error } = await supabase.rpc('increment_ai_usage', {
    p_customer_id: customerId,
    p_cycle_month: cycleMonth,
    p_cost: costUsd,
  });

  if (error) {
    console.error('Failed to log image usage:', error.message);
  }
}

export async function checkMonthlyBudget(
  customerId: string,
  tier = 'premium',
): Promise<{ usagePercent: number; remainingUsd: number }> {
  const budget = getMonthlyBudget(tier);
  if (budget <= 0) return { usagePercent: 100, remainingUsd: 0 };
  const cycleMonth = getCycleMonth();
  const totalCostUsd = await getMonthlyUsage(customerId, cycleMonth);
  return {
    usagePercent: Math.min((totalCostUsd / budget) * 100, 100),
    remainingUsd: Math.max(0, budget - totalCostUsd),
  };
}
