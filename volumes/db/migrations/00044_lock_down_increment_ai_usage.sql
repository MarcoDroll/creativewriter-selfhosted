-- 00044_lock_down_increment_ai_usage.sql
-- Lock down EXECUTE on the increment_ai_usage RPC to service_role only.
--
-- Background: PostgreSQL grants EXECUTE on new functions to PUBLIC by
-- default. log_audit_event (00010) correctly revokes this. increment_ai_usage
-- (created in 00003, replaced in 00009) was missed — any authenticated
-- user can currently call supabase.rpc('increment_ai_usage', { ... }) from
-- the frontend and inflate any stripe_customer_id's usage counter.
--
-- After 00043 revoked INSERT/UPDATE/DELETE on public.ai_usage from
-- authenticated, this RPC is the only remaining write path to ai_usage —
-- so this gap is now load-bearing for usage-counter integrity.
--
-- The sole legitimate caller is supabase/functions/_shared/ai-usage.ts,
-- which uses getAdminClient() (service_role) — unaffected by this REVOKE.

REVOKE EXECUTE ON FUNCTION public.increment_ai_usage(TEXT, DATE, NUMERIC) FROM public, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.increment_ai_usage(TEXT, DATE, NUMERIC) TO service_role;
