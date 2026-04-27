-- Migration: Per-scene codex entry state snapshots
--
-- Supports the two-phase state tracking pipeline:
--   Phase A (Extract): each scene is tracked in isolation and produces one
--     (entry_id, scene_id) snapshot per relevant codex entry.
--   Phase B (Merge):   per-entry merge folds all snapshots into the existing
--     `codex_entry_current_state` row — one coherent cumulative summary.
--
-- This table is the durable per-scene history. It decouples scenes from each
-- other (extraction becomes parallelisable) and gives the UI a per-scene
-- history to render without re-running the LLM. `codex_entry_current_state`
-- remains the single source of truth consumed by the writer prompts.

-- ============================================================================
-- TABLE — one row per (entry, scene)
-- ============================================================================

create table public.codex_entry_scene_states (
  entry_id   uuid not null references public.codex_entries(id) on delete cascade,
  scene_id   uuid not null references public.scenes(id)        on delete cascade,
  story_id   uuid not null references public.stories(id)       on delete cascade,
  user_id    uuid not null references auth.users(id)           on delete cascade,
  state      text not null,
  hooks      text,
  model_id   text,
  extracted_at timestamptz not null default now(),
  primary key (entry_id, scene_id)
);

create index idx_cess_story on public.codex_entry_scene_states(story_id);
create index idx_cess_scene on public.codex_entry_scene_states(scene_id);
create index idx_cess_user  on public.codex_entry_scene_states(user_id);

-- ============================================================================
-- RLS
-- ============================================================================

alter table public.codex_entry_scene_states enable row level security;

create policy "cess_owner_all"
  on public.codex_entry_scene_states for all
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ============================================================================
-- UPSERT — one (entry, scene) snapshot
-- ============================================================================

create or replace function public.upsert_codex_entry_scene_state(
  p_entry_id uuid,
  p_scene_id uuid,
  p_story_id uuid,
  p_state    text,
  p_hooks    text,
  p_model_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.codex_entries
    where id = p_entry_id and user_id = auth.uid()
  ) then
    raise exception 'Access denied: codex entry not owned by caller';
  end if;

  insert into public.codex_entry_scene_states
    (entry_id, scene_id, story_id, user_id, state, hooks, model_id, extracted_at)
  values
    (p_entry_id, p_scene_id, p_story_id, auth.uid(), p_state, p_hooks, p_model_id, now())
  on conflict (entry_id, scene_id) do update
    set state = excluded.state,
        hooks = excluded.hooks,
        model_id = excluded.model_id,
        extracted_at = now();
end;
$$;

grant execute on function public.upsert_codex_entry_scene_state(uuid, uuid, uuid, text, text, text) to authenticated;

-- ============================================================================
-- READ — per-scene history for an entry, ordered by story position
-- ============================================================================

create or replace function public.get_codex_entry_scene_states(p_entry_id uuid)
returns table (
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
  where css.entry_id = p_entry_id
    and css.user_id  = auth.uid()
  order by c."order", s."order";
$$;

grant execute on function public.get_codex_entry_scene_states(uuid) to authenticated;
