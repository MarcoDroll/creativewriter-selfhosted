-- 00043_tighten_backend_table_grants.sql
-- Tighten 00042's uniform Data API grants on four backend-managed tables.
-- Audited 2026-05-13: the Angular frontend never queries these tables
-- directly; Edge Functions use service_role exclusively. The wide
-- INSERT/UPDATE/DELETE grants from 00042 are a footgun if a future
-- accidental permissive RLS policy is added. Narrow to least-privilege.
--
-- admin_users (00019): RLS enabled, zero policies — service_role only by
--   design. Revoke everything from authenticated.
-- audit_log, subscription_cache, ai_usage (00011): RLS SELECT-own policy
--   exists — preserve SELECT for any future "show me my own data" UI,
--   drop the unused write grants.
--
-- REVOKE is idempotent (no error if the grant is already absent), so
-- this is safe to re-run on a DB that has already converged.

REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_users         FROM authenticated;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.audit_log                   FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.subscription_cache          FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.ai_usage                    FROM authenticated;
