-- Migration: Roleplay — Arcs, sessions, messages and personas
--
-- Roleplay lets an author play a scene *as someone*, against a codex character
-- positioned at a specific point in the manuscript. Its unit is an **Arc**: a named,
-- ordered storyline in one story, played with one persona, holding a list of
-- **sessions** (scenes) of which at most one is open. **Sealing** a session condenses
-- it into five structured fields and freezes it; the seals chain forward.
--
-- Four tables, and deliberately NOT a discriminator on `character_chats`:
--   * `CharacterChatHistoryService` caps rows at 5 per (story, user, character), so
--     sharing that table would silently evict an author's chat histories,
--   * three call sites there hand-list `.select(...)` columns,
--   * `character_chats` is in the `supabase_realtime` publication (00001:467-475) and
--     `alter publication … add table` cannot be re-applied safely.
--
-- `roleplay_sessions` is deliberately NOT added to `supabase_realtime`. Two tabs have
-- no liveness signal by design; concurrent writes to a session's summary/seal fields are
-- guarded by a conditional `updated_at` compare in the client instead.
--
-- Messages are their own rows rather than a jsonb blob on the session: the transcript is
-- kept in full, so a blob would mean rewriting ~100KB per turn on a phone. One row per
-- message makes appends O(1), edits targeted, and "show older" a paginated query.
--
-- Replay-safe: every create is `if not exists`, every policy and trigger is dropped first.

-- ============================================================================
-- PERSONAS — account-scoped, not per story. The library the author plays from.
-- ============================================================================

create table if not exists public.roleplay_personas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text not null default '',
  -- Optional: playing one of your own codex characters. `set null` rather than cascade —
  -- deleting the codex entry must not delete the persona; the snapshot below carries on.
  codex_entry_id uuid references public.codex_entries(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_roleplay_personas_user_id on public.roleplay_personas(user_id);

-- ============================================================================
-- ARCS — one named storyline per story, one persona for its whole life
-- ============================================================================

create table if not exists public.roleplay_arcs (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.stories(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default '',
  persona_id uuid references public.roleplay_personas(id) on delete set null,
  -- Snapshotted the way `character_chats` carries `character_name` beside `character_id`:
  -- a persona is editable and deletable, and a chain that rewrites who you were playing
  -- is worse than a stale copy.
  persona_name text not null default '',
  persona_description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_roleplay_arcs_lookup
  on public.roleplay_arcs(story_id, user_id, updated_at desc);

-- ============================================================================
-- SESSIONS — one scene each
-- ============================================================================

create table if not exists public.roleplay_sessions (
  id uuid primary key default gen_random_uuid(),
  arc_id uuid not null references public.roleplay_arcs(id) on delete cascade,
  story_id uuid not null references public.stories(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- A raw codex entry id with NO foreign key, by design: a session whose character was
  -- deleted opens read-only on the snapshotted name, and its seal still counts in the chain.
  character_id text not null,
  character_name text not null,
  -- No default, matching roleplay_messages.seq below: both are assigned max(...)+1 by
  -- the client, and a forgotten assignment should be a NOT NULL violation rather than a
  -- silent 0 colliding with the first session.
  sequence integer not null,
  sealed_at timestamptz,                  -- null = the Arc's open tip
  premise text not null default '',       -- where/when/what, always in the prompt
  -- {chapterId, sceneId?} — IDS, not orders. Reordering a chapter or deleting a scene
  -- would silently repoint an order-based cutoff; ids are resolved to the current order
  -- when the prompt is built.
  knowledge_cutoff jsonb,
  title text,
  summary text not null default '',       -- the running summary while open
  -- The window boundary, and the reason the whole subsystem is decidable:
  --   prompt = f(summary, summary_through_seq, messages where seq > summary_through_seq)
  -- Deriving it from a message count breaks the first time a roll fails or an edit
  -- deletes rows.
  summary_through_seq integer not null default 0,
  seal jsonb,                             -- the five structured fields, at seal
  -- Codex entry ids told about this scene. IDS ONLY, deliberately — unlike character_id
  -- above, which carries character_name beside it. heard_by is never rendered as a list of
  -- names: the Arc-memory ticks are drawn from the LIVE codex, and the chain filter only
  -- asks whether an id is present. So an id whose entry was deleted matches nothing and
  -- silently drops, which is the wanted behaviour; a stale name snapshot would have to be
  -- reconciled instead. Revisit only if a surface ever displays these names.
  heard_by jsonb not null default '[]',
  selected_model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_roleplay_sessions_arc
  on public.roleplay_sessions(arc_id, sequence);
create index if not exists idx_roleplay_sessions_character
  on public.roleplay_sessions(story_id, user_id, character_id, updated_at desc);

-- "At most one open session per Arc" is a database guarantee, not a UI convention.
-- Two tabs racing to start the second scene: the loser gets 23505, which the client
-- surfaces as "this Arc already has an open scene; seal it first".
create unique index if not exists idx_roleplay_sessions_one_open
  on public.roleplay_sessions(arc_id) where sealed_at is null;

-- ============================================================================
-- MESSAGES — one row per turn side
-- ============================================================================

create table if not exists public.roleplay_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.roleplay_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Assigned max(seq)+1, never count(*): mid-chain delete is a first-class feature and a
  -- count-based value collides with a surviving row. The unique index below catches it.
  seq integer not null,
  role text not null check (role in ('user', 'assistant')),
  scene text,                             -- author: speech + *actions*
  direction text,                         -- author only; never summarised
  variants jsonb,                         -- assistant: the alternates ("retry adds one")
  selected integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists idx_roleplay_messages_seq
  on public.roleplay_messages(session_id, seq);

-- ============================================================================
-- RLS — owner-only on all four
-- ============================================================================

alter table public.roleplay_personas enable row level security;
alter table public.roleplay_arcs     enable row level security;
alter table public.roleplay_sessions enable row level security;
alter table public.roleplay_messages enable row level security;

drop policy if exists "Users own their roleplay personas" on public.roleplay_personas;
create policy "Users own their roleplay personas" on public.roleplay_personas for all
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "Users own their roleplay arcs" on public.roleplay_arcs;
create policy "Users own their roleplay arcs" on public.roleplay_arcs for all
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "Users own their roleplay sessions" on public.roleplay_sessions;
create policy "Users own their roleplay sessions" on public.roleplay_sessions for all
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "Users own their roleplay messages" on public.roleplay_messages;
create policy "Users own their roleplay messages" on public.roleplay_messages for all
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- ============================================================================
-- TRIGGERS — public.update_updated_at() already exists (00001 / 00013)
-- ============================================================================

drop trigger if exists set_updated_at on public.roleplay_personas;
create trigger set_updated_at before update on public.roleplay_personas
  for each row execute function public.update_updated_at();

drop trigger if exists set_updated_at on public.roleplay_arcs;
create trigger set_updated_at before update on public.roleplay_arcs
  for each row execute function public.update_updated_at();

drop trigger if exists set_updated_at on public.roleplay_sessions;
create trigger set_updated_at before update on public.roleplay_sessions
  for each row execute function public.update_updated_at();

drop trigger if exists set_updated_at on public.roleplay_messages;
create trigger set_updated_at before update on public.roleplay_messages
  for each row execute function public.update_updated_at();

-- ============================================================================
-- GRANTS — since 2026-05-30 a public table without them is invisible to the Data API
-- (PostgREST 42501). All four are frontend-facing: the client queries them directly.
-- ============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.roleplay_personas TO authenticated;
GRANT ALL                            ON TABLE public.roleplay_personas TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.roleplay_arcs     TO authenticated;
GRANT ALL                            ON TABLE public.roleplay_arcs     TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.roleplay_sessions TO authenticated;
GRANT ALL                            ON TABLE public.roleplay_sessions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.roleplay_messages TO authenticated;
GRANT ALL                            ON TABLE public.roleplay_messages TO service_role;
