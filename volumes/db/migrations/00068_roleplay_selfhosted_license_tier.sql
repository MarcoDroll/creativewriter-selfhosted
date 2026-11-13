-- Closes issue #187: a self-hosted install with a validated Premium license was still
-- capped like an unlicensed self-hosted Basic user, because cw_current_tier() (00067)
-- maps EVERY self-hosted instance to 'basic' unconditionally -- SQL cannot see a license
-- key, which is validated per-request in the stripe Edge Function (Ed25519 JWT, never
-- persisted anywhere the trigger reads).
--
-- This gives that Edge Function a place to persist what it already proved. The write
-- happens ONLY from `validateJwtAndGetSubscription` in supabase/functions/_shared/
-- stripe-helpers.ts (via `persistSelfHostedLicenseValidation` in _shared/license.ts),
-- and ONLY when that runtime is NOT the genuine hosted instance
-- (`!isGenuineHostedInstance()`, the same secret-possession gate the hosted-trust check
-- already uses elsewhere in that file) -- never from anything the client can reach
-- directly. That gating is load-bearing, not decoration: the license-key check runs
-- BEFORE the hosted-trust gate in that function (self-hosted needs it to work when the
-- Stripe/subscription_cache path is deliberately failed closed there), so without this
-- table being written from inside the self-hosted-only branch, a leaked license key
-- sent to the REAL hosted instance's /stripe/verify could otherwise turn a transient,
-- per-request "premium" response into a row a SQL trigger trusts for up to a year.
--
-- ============================================================================
-- The table
-- ============================================================================
-- One row per self-hosted Supabase auth user who has ever presented a currently-valid
-- Premium license. `expires_at` mirrors the license JWT's own `exp` claim (1 year from
-- issuance today) -- cw_current_tier() checks it live rather than this migration ever
-- needing to clean up stale rows. An expired row is simply inert, not deleted: harmless,
-- and re-validating (the client re-sends the header on every /stripe/verify call) upserts
-- a fresh expires_at without needing a delete-then-insert.
create table if not exists public.cw_license_validations (
  user_id      uuid primary key,
  tier         text not null,
  expires_at   timestamptz not null,
  validated_at timestamptz not null default now()
);

alter table public.cw_license_validations enable row level security;

-- Backend-managed, per coding-standards.md's GRANT convention: only the stripe Edge
-- Function's service-role connection ever writes here, and only cw_current_tier()
-- (SECURITY DEFINER) ever reads it. No frontend `.from()` call exists or should exist --
-- the author's own Roleplay UI already resolves their effective tier from
-- SubscriptionService, which correctly sees the license client-side; this table exists
-- solely so the DATABASE can agree, for the one control (the tier-cap trigger) that
-- cannot ask the client.
GRANT ALL ON TABLE public.cw_license_validations TO service_role;

-- ============================================================================
-- cw_current_tier(): check a validated self-hosted license before the blanket mapping
-- ============================================================================
-- Body-only change, stable return type -- CREATE OR REPLACE is safe per
-- coding-standards.md's migration-replay-safety rules (a return-type change would need
-- DROP FUNCTION first; this isn't one).
create or replace function public.cw_current_tier()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    -- A self-hosted install whose Edge Function has verified a currently-valid Premium
    -- license resolves to 'premium' here, before the self-hosted->basic mapping below
    -- ever runs -- closing #187 without weakening the mapping for anyone who hasn't
    -- validated a license. See this file's header for why the write side is safe.
    (select 'premium'
       from public.cw_license_validations
      where user_id = auth.uid()
        and tier = 'premium'
        and expires_at > now()),
    -- Self-hosted is basic, matching subscription.service.ts's none -> basic mapping.
    (select 'basic'
       from public.cw_instance_config
      where key = 'self_hosted' and value = 'true'),
    (select sc.tier
       from public.subscription_cache sc
       join public.stripe_customers cust
         on cust.stripe_customer_id = sc.stripe_customer_id
      where cust.user_id = auth.uid()),
    'unknown'
  );
$$;
