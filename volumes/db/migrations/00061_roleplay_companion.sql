-- Migration: Roleplay companion — an author-facing advisor beside the scene
--
-- Roleplay has one AI voice and it is in character. The companion is a SECOND
-- conversation over the same context, pointed the other way: it talks to the author,
-- out of character, about what they could do next. Its transcript lives here.
--
-- Deliberately NOT a `channel` column on `roleplay_messages`. Every reader of that
-- table is built on `seq > summary_through_seq` with no LIMIT — see
-- `roleplay-message.service.ts`, which says outright that "a cap here would silently
-- drop turns out of the prompt". Interleaving a second conversation into that sequence
-- would put companion turns inside the scene's prompt window, the summariser's batch and
-- the seal, and the discriminator would then have to be remembered in six places. That is
-- the same argument 00056 already made against reusing `character_chats`.
--
-- Unlike the scene transcript, this one IS read with a plain LIMIT. The distinction is
-- deliberate: the scene transcript is load-bearing for a prompt invariant, whereas the
-- companion's own backscroll is advice — losing the oldest of it costs a re-read, not
-- correctness.
--
-- Like the rest of roleplay, this table is NOT added to `supabase_realtime` (00056:16-18).
-- Two tabs have no liveness signal by design.
--
-- Replay-safe: every create is `if not exists`, every policy and trigger is dropped first.

-- ============================================================================
-- COMPANION MESSAGES — one row per turn side, shaped like roleplay_messages
-- ============================================================================

create table if not exists public.roleplay_companion_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.roleplay_sessions(id) on delete cascade,
  -- Denormalised even though `session_id` reaches it, matching every other roleplay
  -- table: RLS keys on `user_id` directly rather than joining up the chain.
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Assigned max(seq)+1, never count(*) — "Clear advice" deletes rows, and a
  -- count-based value would collide with a survivor. The unique index below catches it.
  -- seq 0 is the opening observation, which is why it is a row and not a UI string:
  -- it is generated once per session and must survive a reopen without spending again.
  seq integer not null,
  role text not null check (role in ('user', 'assistant')),
  text text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Also what makes a two-tab race for the opening observation safe: the loser gets 23505,
-- which the client swallows as "someone else greeted first" rather than surfacing.
create unique index if not exists idx_roleplay_companion_seq
  on public.roleplay_companion_messages(session_id, seq);

-- ============================================================================
-- RLS — owner-only, as on all four roleplay tables
-- ============================================================================

alter table public.roleplay_companion_messages enable row level security;

drop policy if exists "Users own their roleplay companion messages"
  on public.roleplay_companion_messages;
create policy "Users own their roleplay companion messages"
  on public.roleplay_companion_messages for all
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- ============================================================================
-- TRIGGERS — public.update_updated_at() already exists (00001 / 00013)
-- ============================================================================

drop trigger if exists set_updated_at on public.roleplay_companion_messages;
create trigger set_updated_at before update on public.roleplay_companion_messages
  for each row execute function public.update_updated_at();

-- ============================================================================
-- GRANTS — since 2026-05-30 a public table without them is invisible to the Data API
-- (PostgREST 42501). Frontend-facing: the client queries it directly.
-- ============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.roleplay_companion_messages TO authenticated;
GRANT ALL                            ON TABLE public.roleplay_companion_messages TO service_role;
