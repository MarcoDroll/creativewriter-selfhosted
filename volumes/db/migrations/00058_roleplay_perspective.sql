-- 00058_roleplay_perspective.sql
--
-- An Arc records the grammatical person its character writes in.
--
-- The prompt template hard-coded first person ("You are playing one session, in first person",
-- "Actions ... in first person: *I set the cup down.*"). A novelist writing in close third wants
-- their character's roleplay to read the same way, so the choice moves onto the Arc: one persona
-- and one perspective for its whole life, the way the persona snapshot already works.
--
-- Replay-safe: `add column if not exists` only, and the default makes every existing Arc first
-- person, which is what they were written under.
--
-- **No check constraint, deliberately.** The client is the only writer and `parsePerspective` in
-- `roleplay.mappers.ts` coerces anything it does not recognise back to 'first' — the same
-- untrusted-parse doctrine `parseSeal` and `parseParticipants` already follow. A constraint would
-- turn an unreadable value into a failed session load instead of a session that reads normally.

alter table public.roleplay_arcs
  add column if not exists perspective text not null default 'first';

comment on column public.roleplay_arcs.perspective is
  'Grammatical person the character writes in: first | third. Unknown values are read as first.';
