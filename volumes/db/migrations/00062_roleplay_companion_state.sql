-- Migration: the companion's tracked note
--
-- The companion keeps a running read of the scene — what each party wants, where it seems to be
-- heading, what is unresolved, and what the author could do next. It is refreshed by its own AI
-- call every few exchanges and rendered read-only in the panel.
--
-- A COLUMN, not a table, following 00058/00060: there is exactly one note per session, it is
-- always read with the session row, and it is never queried on its own.
--
-- No check constraint, deliberately. The value is parsed by an untrusted coercer
-- (`parseCompanionState`) that returns the empty state for anything it does not recognise — so an
-- unreadable value costs a note, not a session load. A constraint would turn the same bad value
-- into a failed write on a live table.
--
-- No GRANTs: `roleplay_sessions` already has them, and a column inherits its table's.
--
-- Replay-safe: `add column if not exists`.

alter table public.roleplay_sessions
  add column if not exists companion_state jsonb;

comment on column public.roleplay_sessions.companion_state is
  'The roleplay companion''s tracked note: { motivations: [{name, wants}], goals, hooks[], moves[], generatedAtSeq }. '
  'Written by RoleplayArcService.updateCompanionState, which is CONDITIONAL on updated_at like the '
  'summary and seal writes — a bare patch here would clobber a roll that started after the client '
  'read the row. `generatedAtSeq` is the message seq the note was generated at, so the '
  'every-4-exchanges cadence survives a close and reopen instead of restarting from an in-memory counter.';
