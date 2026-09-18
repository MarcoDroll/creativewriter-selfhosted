-- 00070: stories.cover_thumb — a card-sized copy of the active cover, plus the
-- `list_cover` computed column the story list reads.
--
-- WHY. The card's cover box is 180px tall (`story-list.component.scss`), and it was
-- being handed the full active cover: up to 1024px on its longest side and 250 KB
-- (`COVER_MAX_SIZE_KB` / `COVER_MAX_DIMENSION` in `shared/services/cover-image.service.ts`),
-- which measured 263 KB average as base64 on dev. That budget is right where the
-- cover is shown large — the editor header and the cover picker — and about five
-- times too generous for a card. Issue #225, after #223 stopped the list from
-- fetching every cover at once.
--
-- `cover_thumb` holds the same bytes at 960px / ~80 KB, written by whichever code
-- writes `cover_image`; the pair is always set together (see `coverColumns()` in
-- `cover-image.service.ts`), so the thumb can never describe a cover the story no
-- longer has.
--
-- Nullable, no default, so adding it is a catalogue change — no table rewrite, no
-- ACCESS EXCLUSIVE lock on the rows carrying the cover bytes. **No backfill:** a
-- thumb cannot be made in SQL (it is a canvas operation), and a client-side sweep
-- would fire the `set_updated_at` trigger on every story — which the story list
-- orders by and `story-list`'s preview cache keys on, so it would reshuffle the
-- author's list to save bytes. Thumbs therefore appear as covers are set, and
-- `list_cover` falls back to the full cover until then.
--
-- `list_cover(stories)` is a PostgREST computed column like `has_cover` (00069):
-- `coalesce(cover_thumb, cover_image)`, so ONE column carries the right bytes and
-- the response never holds both. Selecting the two columns separately would send
-- the thumb AND the full cover for every row that has a thumb, which is the
-- opposite of the point.
--
-- The thumb is deliberately NOT fed back into `Story.coverImage`: the editor, the
-- picker, the snapshot writer and the exporter all read that field, and a 960px
-- copy round-tripping through any of them would quietly replace the author's cover
-- with a downscale of itself. `list_cover` is for display-only reads.
--
-- Not SECURITY DEFINER; `search_path` pinned empty (the body resolves no object
-- names), which also keeps the linter's `function_search_path_mutable` advisory
-- clean.
--
-- Idempotency: `add column if not exists` + `create or replace function` with a
-- stable return type, so a replay against an already-migrated schema (the
-- Migrations E2E "stuck-user" nightly) is a true no-op. Mirrors 00047 and 00069.
-- No new GRANTs on the table — the 00042 grants cover new columns.

alter table public.stories add column if not exists cover_thumb text;

comment on column public.stories.cover_thumb is
  'Card-sized copy of cover_image (~960px / 80 KB), for the story list. Written ONLY together with cover_image — see coverColumns() in cover-image.service.ts. Null means "no thumb yet"; list_cover() then falls back to cover_image.';

create or replace function public.list_cover(story public.stories)
returns text
language sql
stable
parallel safe
set search_path = ''
as $$
  select coalesce(story.cover_thumb, story.cover_image);
$$;

grant execute on function public.list_cover(public.stories) to authenticated;
grant execute on function public.list_cover(public.stories) to service_role;
