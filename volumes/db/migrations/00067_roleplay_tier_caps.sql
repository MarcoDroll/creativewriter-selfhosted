-- Roleplay tier caps — Basic gets one Arc of three sessions; Premium is unlimited.
--
-- Replaces a hard premium gate. The gate itself moves from premium to basic in the client
-- (`PremiumAccessService.checkBasicAccess`); this file is what makes the *cap* mean something,
-- because the gate is client-side by design and a client-side cap would be a suggestion.
--
-- ## What the database can and cannot see — read this before changing the thresholds
--
-- `subscription_cache` is a cache of what STRIPE said, not a register of entitlement:
-- `saveSubscriptionCache` has exactly two callers, both inside `syncStripeData`, so the Stripe
-- webhook is its only writer. Three populations are therefore invisible here:
--
--   * self-hosted      — no Stripe, no row (handled by the `self_hosted` flag below)
--   * license-key      — validated per request against a private key, never persisted
--   * 7-day app trial  — `app_trial` is DELIBERATELY never written to the cache
--                        (see supabase/functions/_shared/stripe-helpers.ts, ~line 311)
--
-- So this enforces ONLY when it positively resolves 'basic'. An unknown tier is allowed through,
-- which is correct for trial and license holders (both are legitimately above the cap) and costs
-- nothing for `none`, who are stopped by the same client gate that stops them today. The cap's
-- one job is to stop a BASIC STRIPE CUSTOMER opening a second Arc — the single population SQL
-- sees perfectly. Widening it to refuse unknown tiers would lock out every trial user.
--
-- ## The cap binds on CREATION ONLY
--
-- It must never hide, lock or delete an Arc anyone already holds. Authors who played under
-- Premium, and anyone who later downgrades, will legitimately sit above the limit. That is a
-- limit; retroactively removing their work would be data loss wearing a limit's clothes.

-- ============================================================================
-- Instance config — how Postgres learns it is a self-hosted install
-- ============================================================================
-- Hosted leaves this empty. Self-hosted seeds ('self_hosted','true') from
-- docker/volumes/db/migrate.sh, which runs on EVERY `docker compose up` — not from
-- init/zz-bootstrap.sh, which runs only at initdb and would therefore miss every install that
-- already exists. Getting that wrong silently demotes existing self-hosters to no allowance.

create table if not exists public.cw_instance_config (
  key   text primary key,
  value text not null
);

alter table public.cw_instance_config enable row level security;

-- Read-only to signed-in users; nothing in the client writes it. Service role manages it.
drop policy if exists "Anyone signed in may read instance config" on public.cw_instance_config;
create policy "Anyone signed in may read instance config"
  on public.cw_instance_config for select
  to authenticated
  using (true);

-- Data API visibility (required since 2026-05-30 — see coding-standards.md)
GRANT SELECT ON TABLE public.cw_instance_config TO authenticated;
GRANT ALL    ON TABLE public.cw_instance_config TO service_role;

-- ============================================================================
-- The caller's tier, as SQL can determine it
-- ============================================================================
-- SECURITY DEFINER because the trigger runs as the inserting user, and `subscription_cache`
-- grants nothing to `authenticated` (00003 gives it no policies at all — service role only).
-- Without DEFINER the join returns nothing for everyone and the cap never fires.
--
-- Returns 'unknown' rather than 'none' for a missing row, and the distinction is load-bearing:
-- 'none' would read as "free user, cap them", but a missing row is equally a trial or a license
-- holder. See the header.

create or replace function public.cw_current_tier()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
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

GRANT EXECUTE ON FUNCTION public.cw_current_tier() TO authenticated;

-- ============================================================================
-- The caps
-- ============================================================================
-- Mirrored in src/app/stories/models/roleplay-limits.ts, which drives the UI. The client copy is
-- advisory (it disables a button and explains the allowance); THIS is the authority. If you change
-- a number here, change it there — and note check:shared-constants cannot see SQL, so nothing
-- catches the drift automatically.

create or replace function public.cw_roleplay_arc_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tier  text;
  v_count integer;
begin
  v_tier := public.cw_current_tier();
  if v_tier is distinct from 'basic' then
    return new;
  end if;

  select count(*) into v_count
    from public.roleplay_arcs
   where user_id = new.user_id;

  if v_count >= 1 then
    raise exception 'roleplay arc cap reached for tier %', v_tier
      using errcode = 'CWA01';
  end if;

  return new;
end;
$$;

create or replace function public.cw_roleplay_session_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tier  text;
  v_count integer;
begin
  v_tier := public.cw_current_tier();
  if v_tier is distinct from 'basic' then
    return new;
  end if;

  select count(*) into v_count
    from public.roleplay_sessions
   where arc_id = new.arc_id;

  if v_count >= 3 then
    raise exception 'roleplay session cap reached for tier %', v_tier
      using errcode = 'CWS01';
  end if;

  return new;
end;
$$;

-- BEFORE INSERT, so the row never lands. Binds every write path — PostgREST, an RPC, a raw
-- token — which is the whole reason this is a trigger rather than a guarded RPC.
drop trigger if exists cw_roleplay_arc_cap on public.roleplay_arcs;
create trigger cw_roleplay_arc_cap before insert on public.roleplay_arcs
  for each row execute function public.cw_roleplay_arc_cap();

drop trigger if exists cw_roleplay_session_cap on public.roleplay_sessions;
create trigger cw_roleplay_session_cap before insert on public.roleplay_sessions
  for each row execute function public.cw_roleplay_session_cap();
