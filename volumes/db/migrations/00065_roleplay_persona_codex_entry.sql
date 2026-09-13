-- Migration: a persona picked straight from the Codex keeps its link (#115)
--
-- The persona picker offers three kinds of answer: free text, a saved library persona, or one of
-- the author's own Codex characters. The third exists so that the author's side of a session is
-- POSITIONED exactly as the AI's side is — tracked state, author-written Voice, the lot.
--
-- It never was. The picker resolved a `codexEntryId` for that pick, and nothing stored it:
-- `roleplay_arcs` and `roleplay_sessions` carried `persona_id`/`persona_name`/`persona_description`
-- and no codex link, so `RoleplaySessionStore.personaEntryId` found no link and positioned nobody.
-- The name and description were right, so nothing looked wrong. Picking the same character FROM
-- THE LIBRARY worked, because there the link lives on `roleplay_personas.codex_entry_id`.
--
-- One column on each table, named beside the snapshot it belongs to. On BOTH, because the Arc's
-- persona is what every new session's picker opens on (00064): a link stored only on sessions
-- would make the same pick behave differently depending on which of the two forms it was made on.
--
-- ─── Why `text` with NO foreign key, unlike `roleplay_personas.codex_entry_id` ───────────────────
--
-- It mirrors `roleplay_sessions.character_id`, which stores the same kind of id in the same table
-- and is a raw `text` id with no FK on purpose. Two reasons, and the second is the one that bites:
--
--   1. A deleted Codex entry must leave a readable session behind. The snapshot beside this id is
--      what the session is played as; the id only adds positioning, and the store already checks
--      the entry exists in THIS story's codex before using it, degrading to the snapshot if not.
--
--   2. An FK with `on delete set null` is implemented as an UPDATE of the referencing row, and an
--      UPDATE fires `set_updated_at`. Deleting one Codex character would then move `updated_at` on
--      every session that played as them — and `updated_at` is the session list's sort key AND the
--      token Re-open's conditional write compares (`RoleplaySessionSummary.updatedAtRaw`). 00064
--      went to the trouble of disabling that trigger for its backfill for exactly this reason; an
--      FK here would reintroduce the same effect on every codex delete, forever.
--
-- `text` rather than `uuid` for the archive's sake too: a malformed value in a hand-edited `.cwx`
-- is a harmless string that matches nothing, where a `uuid` column would reject the whole session
-- insert and roll back the roleplay import.
--
-- ─── No backfill, deliberately ───────────────────────────────────────────────────────────────────
--
-- The link was never stored, so there is nothing to copy. The only way to recover it would be to
-- match the snapshotted persona name against codex entry titles, which `roleplay-session.store.ts`
-- rejects outright: a rename breaks it, and a title collision drops ANOTHER character's tracked
-- state and voice into the persona slot — worse than degrading to the snapshot. An author whose
-- existing Arc was set up this way re-picks the Codex radio when they next start a session.
--
-- NULL means no direct codex link; the store then falls back to the library row's link, which is
-- the path that already worked.
--
-- No GRANTs: both tables already have them, and a column inherits its table's.
--
-- Replay-safe: `add column if not exists`, and no data is touched.

alter table public.roleplay_arcs
  add column if not exists persona_codex_entry_id text;

alter table public.roleplay_sessions
  add column if not exists persona_codex_entry_id text;

comment on column public.roleplay_arcs.persona_codex_entry_id is
  'The codex entry the Arc''s DEFAULT persona is, when it was picked straight from the Codex rather '
  'than from the persona library. A raw id with no foreign key, like roleplay_sessions.character_id: '
  'an FK''s on-delete action is an UPDATE, which would fire set_updated_at. Null means no direct '
  'link — a library persona carries its link on roleplay_personas.codex_entry_id instead.';

comment on column public.roleplay_sessions.persona_codex_entry_id is
  'The codex entry the author is playing in this session, when picked straight from the Codex. '
  'What positions the persona. A raw id with no foreign key, like character_id beside it: an FK''s '
  'on-delete action is an UPDATE, which would move updated_at — the session list''s sort key and '
  'Re-open''s conditional-write token. Validated against the story''s codex at session open.';
