-- 00050: find_orphaned_cover_objects RPC — audit doc 17 option B (global cover janitor).
--
-- Per-story reconcile-on-picker-open (option A, shipped alongside the 00047 gallery)
-- only reclaims orphaned covers/ objects for the ONE story whose picker the user
-- actually opens; a story never re-opened keeps its orphan until story/account delete.
-- This RPC lets the frontend sweep EVERY story in a single round-trip: it returns each
-- covers/ object in the public story-media bucket that belongs to the caller
-- (auth.uid()), is older than the grace window, and is NOT referenced by any
-- cover_gallery[].path across the caller's stories. The frontend then batch-removes the
-- returned paths via the Storage API — which purges BOTH the storage.objects row AND the
-- S3 bytes; a bare SQL `delete from storage.objects` would leak the bytes, so the actual
-- deletion deliberately stays client-side and this function is read-only.
--
-- SECURITY: SECURITY DEFINER so the body can read storage.objects (normally RLS-hidden
-- from `authenticated`), but every predicate is scoped to auth.uid(), so a caller only
-- ever receives their OWN orphan paths; the follow-up client remove() is itself
-- RLS-guarded. p_min_age_seconds mirrors the frontend COVER_ORPHAN_MIN_AGE_MS
-- (default 300 s = 5 min): an object whose cover_gallery write hasn't committed yet is
-- younger than the window and is spared, so the janitor never races an in-flight add.
-- The effective window is floored at 60 s (greatest(coalesce(param,300),60)) so a direct
-- caller can't pass 0/NULL to collapse the race guard against their own in-flight uploads.
-- Correctness invariant that makes deletion safe: every cover object is written once at a
-- unique UUID path, and an object only ever transitions referenced → unreferenced (a
-- re-add uses a NEW path), so an aged + currently-unreferenced object can never become
-- referenced again ⇒ removing it can never destroy a live cover.
--
-- Idempotency: sole definition of this callable, stable `returns setof text` (no
-- return-type change across migrations ⇒ no `drop function` needed; check:migrations is
-- satisfied by the plain `create or replace function`). New GRANT to authenticated,
-- matching the RPC convention (00020/00037). storage.objects + storage.foldername are
-- available in every migration context (see 00014 / the docker 99-storage-setup.sql).

create or replace function public.find_orphaned_cover_objects(p_min_age_seconds integer default 300)
returns setof text
language sql
security definer
set search_path = public
stable
as $$
  with referenced as (
    select ci.path
    from public.stories s
    cross join lateral jsonb_to_recordset(
      case when jsonb_typeof(s.cover_gallery) = 'array' then s.cover_gallery else '[]'::jsonb end
    ) as ci(path text)
    where s.user_id = auth.uid()
      and ci.path is not null
  )
  select o.name
  from storage.objects o
  where o.bucket_id = 'story-media'
    -- Range bounds (NOT `name like auth.uid()||'/%'`): a LIKE prefix built from a
    -- non-constant (auth.uid()) is not rewritten to an index range, so it would
    -- filter-scan the WHOLE bucket across all users. Explicit >=/< bounds pushed into
    -- storage's `idx_objects_bucket_id_name` btree → O(this user's objects). The
    -- `COLLATE "C"` is load-bearing on BOTH counts: (1) that index keys `name COLLATE "C"`,
    -- so the range only becomes an Index Cond (not a Filter) when the predicate collation
    -- matches — verified via EXPLAIN; (2) C-collation is byte order, where '0' (0x30) is
    -- the next byte after '/' (0x2F), so [uid/ , uid0) brackets exactly the `uid/` prefix
    -- regardless of the DB's default (linguistic) collation.
    and o.name collate "C" >= (auth.uid()::text || '/')
    and o.name collate "C" <  (auth.uid()::text || '0')
    and (storage.foldername(o.name))[1] = auth.uid()::text  -- authoritative owner guard (collation-independent)
    and (storage.foldername(o.name))[3] = 'covers'          -- {userId}/{storyId}/covers/<file>
    and o.created_at < now() - make_interval(secs => greatest(coalesce(p_min_age_seconds, 300), 60))
    and not exists (select 1 from referenced r where r.path = o.name)
  limit 100;   -- bound the result + the client remove() batch; a larger backlog self-heals over sessions
$$;

grant execute on function public.find_orphaned_cover_objects(integer) to authenticated;
