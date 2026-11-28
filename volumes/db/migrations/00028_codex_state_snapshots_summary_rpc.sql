-- Migration: Codex State Snapshots — Per-Entry Summary RPC
-- Moves the per-entry rollup (count + latest scene) for a story out of the
-- client and into Postgres so mobile clients don't pull every snapshot row
-- to compute a ~20-entry summary. Adds a composite index to serve the
-- DISTINCT ON plan without an in-memory sort.

-- Composite index: supports the RPC's per-entry DISTINCT ON pattern
-- (WHERE story_id = $1 ORDER BY entry_id, extracted_at DESC)
create index if not exists idx_cess_story_entry_extracted
  on public.codex_entry_state_snapshots (story_id, entry_id, extracted_at desc);

-- Per-entry rollup for a story: count + latest scene.
-- Returns one row per codex entry that has at least one snapshot.
-- Ordered newest-first by latest extraction (matches client expectation).
create or replace function public.get_tracked_entries_summary(p_story_id uuid)
returns table (
  entry_id uuid,
  snapshot_count bigint,
  latest_extracted_at timestamptz,
  latest_scene_title text,
  latest_scene_id uuid,
  latest_chapter_id uuid
)
language sql
security definer
set search_path = public
as $$
  with scoped as (
    select s.entry_id, s.scene_id, s.chapter_id, s.scene_title, s.extracted_at
    from public.codex_entry_state_snapshots s
    where s.story_id = p_story_id
      and s.user_id = auth.uid()
  ),
  latest as (
    select distinct on (entry_id)
      entry_id, extracted_at, scene_title, scene_id, chapter_id
    from scoped
    order by entry_id, extracted_at desc
  ),
  counts as (
    select entry_id, count(*)::bigint as snapshot_count
    from scoped
    group by entry_id
  )
  select l.entry_id,
         c.snapshot_count,
         l.extracted_at  as latest_extracted_at,
         l.scene_title   as latest_scene_title,
         l.scene_id      as latest_scene_id,
         l.chapter_id    as latest_chapter_id
  from latest l
  join counts c using (entry_id)
  order by l.extracted_at desc;
$$;

grant execute on function public.get_tracked_entries_summary(uuid) to authenticated;
