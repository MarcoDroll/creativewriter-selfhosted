-- Migration: Codex Entry Current State (single-row-per-entry)
--
-- Replaces the per-scene `codex_entry_state_snapshots` table and every RPC
-- built around it. The new shape stores ONE cumulative current state per
-- codex entry. State tracking becomes a merge: given the entry's existing
-- current state plus the scene being tracked, the AI returns the updated
-- merged state.
--
-- Dropping the old table is safe because state tracking is not yet wired
-- into any generation path; consumers (history modal, tracked-entries modal)
-- are being rewritten alongside this migration.

-- ============================================================================
-- DROP OLD (in dependency order)
-- ============================================================================

drop function if exists public.delete_codex_state_snapshots_for_scene_except(uuid, uuid[]);
drop function if exists public.get_latest_codex_state_snapshots_before_scene(uuid, uuid);
drop function if exists public.get_tracked_entries_summary(uuid);
drop function if exists public.upsert_codex_state_snapshot(uuid, uuid, uuid, uuid, text, text, text, text);
drop function if exists public.upsert_codex_state_snapshot(uuid, uuid, uuid, uuid, text, text, text);
drop table if exists public.codex_entry_state_snapshots;

-- ============================================================================
-- TABLE — one row per codex entry
-- ============================================================================

create table public.codex_entry_current_state (
  entry_id uuid primary key references public.codex_entries(id) on delete cascade,
  story_id uuid not null references public.stories(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  state text not null,
  hooks text,
  last_scene_id uuid references public.scenes(id) on delete set null,
  last_scene_title text,
  model_id text,
  updated_at timestamptz not null default now()
);

create index idx_cecs_story_id on public.codex_entry_current_state(story_id);
create index idx_cecs_user_id on public.codex_entry_current_state(user_id);

-- ============================================================================
-- RLS
-- ============================================================================

alter table public.codex_entry_current_state enable row level security;

create policy "Users own their current-state rows"
  on public.codex_entry_current_state for all
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ============================================================================
-- UPSERT RPC
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
-- STORY-LEVEL PRUNE RPC — drop rows for entries no longer seen in the story.
-- Called once at the end of trackAllScenes with the rolling-map's entry ids.
-- ============================================================================

create or replace function public.delete_codex_entry_current_states_for_story_except(
  p_story_id uuid,
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
  delete from public.codex_entry_current_state
  where story_id = p_story_id
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

grant execute on function public.delete_codex_entry_current_states_for_story_except(uuid, uuid[]) to authenticated;
