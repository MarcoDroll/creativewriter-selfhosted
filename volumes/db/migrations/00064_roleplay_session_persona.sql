-- Migration: who you are playing, per session
--
-- The persona was picked once, when the Arc was created, and frozen for the Arc's whole life —
-- `RoleplayArcService.updateArc` refused to change it and the new-session form only STATED it.
-- The stated reason (roleplay.doc.md) was that "a chain whose person changes mid-way reads as two
-- different characters", which is a real cost. It is accepted deliberately here: an Arc can run
-- for a hundred sessions, and the author wants to decide who they are as each one starts.
--
-- `roleplay_arcs.persona_*` STAYS and is still picked at Arc creation — but it is now only the
-- DEFAULT a new session starts on. Nothing reads it during play. These three columns are the
-- value in play: the scene prompt, the companion prompt, the summariser, the seal editor and
-- every "You are playing …" line read them, through `sessionPersona(session, arc)`.
--
-- Three columns mirroring `roleplay_arcs`, not a jsonb blob, following 00058/00060/00062/00063:
-- there is exactly one persona per session and it is always read with the session row.
--
-- `persona_id` keeps the Arc's `on delete set null`: the snapshot travels even when the library
-- row is gone, exactly as `character_chats` carries `character_name` beside `character_id`. A
-- chain that rewrites who you were playing is worse than a stale copy.
--
-- No GRANTs: `roleplay_sessions` already has them, and a column inherits its table's.
--
-- Replay-safe in two halves:
--   * the ALTER uses `add column if not exists`;
--   * the backfill is idempotent BY PREDICATE rather than by an existence guard —
--     `where s.persona_name = '' and s.persona_id is null` excludes every row a previous run
--     filled, and a row whose Arc genuinely has neither is rewritten to the same values, i.e. a
--     true no-op. That is stronger than guarding on the column's existence, which would stop
--     protecting the moment the two steps were ever separated.

alter table public.roleplay_sessions
  add column if not exists persona_id uuid references public.roleplay_personas(id) on delete set null,
  add column if not exists persona_name text not null default '',
  add column if not exists persona_description text not null default '';

comment on column public.roleplay_sessions.persona_id is
  'The library persona this session is played as, when it came from the library. Null for a '
  'one-off persona typed into the form, and null once the library row is deleted — the snapshot '
  'in persona_name/persona_description is what travels. Read through sessionPersona(), which '
  'falls back to the parent Arc''s default for a session written before this migration (or '
  'imported from a .cwx archive written before it).';
comment on column public.roleplay_sessions.persona_name is
  'Who the AUTHOR is playing in this session. Snapshotted, like roleplay_arcs.persona_name. '
  'Empty means "not set on this row" and the parent Arc''s default is used instead.';
comment on column public.roleplay_sessions.persona_description is
  'The persona''s description as it stood when this session started.';

-- Backfill every pre-existing session from its parent Arc, so the fallback is never load-bearing
-- for a row that already exists.
--
-- `updated_at` MUST NOT move. It is the session list's sort key AND the token Re-open's
-- conditional write compares (`RoleplaySessionSummary.updatedAtRaw`) — bumping it would reorder
-- every author's session list and invalidate any in-flight conditional write. So `set_updated_at`
-- is disabled around the UPDATE, the 00051 pattern.
--
-- ALL of it in ONE `DO` block so a mid-body failure rolls the disable back with it: there must be
-- no path where `set_updated_at` stays off.
--
-- `ALTER TABLE … DISABLE TRIGGER` takes SHARE ROW EXCLUSIVE and holds it to the END of the
-- transaction, blocking every write to `roleplay_sessions` (reads still work) for the whole
-- backfill. `lock_timeout` makes a lock conflict fail fast and roll back rather than convoying
-- every waiting query behind it. One UPDATE pass, not one per row.
DO $migration$
BEGIN
  SET LOCAL lock_timeout = '2s';

  ALTER TABLE public.roleplay_sessions DISABLE TRIGGER set_updated_at;

  UPDATE public.roleplay_sessions s
  SET persona_id = a.persona_id,
      persona_name = a.persona_name,
      persona_description = a.persona_description
  FROM public.roleplay_arcs a
  WHERE a.id = s.arc_id
    AND s.persona_name = ''
    AND s.persona_id IS NULL;

  ALTER TABLE public.roleplay_sessions ENABLE TRIGGER set_updated_at;
END $migration$;
