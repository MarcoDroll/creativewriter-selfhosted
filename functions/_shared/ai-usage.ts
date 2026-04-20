import { getAdminClient } from './supabase-admin.ts';
import type { JwtValidationResult } from './types.ts';

// --- DeepSeek pricing (per million tokens, USD) ---

const DEEPSEEK_PRICING: Record<string, { inputPerMillionTokens: number; outputPerMillionTokens: number }> = {
  'deepseek-chat':     { inputPerMillionTokens: 0.27, outputPerMillionTokens: 1.10 },
  'deepseek-reasoner': { inputPerMillionTokens: 0.55, outputPerMillionTokens: 2.19 },
};

export type BudgetTier = 'app_trial' | 'basic' | 'premium';

const MONTHLY_BUDGET_BY_TIER: Record<BudgetTier, number> = {
  app_trial: 0.50,
  basic: 1.00,
  premium: 5.00,
};

export function getMonthlyBudget(tier: string): number {
  return MONTHLY_BUDGET_BY_TIER[tier] ?? 0;
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
