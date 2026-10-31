-- Migration: Roleplay group scenes — more than one character in a scene
--
-- A session held exactly one character. Three-way conversations are ordinary in novels, so a
-- session now holds a roster.
--
-- `roleplay_sessions.characters` is the roster: a jsonb array of `{"id", "name"}` in the order
-- the author picked them, snapshotting the name the way `character_name` already does — a codex
-- entry can be renamed or deleted, and a transcript that rewrites who was in it is worse than a
-- stale copy.
--
-- **`character_id` / `character_name` stay, and are now DERIVED**: they are the first entry of
-- `characters`, denormalized so `idx_roleplay_sessions_character` and the codex card's
-- "most recent Arc for this character" lookup keep working against a plain column. Same idiom as
-- the denormalized `user_id` on child tables. The client writes both from one source; nothing
-- reads `character_id` as "the character of this scene" any more.
--
-- `roleplay_messages.character_id` says WHICH character spoke an assistant turn. Null on user
-- turns, and null on assistant turns written before this migration — a solo scene has only one
-- possible speaker, so absence resolves to the session's roster head rather than being a gap.
--
-- One speaker per turn, by design: a model asked to write "everyone" writes the author's lines
-- too, which is the one thing the format rules forbid absolutely.
--
-- Replay-safe: `add column if not exists`, and the backfill matches nothing on a second run.

-- ============================================================================
-- SESSIONS — the roster
-- ============================================================================

alter table public.roleplay_sessions
  add column if not exists characters jsonb not null default '[]'::jsonb;

-- ============================================================================
-- MESSAGES — who spoke this turn
-- ============================================================================

alter table public.roleplay_messages
  add column if not exists character_id text;

-- ============================================================================
-- BACKFILL — every existing session becomes a one-character roster
--
-- The `set_updated_at` trigger is disabled around it. `updated_at` is not decoration on this
-- table: it is the token the client compares on every conditional summary/seal write, so bumping
-- it under a session someone has open would fail their next write with `stale-write` for a change
-- they did not make. `lock_timeout` makes a lock conflict fail fast and roll back rather than
-- convoying every waiting query behind the ALTER, which holds SHARE ROW EXCLUSIVE to end of
-- transaction.
--
-- Guarded as one DO block so a mid-body failure rolls back the disable — never leave a path where
-- `set_updated_at` stays off.
-- ============================================================================

DO $migration$
BEGIN
  SET LOCAL lock_timeout = '2s';

  ALTER TABLE public.roleplay_sessions DISABLE TRIGGER set_updated_at;

  UPDATE public.roleplay_sessions
     SET characters = jsonb_build_array(
           jsonb_build_object('id', character_id, 'name', character_name)
         )
   WHERE characters = '[]'::jsonb;

  ALTER TABLE public.roleplay_sessions ENABLE TRIGGER set_updated_at;
END $migration$;
