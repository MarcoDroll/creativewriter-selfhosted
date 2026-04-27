-- Migration: Add `hooks` column to codex_entry_state_snapshots.
-- Extends the per-scene state extraction to carry a short set of plot hooks
-- alongside the state noun-phrase. Also exposes a position-aware retrieval
-- RPC so downstream writer-prompt assembly can pick the latest snapshot per
-- entry *by story position* (not by timestamp), optionally bounded to "at or
-- before some anchor scene".

-- ============================================================================
-- COLUMN
-- ============================================================================

alter table public.codex_entry_state_snapshots
  add column hooks text;

-- ============================================================================
-- UPSERT RPC (now 8-arg — includes p_hooks)
-- ============================================================================

-- Drop the old 7-arg signature first so CI catches stale callers.
drop function if exists public.upsert_codex_state_snapshot(uuid, uuid, uuid, uuid, text, text, text);

create or replace function public.upsert_codex_state_snapshot(
  p_entry_id uuid,
  p_scene_id uuid,
  p_chapter_id uuid,
  p_story_id uuid,
  p_scene_title text,
  p_state text,
  p_hooks text,
  p_model_id text
)
returns public.codex_entry_state_snapshots
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.codex_entry_state_snapshots;
begin
  if not exists (
    select 1 from public.codex_entries
    where id = p_entry_id and user_id = auth.uid()
  ) then
    raise exception 'Access denied: codex entry not owned by caller';
  end if;

  if not exists (
    select 1 from public.scenes
    where id = p_scene_id and user_id = auth.uid()
  ) then
    raise exception 'Access denied: scene not owned by caller';
  end if;

  insert into public.codex_entry_state_snapshots
    (entry_id, scene_id, chapter_id, story_id, user_id, scene_title, state, hooks, model_id, extracted_at)
  values
    (p_entry_id, p_scene_id, p_chapter_id, p_story_id, auth.uid(),
     p_scene_title, p_state, p_hooks, p_model_id, now())
  on conflict (entry_id, scene_id) do update
    set state = excluded.state,
        hooks = excluded.hooks,
        scene_title = excluded.scene_title,
        model_id = excluded.model_id,
        extracted_at = now()
  returning * into r;

  return r;
end;
$$;

grant execute on function public.upsert_codex_state_snapshot(
  uuid, uuid, uuid, uuid, text, text, text, text
) to authenticated;

-- ============================================================================
-- POSITION-AWARE LATEST-PER-ENTRY RETRIEVAL RPC
-- ============================================================================
-- Returns the latest snapshot per codex entry by STORY POSITION
-- (chapter.order, scene.order) — not by timestamp — optionally bounded to
-- "at or before" a given anchor scene. Callers pass p_before_scene_id = null
-- to get the latest-per-entry across the entire story.
--
-- RLS is enforced inside the function via `auth.uid()` and the caller is also
-- scoped to their own stories.

create or replace function public.get_latest_codex_state_snapshots_before_scene(
  p_story_id uuid,
  p_before_scene_id uuid default null
)
returns setof public.codex_entry_state_snapshots
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chapter_order integer;
  v_scene_order integer;
begin
  -- Resolve anchor position (if any). Raising on an explicit-but-unresolvable
  -- anchor avoids silently returning an empty set to callers — the alternative
  -- semantics (row-comparison against a zero-row subquery yields NULL → all
  -- rows filtered out) hides real bugs like a stale scene id.
  if p_before_scene_id is not null then
    select c."order", sc."order"
      into v_chapter_order, v_scene_order
      from public.scenes sc
      join public.chapters c on c.id = sc.chapter_id
      where sc.id = p_before_scene_id
        and sc.user_id = auth.uid();
    if not found then
      raise exception 'Anchor scene % not found or not owned by caller', p_before_scene_id
        using errcode = 'no_data_found';
    end if;
  end if;

  -- distinct-on picks the snapshot with the highest (chapter_order, scene_order)
  -- per entry_id — the one closest to (but not after) the anchor within the
  -- already-filtered set. chapter_order takes priority over scene_order, so a
  -- snapshot in chapter 7 always beats one in chapter 5, even if chapter 5
  -- has a higher scene number.
  return query
    with ordered as (
      select s.*,
             c."order" as chapter_order,
             sc."order" as scene_order
      from public.codex_entry_state_snapshots s
      join public.chapters c on c.id = s.chapter_id
      join public.scenes sc on sc.id = s.scene_id
      where s.story_id = p_story_id
        and s.user_id = auth.uid()
        and (
          p_before_scene_id is null
          or (c."order", sc."order") <= (v_chapter_order, v_scene_order)
        )
    )
    select distinct on (entry_id)
      id, entry_id, scene_id, chapter_id, story_id, user_id,
      scene_title, state, hooks, model_id, extracted_at
    from ordered
    order by entry_id, chapter_order desc, scene_order desc;
end;
$$;

grant execute on function public.get_latest_codex_state_snapshots_before_scene(uuid, uuid) to authenticated;
