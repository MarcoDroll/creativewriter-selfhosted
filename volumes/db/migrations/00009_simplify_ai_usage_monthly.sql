-- Migration: Simplify AI usage tracking to single monthly accumulator row
-- Replaces daily rows + SUM aggregation with one row per customer per calendar month.

-- 1. Clear ephemeral rows
TRUNCATE ai_usage_daily;

-- 2. Rename table: ai_usage_daily → ai_usage
ALTER TABLE ai_usage_daily RENAME TO ai_usage;

-- 3. Drop token columns (stored but never read)
ALTER TABLE ai_usage DROP COLUMN input_tokens;
ALTER TABLE ai_usage DROP COLUMN output_tokens;

-- 4. Replace usage_date → cycle_month (1st-of-month DATE)
ALTER TABLE ai_usage DROP CONSTRAINT ai_usage_daily_customer_date_key;
ALTER TABLE ai_usage RENAME COLUMN usage_date TO cycle_month;
ALTER TABLE ai_usage ALTER COLUMN cycle_month DROP DEFAULT;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_customer_cycle_key
  UNIQUE (stripe_customer_id, cycle_month);

-- 5. Drop current_period_start from subscription_cache (no longer needed)
ALTER TABLE subscription_cache DROP COLUMN IF EXISTS current_period_start;

-- 6. Replace increment_ai_usage: simpler signature (no tokens, no date key)
DROP FUNCTION IF EXISTS increment_ai_usage(TEXT, TEXT, BIGINT, BIGINT, NUMERIC);
CREATE OR REPLACE FUNCTION increment_ai_usage(
  p_customer_id TEXT,
  p_cycle_month DATE,
  p_cost NUMERIC
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO ai_usage (stripe_customer_id, cycle_month, total_cost_usd, request_count, last_updated)
  VALUES (p_customer_id, p_cycle_month, p_cost, 1, now())
  ON CONFLICT (stripe_customer_id, cycle_month)
  DO UPDATE SET
    total_cost_usd = ai_usage.total_cost_usd + EXCLUDED.total_cost_usd,
    request_count = ai_usage.request_count + 1,
    last_updated = now();
END;
$$;

-- 7. Drop dead functions
DROP FUNCTION IF EXISTS get_monthly_ai_usage(TEXT, DATE);
DROP FUNCTION IF EXISTS cleanup_old_ai_usage();
