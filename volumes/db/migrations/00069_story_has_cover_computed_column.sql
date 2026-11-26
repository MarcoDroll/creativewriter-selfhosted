-- 00069: has_cover(stories) — a PostgREST computed column, so the story list can
-- reserve a cover box without selecting the cover bytes.
--
-- WHY. `stories.cover_image` holds the ACTIVE cover as inline base64 (00047), and
-- `StoryService.getAllStories` selected it for up to 50 rows at a time: ~13 MB of
-- egress to open the story list once (measured on dev 2026-09-18 — 263 KB average
-- per cover, 512 KB largest), against a 5 GB free-tier month. See issue #223 and
-- `.claude/rules/supabase-cost.md`.
--
-- The list itself only needs to know WHETHER a story has a cover, so it can keep
-- the card's 180px cover box (and the header's `with-cover` spacing) from jumping
-- when the image lands. The bytes are fetched per card as it scrolls into view.
--
-- A FUNCTION, not a generated column, on purpose: `alter table … add column …
-- generated always as (…) stored` rewrites every row under an ACCESS EXCLUSIVE
-- lock, and these are the rows that carry the cover bytes. A function costs
-- nothing at rest, changes no row, and adds nothing to the whole-row Realtime
-- broadcast that 00047 was careful about.
--
-- PostgREST exposes a function whose single argument is a table's row type as a
-- selectable column on that table: `select=id,title,has_cover`.
--
-- Not SECURITY DEFINER — invoker rights are all this needs, and the row it reads
-- is one RLS already returned. `search_path` is pinned empty anyway because the
-- body resolves no object names, which also keeps the Supabase linter's
-- `function_search_path_mutable` advisory clean.
--
-- Idempotency: `create or replace function` with a stable return type, so a
-- replay against an already-migrated schema (the Migrations E2E "stuck-user"
-- nightly) is a true no-op. `GRANT` is idempotent on its own.

create or replace function public.has_cover(story public.stories)
returns boolean
language sql
stable
parallel safe
set search_path = ''
as $$
  select story.cover_image is not null;
$$;

grant execute on function public.has_cover(public.stories) to authenticated;
grant execute on function public.has_cover(public.stories) to service_role;
