-- Migration: Codex Entry State Snapshots
-- Tracks per-scene state of codex entries (characters, locations, world, etc.).
-- One snapshot per (entry_id, scene_id); re-running state tracking UPSERTs.
--
-- Also adds a partial unique index to enforce at-most-one "world" codex entry
-- per story (the singleton world entry exposed by state tracking).

-- ============================================================================
-- TABLE
-- ============================================================================

create table public.codex_entry_state_snapshots (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.codex_entries(id) on delete cascade,
  scene_id uuid not null references public.scenes(id) on delete cascade,
  chapter_id uuid not null references public.chapters(id) on delete cascade,
  story_id uuid not null references public.stories(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  scene_title text not null,
  state text not null,
  model_id text,
  extracted_at timestamptz not null default now(),
  unique (entry_id, scene_id)
);

create index idx_cess_entry_id on public.codex_entry_state_snapshots(entry_id);
create index idx_cess_story_id on public.codex_entry_state_snapshots(story_id);
create index idx_cess_scene_id on public.codex_entry_state_snapshots(scene_id);

-- ============================================================================
-- RLS
-- ============================================================================

alter table public.codex_entry_state_snapshots enable row level security;

create policy "Users own their state snapshots"
  on public.codex_entry_state_snapshots for all
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ============================================================================
-- WORLD ENTRY SINGLETON
-- ============================================================================

-- One world entry per codex (and therefore per story, since each story has one codex).
-- codex_entries.story_id does not exist as a column; the story linkage is via codex_id.
create unique index idx_codex_entries_one_world_per_codex
  on public.codex_entries(codex_id)
  where (metadata->>'type' = 'world');

-- ============================================================================
-- UPSERT RPC
-- ============================================================================

create or replace function public.upsert_codex_state_snapshot(
  p_entry_id uuid,
  p_scene_id uuid,
  p_chapter_id uuid,
  p_story_id uuid,
  p_scene_title text,
  p_state text,
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
    (entry_id, scene_id, chapter_id, story_id, user_id, scene_title, state, model_id, extracted_at)
  values
    (p_entry_id, p_scene_id, p_chapter_id, p_story_id, auth.uid(),
     p_scene_title, p_state, p_model_id, now())
  on conflict (entry_id, scene_id) do update
    set state = excluded.state,
        scene_title = excluded.scene_title,
        model_id = excluded.model_id,
        extracted_at = now()
  returning * into r;

  return r;
end;
$$;

grant execute on function public.upsert_codex_state_snapshot(
  uuid, uuid, uuid, uuid, text, text, text
) to authenticated;
