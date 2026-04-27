-- CreativeWriter Supabase Schema Migration
-- Replaces PouchDB/CouchDB with PostgreSQL + RLS

-- ============================================================================
-- PROFILES (auto-created via Supabase Auth trigger)
-- ============================================================================

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  display_name text,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Users can read own profile"
  on public.profiles for select using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  base_username text;
  final_username text;
  attempt int := 0;
begin
  base_username := coalesce(
    new.raw_user_meta_data->>'username',
    split_part(new.email, '@', 1)
  );
  final_username := base_username;

  loop
    insert into public.profiles (id, username, display_name, email)
    values (
      new.id,
      final_username,
      coalesce(
        new.raw_user_meta_data->>'display_name',
        new.raw_user_meta_data->>'full_name',
        split_part(new.email, '@', 1)
      ),
      new.email
    )
    on conflict (username) do nothing;

    exit when found;

    attempt := attempt + 1;
    if attempt >= 20 then
      raise exception 'Could not generate unique username for %', new.email;
    end if;

    final_username := base_username || '_' || substr(md5(random()::text), 1, 4);
  end loop;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- STORIES
-- ============================================================================

create table public.stories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Untitled Story',
  settings jsonb default '{}',
  codex_id uuid,
  cover_image text,
  "order" integer not null default 0,
  schema_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_stories_user_id on public.stories(user_id);

alter table public.stories enable row level security;

create policy "Users own their stories"
  on public.stories for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================================
-- CHAPTERS
-- ============================================================================

create table public.chapters (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.stories(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New Chapter',
  "order" integer not null default 0,
  chapter_number integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_chapters_story_id on public.chapters(story_id);
create index idx_chapters_user_id on public.chapters(user_id);

alter table public.chapters enable row level security;

create policy "Users own their chapters"
  on public.chapters for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================================
-- SCENES
-- ============================================================================

create table public.scenes (
  id uuid primary key default gen_random_uuid(),
  chapter_id uuid not null references public.chapters(id) on delete cascade,
  story_id uuid not null references public.stories(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New Scene',
  content text not null default '',
  summary text,
  summary_generated_at timestamptz,
  "order" integer not null default 0,
  scene_number integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_scenes_chapter_id on public.scenes(chapter_id);
create index idx_scenes_story_id on public.scenes(story_id);
create index idx_scenes_user_id_story_id on public.scenes(user_id, story_id);

alter table public.scenes enable row level security;

create policy "Users own their scenes"
  on public.scenes for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================================
-- CODEXES
-- ============================================================================

create table public.codexes (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.stories(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Codex',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(story_id)
);

create index idx_codexes_story_id on public.codexes(story_id);
create index idx_codexes_user_id on public.codexes(user_id);

alter table public.codexes enable row level security;

create policy "Users own their codexes"
  on public.codexes for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================================
-- CODEX CATEGORIES
-- ============================================================================

create table public.codex_categories (
  id uuid primary key default gen_random_uuid(),
  codex_id uuid not null references public.codexes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  description text,
  icon text,
  "order" integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_codex_categories_codex_id on public.codex_categories(codex_id);
create index idx_codex_categories_user_id on public.codex_categories(user_id);

alter table public.codex_categories enable row level security;

create policy "Users own their codex categories"
  on public.codex_categories for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================================
-- CODEX ENTRIES
-- ============================================================================

create table public.codex_entries (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.codex_categories(id) on delete cascade,
  codex_id uuid not null references public.codexes(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  content text not null default '',
  tags text[] default '{}',
  portrait_gallery jsonb default '[]',
  active_portrait_id text,
  metadata jsonb default '{}',
  story_role text default '',
  always_include boolean default false,
  "order" integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_codex_entries_category_id on public.codex_entries(category_id);
create index idx_codex_entries_codex_id on public.codex_entries(codex_id);
create index idx_codex_entries_user_id on public.codex_entries(user_id);

alter table public.codex_entries enable row level security;

create policy "Users own their codex entries"
  on public.codex_entries for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================================
-- SCENE CHATS
-- ============================================================================

create table public.scene_chats (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.stories(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  history_id text not null,
  title text,
  messages jsonb not null default '[]',
  selected_scenes jsonb default '[]',
  include_story_outline boolean default false,
  include_codex_context boolean default false,
  selected_model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_scene_chats_story_id on public.scene_chats(story_id);
create index idx_scene_chats_user_id on public.scene_chats(user_id);

alter table public.scene_chats enable row level security;

create policy "Users own their scene chats"
  on public.scene_chats for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================================
-- CHARACTER CHATS
-- ============================================================================

create table public.character_chats (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.stories(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id text not null,
  character_name text not null,
  history_id text not null,
  title text,
  messages jsonb not null default '[]',
  selected_model text,
  knowledge_cutoff jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_character_chats_story_id on public.character_chats(story_id);
create index idx_character_chats_user_id on public.character_chats(user_id);

alter table public.character_chats enable row level security;

create policy "Users own their character chats"
  on public.character_chats for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================================
-- STORY RESEARCH
-- ============================================================================

create table public.story_research (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.stories(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  research_id text not null,
  task text not null,
  model text not null,
  scene_findings jsonb not null default '[]',
  summary text,
  status text not null default 'completed',
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_story_research_story_id on public.story_research(story_id);
create index idx_story_research_user_id on public.story_research(user_id);

alter table public.story_research enable row level security;

create policy "Users own their story research"
  on public.story_research for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================================
-- STORY SNAPSHOTS
-- ============================================================================

create table public.story_snapshots (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.stories(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  snapshot_id text not null,
  retention_tier text not null default 'granular',
  expires_at timestamptz,
  snapshot_type text not null default 'auto',
  triggered_by text not null default 'scheduler',
  reason text,
  snapshot_data jsonb not null,
  related_documents jsonb,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_story_snapshots_story_id on public.story_snapshots(story_id);
create index idx_story_snapshots_user_id on public.story_snapshots(user_id);
create index idx_story_snapshots_created_at on public.story_snapshots(created_at);

alter table public.story_snapshots enable row level security;

create policy "Users own their story snapshots"
  on public.story_snapshots for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================================
-- BEAT HISTORIES
-- ============================================================================

create table public.beat_histories (
  id uuid primary key default gen_random_uuid(),
  beat_id text not null,
  story_id uuid not null references public.stories(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  versions jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(beat_id, user_id)
);

create index idx_beat_histories_story_id on public.beat_histories(story_id);
create index idx_beat_histories_user_id on public.beat_histories(user_id);
create index idx_beat_histories_beat_id on public.beat_histories(beat_id);

alter table public.beat_histories enable row level security;

create policy "Users own their beat histories"
  on public.beat_histories for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================================
-- STORY IMAGES (metadata only; binary in Supabase Storage)
-- ============================================================================

create table public.story_images (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.stories(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  image_id text not null,
  name text not null,
  mime_type text not null,
  size integer not null,
  width integer,
  height integer,
  video_id text,
  storage_path text not null,
  created_at timestamptz not null default now()
);

create index idx_story_images_story_id on public.story_images(story_id);
create index idx_story_images_user_id on public.story_images(user_id);

alter table public.story_images enable row level security;

create policy "Users own their story images"
  on public.story_images for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================================
-- STORY VIDEOS (metadata only; binary in Supabase Storage)
-- ============================================================================

create table public.story_videos (
  id uuid primary key default gen_random_uuid(),
  story_id uuid not null references public.stories(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  video_id text not null,
  name text not null,
  mime_type text not null,
  size integer not null,
  storage_path text not null,
  created_at timestamptz not null default now()
);

create index idx_story_videos_story_id on public.story_videos(story_id);
create index idx_story_videos_user_id on public.story_videos(user_id);

alter table public.story_videos enable row level security;

create policy "Users own their story videos"
  on public.story_videos for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================================
-- CUSTOM BACKGROUNDS (metadata only; binary in Supabase Storage)
-- ============================================================================

create table public.custom_backgrounds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  background_id text not null,
  name text not null,
  filename text not null,
  content_type text not null,
  size integer not null,
  storage_path text not null,
  created_at timestamptz not null default now()
);

create index idx_custom_backgrounds_user_id on public.custom_backgrounds(user_id);

alter table public.custom_backgrounds enable row level security;

create policy "Users own their custom backgrounds"
  on public.custom_backgrounds for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================================
-- UPDATED_AT TRIGGER (auto-update timestamps)
-- ============================================================================

create or replace function public.update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- Apply to all tables with updated_at
create trigger set_updated_at before update on public.profiles for each row execute function public.update_updated_at();
create trigger set_updated_at before update on public.stories for each row execute function public.update_updated_at();
create trigger set_updated_at before update on public.chapters for each row execute function public.update_updated_at();
create trigger set_updated_at before update on public.scenes for each row execute function public.update_updated_at();
create trigger set_updated_at before update on public.codexes for each row execute function public.update_updated_at();
create trigger set_updated_at before update on public.codex_categories for each row execute function public.update_updated_at();
create trigger set_updated_at before update on public.codex_entries for each row execute function public.update_updated_at();
create trigger set_updated_at before update on public.scene_chats for each row execute function public.update_updated_at();
create trigger set_updated_at before update on public.character_chats for each row execute function public.update_updated_at();
create trigger set_updated_at before update on public.story_research for each row execute function public.update_updated_at();
create trigger set_updated_at before update on public.beat_histories for each row execute function public.update_updated_at();
create trigger set_updated_at before update on public.story_snapshots for each row execute function public.update_updated_at();

-- ============================================================================
-- STORAGE BUCKETS
-- ============================================================================
-- Run these via Supabase Dashboard or supabase CLI:
--
-- Storage bucket: story-media (public)
--   Path pattern: {user_id}/{story_id}/images/{imageId}.{ext}
--   Path pattern: {user_id}/{story_id}/videos/{videoId}.{ext}
--
-- Storage bucket: user-backgrounds (private)
--   Path pattern: {user_id}/{backgroundId}.{ext}
--
-- Storage policies (apply via Dashboard):
--   Users can only access their own {user_id}/ folder.

-- Storage buckets and policies are created by a separate init script
-- (99-storage-setup.sql) because the storage schema may not exist at
-- DB init time — it is created by the storage service on first boot.

-- ============================================================================
-- REALTIME PUBLICATION
-- ============================================================================
-- Enable Supabase Realtime for tables that need cross-device/cross-tab sync.
-- Without this, postgres_changes subscriptions receive no events.

alter publication supabase_realtime add table
  public.stories,
  public.chapters,
  public.scenes,
  public.codexes,
  public.codex_categories,
  public.codex_entries,
  public.scene_chats,
  public.character_chats;
-- Compute beat history statistics server-side to avoid transferring
-- the entire `versions` JSONB column to the client.
create or replace function public.get_beat_history_stats()
returns table (
  total_histories bigint,
  total_versions bigint,
  total_size bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  select
    count(*)::bigint,
    coalesce(sum(
      case when jsonb_typeof(bh.versions) = 'array'
           then jsonb_array_length(bh.versions)
           else 0
      end
    ), 0)::bigint,
    coalesce(sum(pg_column_size(bh.*)), 0)::bigint
  from public.beat_histories bh
  where bh.user_id = auth.uid();
end;
$$;

grant execute on function public.get_beat_history_stats() to authenticated;
-- Migration: Replace Cloudflare KV with Postgres tables for Stripe/subscription data
-- These tables are only accessed by the service role (Edge Functions), not by end users.

-- 1. stripe_customers — replaces KV `email:{email}` entries
CREATE TABLE IF NOT EXISTS stripe_customers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  CONSTRAINT stripe_customers_email_key UNIQUE (email),
  CONSTRAINT stripe_customers_stripe_customer_id_key UNIQUE (stripe_customer_id),
  CONSTRAINT stripe_customers_user_id_key UNIQUE (user_id)
);

ALTER TABLE stripe_customers ENABLE ROW LEVEL SECURITY;

-- Users can read their own row
CREATE POLICY stripe_customers_select_own ON stripe_customers
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- Only service role can INSERT/UPDATE/DELETE (no policy = deny for authenticated)

-- 2. subscription_cache — replaces KV `stripe:{customerId}` entries
CREATE TABLE IF NOT EXISTS subscription_cache (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  stripe_customer_id TEXT NOT NULL REFERENCES stripe_customers(stripe_customer_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'none',
  tier TEXT NOT NULL DEFAULT 'none',
  plan TEXT,
  price_id TEXT,
  subscription_id TEXT,
  current_period_end BIGINT NOT NULL DEFAULT 0,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  trial_end BIGINT,
  cached_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  CONSTRAINT subscription_cache_stripe_customer_id_key UNIQUE (stripe_customer_id)
);

ALTER TABLE subscription_cache ENABLE ROW LEVEL SECURITY;

-- No RLS policies = only service role can access

-- 3. ai_usage — single accumulator row per customer per calendar month
CREATE TABLE IF NOT EXISTS ai_usage (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  stripe_customer_id TEXT NOT NULL REFERENCES stripe_customers(stripe_customer_id) ON DELETE CASCADE,
  cycle_month DATE NOT NULL,
  total_cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  last_updated TIMESTAMPTZ DEFAULT now() NOT NULL,
  CONSTRAINT ai_usage_customer_cycle_key UNIQUE (stripe_customer_id, cycle_month)
);

ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;

-- No RLS policies = only service role can access

-- Note: UNIQUE constraints above already create indexes on email, stripe_customer_id,
-- and (stripe_customer_id, cycle_month). No additional indexes needed.

-- Atomic usage increment — avoids read-modify-write race conditions
CREATE OR REPLACE FUNCTION increment_ai_usage(
  p_customer_id TEXT,
  p_cycle_month DATE,
  p_cost NUMERIC
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO ai_usage (stripe_customer_id, cycle_month, total_cost_usd, request_count, last_updated)
  VALUES (p_customer_id, p_cycle_month, p_cost, 1, now())
  ON CONFLICT (stripe_customer_id, cycle_month)
  DO UPDATE SET
    total_cost_usd = ai_usage.total_cost_usd + EXCLUDED.total_cost_usd,
    request_count = ai_usage.request_count + 1,
    last_updated = now();
END;
$$;

-- Server-side word count to avoid fetching all scene content.
-- Strips HTML tags, splits by whitespace, sums across all scenes.
CREATE OR REPLACE FUNCTION public.get_story_word_count(p_story_id uuid)
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH scene_text AS (
    SELECT trim(regexp_replace(content, '<[^>]+>', ' ', 'g')) AS plain_text
    FROM public.scenes
    WHERE story_id = p_story_id
      AND user_id = auth.uid()
      AND content IS NOT NULL
      AND content != ''
  )
  SELECT COALESCE(SUM(
    array_length(regexp_split_to_array(plain_text, '\s+'), 1)
  ), 0)::bigint
  FROM scene_text
  WHERE plain_text != '';
$$;

GRANT EXECUTE ON FUNCTION public.get_story_word_count(uuid) TO authenticated;

-- Bulk word count RPC to eliminate N+1 queries in story list.
-- Accepts an array of story IDs, returns (story_id, word_count) rows.
-- Stories with 0 words are omitted; TypeScript defaults missing IDs to 0.
CREATE OR REPLACE FUNCTION public.get_story_word_counts(p_story_ids uuid[])
RETURNS TABLE (story_id uuid, word_count bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH scene_text AS (
    SELECT s.story_id,
           trim(regexp_replace(s.content, '<[^>]+>', ' ', 'g')) AS plain_text
    FROM public.scenes s
    WHERE s.story_id = ANY(p_story_ids)
      AND s.user_id = auth.uid()
      AND s.content IS NOT NULL
      AND s.content != ''
  )
  SELECT st.story_id,
         COALESCE(SUM(
           array_length(regexp_split_to_array(st.plain_text, '\s+'), 1)
         ), 0)::bigint AS word_count
  FROM scene_text st
  WHERE st.plain_text != ''
  GROUP BY st.story_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_story_word_counts(uuid[]) TO authenticated;

-- Per-chapter word count RPC for story statistics modal.
-- Same HTML-stripping + word-counting logic as get_story_word_count, grouped by chapter_id.
-- Chapters with 0 words are omitted; TypeScript defaults missing chapters to 0.
CREATE OR REPLACE FUNCTION public.get_story_chapter_stats(p_story_id uuid)
RETURNS TABLE (chapter_id uuid, word_count bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH scene_text AS (
    SELECT s.chapter_id,
           trim(regexp_replace(s.content, '<[^>]+>', ' ', 'g')) AS plain_text
    FROM public.scenes s
    WHERE s.story_id = p_story_id
      AND s.user_id = auth.uid()
      AND s.content IS NOT NULL
      AND s.content != ''
  )
  SELECT st.chapter_id,
         COALESCE(SUM(
           array_length(regexp_split_to_array(st.plain_text, '\s+'), 1)
         ), 0)::bigint AS word_count
  FROM scene_text st
  WHERE st.plain_text != ''
  GROUP BY st.chapter_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_story_chapter_stats(uuid) TO authenticated;

-- Per-scene word count RPC for story-structure sidebar.
CREATE OR REPLACE FUNCTION public.get_story_scene_stats(p_story_id uuid)
RETURNS TABLE (scene_id uuid, word_count bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH scene_text AS (
    SELECT s.id AS scene_id,
           trim(regexp_replace(s.content, '<[^>]+>', ' ', 'g')) AS plain_text
    FROM public.scenes s
    WHERE s.story_id = p_story_id
      AND s.user_id = auth.uid()
      AND s.content IS NOT NULL
      AND s.content != ''
  )
  SELECT st.scene_id,
         COALESCE(
           array_length(regexp_split_to_array(st.plain_text, '\s+'), 1),
           0
         )::bigint AS word_count
  FROM scene_text st
  WHERE st.plain_text != '';
$$;

GRANT EXECUTE ON FUNCTION public.get_story_scene_stats(uuid) TO authenticated;
