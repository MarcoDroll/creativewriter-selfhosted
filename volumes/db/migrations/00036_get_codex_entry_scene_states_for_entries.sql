-- Migration: Batched per-entry scene-state read
--
-- Eliminates the Phase B fan-out where the merge worker pool would call
-- `get_codex_entry_scene_states(entry_id)` once per entry (N round-trips).
-- The new RPC accepts an array of entry ids and returns all their snapshots
-- in one shot; the client groups rows by `entry_id` (included in the output).
--
-- The single-entry `get_codex_entry_scene_states` RPC remains for the
-- history modal, which reads exactly one entry.

create or replace function public.get_codex_entry_scene_states_for_entries(p_entry_ids uuid[])
returns table (
  entry_id      uuid,
  scene_id      uuid,
  scene_title   text,
  chapter_order int,
  scene_order   int,
  state         text,
  hooks         text,
  model_id      text,
  extracted_at  timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select
    css.entry_id,
    s.id,
    s.title,
    c."order"::int,
    s."order"::int,
    css.state,
    css.hooks,
    css.model_id,
    css.extracted_at
  from public.codex_entry_scene_states css
  join public.scenes   s on s.id = css.scene_id
  join public.chapters c on c.id = s.chapter_id
  where css.entry_id = any(p_entry_ids)
    and css.user_id  = auth.uid()
  order by css.entry_id, c."order", s."order";
$$;

grant execute on function public.get_codex_entry_scene_states_for_entries(uuid[]) to authenticated;
