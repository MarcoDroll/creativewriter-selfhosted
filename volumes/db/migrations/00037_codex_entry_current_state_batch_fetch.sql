-- Migration: Batched per-entry current-state read
--
-- Used by Phase B merge to fetch the PRIOR current_state for many entries in
-- a single round-trip instead of N serial `codex_entry_current_state` reads.
-- Returned rows include `entry_id` so the client can group results by entry;
-- entries with no existing current_state row are simply absent from the
-- response (null priorState on the client side).
--
-- Mirrors the shape of `get_codex_entry_scene_states_for_entries` (00036)
-- for symmetry.

create or replace function public.get_codex_entry_current_states_for_entries(p_entry_ids uuid[])
returns table (
  entry_id         uuid,
  story_id         uuid,
  state            text,
  hooks            text,
  last_scene_id    uuid,
  last_scene_title text,
  model_id         text,
  updated_at       timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select
    cecs.entry_id,
    cecs.story_id,
    cecs.state,
    cecs.hooks,
    cecs.last_scene_id,
    cecs.last_scene_title,
    cecs.model_id,
    cecs.updated_at
  from public.codex_entry_current_state cecs
  where cecs.entry_id = any(p_entry_ids)
    and cecs.user_id  = auth.uid();
$$;

grant execute on function public.get_codex_entry_current_states_for_entries(uuid[]) to authenticated;
