-- 00071: the cover janitor must treat `cover_gallery[].thumbPath` as referenced.
--
-- WHY. 00071's client side (#227) writes TWO objects per cover: the full cover at
-- `{uid}/{storyId}/covers/cover-<uuid>.jpg` and a card-sized copy beside it at
-- `…-thumb.jpg`, whose path is recorded on the gallery item as `thumbPath`. The
-- story list renders the copy, so a public Storage URL (~60 bytes in the response,
-- bytes from the CDN with a year-long cache-control) replaces 80 KB of inline
-- base64 on every read.
--
-- `find_orphaned_cover_objects` (00050) returns every `covers/` object NOT in
-- `cover_gallery[].path`, and the frontend then deletes what it returns. Left
-- as-is it would report every one of those new thumbs as an orphan the moment it
-- aged past the grace window — and the janitor would delete the live thumbnail of
-- every cover the author has. That is the whole reason this migration exists, and
-- why it ships in the same change as the uploads.
--
-- The fix is one `union all`: extract both fields from each gallery item and treat
-- either as a reference. `jsonb_to_recordset`'s column names must match the JSON
-- keys, so `thumbPath` is quoted — the app writes camelCase.
--
-- `path` stays NOT NULL-filtered as before; `thumbPath` is filtered the same way,
-- because it is absent on every item written before this migration (the client
-- omits the key rather than writing null, so an old item simply contributes
-- nothing here).
--
-- Everything else about 00050 is unchanged and its reasoning still applies: the
-- range bounds with `COLLATE "C"` that keep this an index scan over one user's
-- objects rather than a filter scan of the bucket, the `storage.foldername` owner
-- guard, the floored age window that spares an in-flight upload, the `limit 100`,
-- and SECURITY DEFINER with every predicate scoped to `auth.uid()`.
--
-- **Checked, because the failure mode is deletion:** `jsonb_to_recordset` raises
-- `22023 argument of jsonb_to_recordset must be an array of objects` on a malformed
-- entry — it does NOT quietly yield nulls. That matters: nulls would drop a story's
-- real paths out of `referenced`, and its live objects would then be reported as
-- orphans and deleted. An error instead aborts the whole call, the client swallows
-- it (`reconcileAllOrphans` never throws), and nothing is removed. Verified on dev
-- rather than assumed, and it was already true of 00050's single lateral.
--
-- Idempotency: `create or replace function`, same signature, same `returns setof
-- text` — so a replay against an already-migrated schema (the Migrations E2E
-- "stuck-user" nightly) is a true no-op, and `check:migrations` is satisfied
-- without a guarding drop. The 00050 GRANT to `authenticated` survives a replace;
-- it is re-stated here anyway, being idempotent, so a fresh install that somehow
-- skipped 00050 is still correct.

create or replace function public.find_orphaned_cover_objects(p_min_age_seconds integer default 300)
returns setof text
language sql
security definer
set search_path = public
stable
as $$
  with items as (
    select ci.path, ci."thumbPath" as thumb_path
    from public.stories s
    cross join lateral jsonb_to_recordset(
      case when jsonb_typeof(s.cover_gallery) = 'array' then s.cover_gallery else '[]'::jsonb end
    ) as ci(path text, "thumbPath" text)
    where s.user_id = auth.uid()
  ),
  referenced as (
    select path from items where path is not null
    union all
    select thumb_path from items where thumb_path is not null
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
