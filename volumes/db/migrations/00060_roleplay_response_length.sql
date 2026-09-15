-- 00060_roleplay_response_length.sql
--
-- An Arc records how much room its character's replies have.
--
-- The prompt said "one to four short paragraphs" above a rule forbidding scenery and
-- scene-setting outright, which between them leave a model dialogue and gesture and nothing
-- else to write. Raising the token cap alone changed nothing — 1200 was never reached. So the
-- length becomes a property of the Arc, picking between three graded versions of *both* rules,
-- and travels with the perspective and the persona snapshot for the same reason: a chain whose
-- replies change length mid-way reads as two different books.
--
-- Replay-safe: `add column if not exists` only.
--
-- **The default IS the backfill.** Postgres 11+ stores a non-volatile column default in the
-- catalogue and serves it for pre-existing rows without rewriting the table, so every Arc
-- already in play reads as 'medium' with no UPDATE pass — deliberately longer replies than they
-- have been getting, which is the point of the change.
--
-- **No check constraint**, for 00058's reason: the client is the only writer and
-- `parseResponseLength` in `roleplay.mappers.ts` coerces anything it does not recognise back to
-- 'medium'. A constraint would turn an unreadable value into a failed session load instead of a
-- session that reads normally. No GRANTs either — `roleplay_arcs` already carries them.

alter table public.roleplay_arcs
  add column if not exists response_length text not null default 'medium';

comment on column public.roleplay_arcs.response_length is
  'How long the character''s replies are: short | medium | long. Unknown values are read as medium.';
