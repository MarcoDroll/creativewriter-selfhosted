-- Migration: Per-scene snapshot cleanup RPC.
--
-- The unique (entry_id, scene_id) constraint from 00027 already enforces
-- "at most one snapshot per (entry, scene)". This RPC adds the reciprocal
-- guarantee the service needs at tracking time: if a codex entry no longer
-- appears in a scene, no snapshot for that (entry, scene) pair is allowed
-- to linger.
--
-- Called from CodexStateTrackingService.trackSingle after the relevance
-- filter decides which entries are present in the scene's current content.
-- Everything outside that set gets deleted for this scene. Passing an empty
-- keep-set deletes every snapshot for the scene (used when the scene has no
-- content at all).

create or replace function public.delete_codex_state_snapshots_for_scene_except(
  p_scene_id uuid,
  p_keep_entry_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  -- Caller must own the scene. Without this guard a malicious caller could
  -- purge another user's snapshots by supplying a foreign scene id (RLS on
  -- the snapshots table would still protect rows, but being explicit beats
  -- relying on the `user_id = auth.uid()` filter alone).
  if not exists (
    select 1 from public.scenes
    where id = p_scene_id and user_id = auth.uid()
  ) then
    raise exception 'Access denied: scene not owned by caller';
  end if;

  delete from public.codex_entry_state_snapshots
  where scene_id = p_scene_id
    and user_id = auth.uid()
    and (
      p_keep_entry_ids is null
      or array_length(p_keep_entry_ids, 1) is null
      or entry_id <> all(p_keep_entry_ids)
    );

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function public.delete_codex_state_snapshots_for_scene_except(uuid, uuid[])
  to authenticated;
