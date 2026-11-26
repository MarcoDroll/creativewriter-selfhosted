-- Migration: Fix position-aware retrieval to use the scene's CURRENT chapter.
--
-- The 00029 version of get_latest_codex_state_snapshots_before_scene joined
-- chapters via the snapshot's stored chapter_id, which freezes at write time.
-- If a user moves a scene to a different chapter after tracking, the query
-- mixed the OLD chapter's order with the scene's NEW order within its new
-- chapter — producing a wrong position.
--
-- Fix: join scenes first, then join chapters via the scene's live chapter_id.
-- This makes chapter/scene reordering AND cross-chapter moves correct at
-- query time without having to rewrite snapshot rows.

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

  -- Join chapters via the SCENE's current chapter_id (sc.chapter_id), not via
  -- the snapshot's stored chapter_id (s.chapter_id). The latter freezes at
  -- tracking time and goes stale when a scene is moved between chapters.
  return query
    with ordered as (
      select s.*,
             c."order" as chapter_order,
             sc."order" as scene_order
      from public.codex_entry_state_snapshots s
      join public.scenes sc on sc.id = s.scene_id
      join public.chapters c on c.id = sc.chapter_id
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
