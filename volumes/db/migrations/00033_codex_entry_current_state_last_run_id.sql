-- Migration: Codex Entry Current State — add last_run_id
--
-- Adds a `last_run_id` column to `codex_entry_current_state` so the client
-- can distinguish entries updated in the most recent tracking run from
-- entries preserved from a prior run (the prune-fix keeps those rows).
--
-- Backwards-compat strategy for the live-deploy window: keep the old 7-arg
-- `upsert_codex_entry_current_state` as a wrapper that forwards to the new
-- 8-arg version with p_last_run_id = NULL. This ensures that a mid-walk
-- old-client call during deploy writes successfully (row just shows up as
-- "not in last run" until the next run restamps it). A future migration
-- can drop the 7-arg wrapper once the frontend rollout is complete.

-- ============================================================================
-- COLUMN
-- ============================================================================

alter table public.codex_entry_current_state
  add column if not exists last_run_id uuid;

-- ============================================================================
-- UPSERT RPC — new 8-arg signature with p_last_run_id
-- ============================================================================

create or replace function public.upsert_codex_entry_current_state(
  p_entry_id uuid,
  p_story_id uuid,
  p_state text,
  p_hooks text,
  p_last_scene_id uuid,
  p_last_scene_title text,
  p_model_id text,
  p_last_run_id uuid
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
    (entry_id, story_id, user_id, state, hooks, last_scene_id, last_scene_title, model_id, last_run_id, updated_at)
  values
    (p_entry_id, p_story_id, auth.uid(), p_state, p_hooks, p_last_scene_id, p_last_scene_title, p_model_id, p_last_run_id, now())
  on conflict (entry_id) do update
    set state = excluded.state,
        hooks = excluded.hooks,
        last_scene_id = excluded.last_scene_id,
        last_scene_title = excluded.last_scene_title,
        model_id = excluded.model_id,
        last_run_id = excluded.last_run_id,
        updated_at = now()
  returning * into r;

  return r;
end;
$$;

grant execute on function public.upsert_codex_entry_current_state(
  uuid, uuid, text, text, uuid, text, text, uuid
) to authenticated;

-- ============================================================================
-- BACKWARDS-COMPAT WRAPPER — old 7-arg signature forwards to 8-arg with NULL
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
language sql
security definer
set search_path = public
as $$
  select public.upsert_codex_entry_current_state(
    p_entry_id,
    p_story_id,
    p_state,
    p_hooks,
    p_last_scene_id,
    p_last_scene_title,
    p_model_id,
    null::uuid
  );
$$;

grant execute on function public.upsert_codex_entry_current_state(
  uuid, uuid, text, text, uuid, text, text
) to authenticated;
