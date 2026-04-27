-- Migration: Add RLS SELECT policies for backend-only tables
-- Tables: ai_usage, subscription_cache, audit_log
--
-- These tables have RLS enabled but no policies (writes are service-role only).
-- Adding SELECT policies silences Supabase Security Advisor warnings and
-- enables potential future direct frontend reads.

-- 1. ai_usage — SELECT via stripe_customers join
CREATE POLICY ai_usage_select_own ON ai_usage
  FOR SELECT TO authenticated
  USING (
    stripe_customer_id = (
      SELECT sc.stripe_customer_id
      FROM stripe_customers sc
      WHERE sc.user_id = auth.uid()
    )
  );

-- 2. subscription_cache — SELECT via same join pattern
CREATE POLICY subscription_cache_select_own ON subscription_cache
  FOR SELECT TO authenticated
  USING (
    stripe_customer_id = (
      SELECT sc.stripe_customer_id
      FROM stripe_customers sc
      WHERE sc.user_id = auth.uid()
    )
  );

-- 3. audit_log — SELECT via direct user_id column
CREATE POLICY audit_log_select_own ON audit_log
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
