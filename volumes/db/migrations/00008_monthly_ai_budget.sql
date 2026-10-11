-- Migration: Switch AI budget from daily to monthly tracking
-- Adds current_period_start to subscription_cache, monthly usage aggregation RPC,
-- and extends usage retention from 30 to 62 days.

-- 1. Add current_period_start column to subscription_cache
ALTER TABLE subscription_cache
  ADD COLUMN IF NOT EXISTS current_period_start BIGINT NOT NULL DEFAULT 0;

-- 2. Monthly usage aggregation RPC
-- Sums ai_usage_daily rows from p_cycle_start to CURRENT_DATE for a given customer.
CREATE OR REPLACE FUNCTION get_monthly_ai_usage(
  p_customer_id TEXT,
  p_cycle_start DATE
)
RETURNS TABLE (
  total_cost_usd NUMERIC,
  request_count BIGINT,
  input_tokens BIGINT,
  output_tokens BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(SUM(a.total_cost_usd), 0)::NUMERIC AS total_cost_usd,
    COALESCE(SUM(a.request_count), 0)::BIGINT AS request_count,
    COALESCE(SUM(a.input_tokens), 0)::BIGINT AS input_tokens,
    COALESCE(SUM(a.output_tokens), 0)::BIGINT AS output_tokens
  FROM ai_usage_daily a
  WHERE a.stripe_customer_id = p_customer_id
    AND a.usage_date >= p_cycle_start
    AND a.usage_date <= CURRENT_DATE;
END;
$$;

-- 3. Update cleanup retention from 30 to 62 days (covers current + previous billing cycle)
CREATE OR REPLACE FUNCTION cleanup_old_ai_usage() RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM ai_usage_daily WHERE usage_date < CURRENT_DATE - INTERVAL '62 days';
END;
$$;
