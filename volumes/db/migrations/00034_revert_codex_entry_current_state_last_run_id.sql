-- Migration: Revert last_run_id on codex_entry_current_state
--
-- Rolls forward the 00033 change. The staleness indicator the column fed was
-- an over-built response to a speculative UX concern; a static disclaimer in
-- the modal is sufficient until real users signal otherwise.
--
-- Restores the original 7-arg upsert_codex_entry_current_state (the pre-00033
-- direct implementation, not the NULL-forwarding wrapper).

-- ============================================================================
-- DROP 8-ARG RPC and the 7-arg WRAPPER
-- ============================================================================

drop function if exists public.upsert_codex_entry_current_state(
  uuid, uuid, text, text, uuid, text, text, uuid
);

drop function if exists public.upsert_codex_entry_current_state(
  uuid, uuid, text, text, uuid, text, text
);

-- ============================================================================
-- RESTORE ORIGINAL 7-ARG RPC
-- ============================================================================

create or replace function public.upsert_codex_entry_current_state(
  p_entry_id uuid,
  p_story_id uuid,
  p_state text,
  p_hooks text,
  p_last_scene_id uuid,
  p_last_scene_title text,
  p_model_id text
)
returns public.codex_entry_current_state
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.codex_entry_current_state;
begin
  if not exists (
    select 1 from public.codex_entries
    where id = p_entry_id and user_id = auth.uid()
  ) then
    raise exception 'Access denied: codex entry not owned by caller';
  end if;

  insert into public.codex_entry_current_state
    (entry_id, story_id, user_id, state, hooks, last_scene_id, last_scene_title, model_id, updated_at)
  values
    (p_entry_id, p_story_id, auth.uid(), p_state, p_hooks, p_last_scene_id, p_last_scene_title, p_model_id, now())
  on conflict (entry_id) do update
    set state = excluded.state,
        hooks = excluded.hooks,
        last_scene_id = excluded.last_scene_id,
        last_scene_title = excluded.last_scene_title,
        model_id = excluded.model_id,
        updated_at = now()
  returning * into r;

  return r;
end;
$$;

grant execute on function public.upsert_codex_entry_current_state(
  uuid, uuid, text, text, uuid, text, text
) to authenticated;

-- ============================================================================
-- DROP COLUMN
-- ============================================================================

alter table public.codex_entry_current_state
  drop column if exists last_run_id;
