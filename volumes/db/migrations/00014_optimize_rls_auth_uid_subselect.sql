-- Migration: Optimize RLS policies with (select auth.uid()) subselect
--
-- PostgreSQL re-evaluates auth.uid() per row in USING/WITH CHECK expressions.
-- Wrapping it as (select auth.uid()) causes the planner to evaluate it once as
-- a scalar subquery ("initplan") and cache the result for the entire query.
-- This is the #1 Supabase performance recommendation for RLS.
--
-- PostgreSQL has no ALTER POLICY ... SET USING(...), so policies must be
-- dropped and recreated. Supabase migrations run in an implicit transaction,
-- so there is no window where policies are missing.
--
-- NOT changed: RPC functions (SECURITY DEFINER) in 00002/00004/00005 where
-- auth.uid() is evaluated once by the function execution engine, not per-row.

-- ============================================================================
-- PROFILES (2 policies — uses `id` column, not `user_id`)
-- ============================================================================

DROP POLICY "Users can read own profile" ON public.profiles;
CREATE POLICY "Users can read own profile"
  ON public.profiles FOR SELECT
  USING ((select auth.uid()) = id);

DROP POLICY "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  USING ((select auth.uid()) = id)
  WITH CHECK ((select auth.uid()) = id);

-- ============================================================================
-- 14 USER-CONTENT TABLES (FOR ALL — USING + WITH CHECK on user_id)
-- ============================================================================

DROP POLICY "Users own their stories" ON public.stories;
CREATE POLICY "Users own their stories"
  ON public.stories FOR ALL
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY "Users own their chapters" ON public.chapters;
CREATE POLICY "Users own their chapters"
  ON public.chapters FOR ALL
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY "Users own their scenes" ON public.scenes;
CREATE POLICY "Users own their scenes"
  ON public.scenes FOR ALL
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY "Users own their codexes" ON public.codexes;
CREATE POLICY "Users own their codexes"
  ON public.codexes FOR ALL
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY "Users own their codex categories" ON public.codex_categories;
CREATE POLICY "Users own their codex categories"
  ON public.codex_categories FOR ALL
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY "Users own their codex entries" ON public.codex_entries;
CREATE POLICY "Users own their codex entries"
  ON public.codex_entries FOR ALL
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY "Users own their scene chats" ON public.scene_chats;
CREATE POLICY "Users own their scene chats"
  ON public.scene_chats FOR ALL
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY "Users own their character chats" ON public.character_chats;
CREATE POLICY "Users own their character chats"
  ON public.character_chats FOR ALL
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY "Users own their story research" ON public.story_research;
CREATE POLICY "Users own their story research"
  ON public.story_research FOR ALL
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY "Users own their story snapshots" ON public.story_snapshots;
CREATE POLICY "Users own their story snapshots"
  ON public.story_snapshots FOR ALL
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY "Users own their beat histories" ON public.beat_histories;
CREATE POLICY "Users own their beat histories"
  ON public.beat_histories FOR ALL
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY "Users own their story images" ON public.story_images;
CREATE POLICY "Users own their story images"
  ON public.story_images FOR ALL
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY "Users own their story videos" ON public.story_videos;
CREATE POLICY "Users own their story videos"
  ON public.story_videos FOR ALL
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY "Users own their custom backgrounds" ON public.custom_backgrounds;
CREATE POLICY "Users own their custom backgrounds"
  ON public.custom_backgrounds FOR ALL
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

-- ============================================================================
-- STORAGE (2 policies — uses auth.uid()::text cast)
-- ============================================================================

DROP POLICY "Users access own story media" ON storage.objects;
CREATE POLICY "Users access own story media"
  ON storage.objects FOR ALL
  USING (bucket_id = 'story-media' AND (storage.foldername(name))[1] = (select auth.uid()::text))
  WITH CHECK (bucket_id = 'story-media' AND (storage.foldername(name))[1] = (select auth.uid()::text));

DROP POLICY "Users access own backgrounds" ON storage.objects;
CREATE POLICY "Users access own backgrounds"
  ON storage.objects FOR ALL
  USING (bucket_id = 'user-backgrounds' AND (storage.foldername(name))[1] = (select auth.uid()::text))
  WITH CHECK (bucket_id = 'user-backgrounds' AND (storage.foldername(name))[1] = (select auth.uid()::text));

-- ============================================================================
-- STRIPE CUSTOMERS (1 policy — FROM 00003)
-- ============================================================================

DROP POLICY stripe_customers_select_own ON stripe_customers;
CREATE POLICY stripe_customers_select_own ON stripe_customers
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

-- ============================================================================
-- BACKEND-ONLY SELECT POLICIES (3 policies — FROM 00011)
-- ============================================================================

-- ai_usage — subquery JOIN pattern
DROP POLICY ai_usage_select_own ON ai_usage;
CREATE POLICY ai_usage_select_own ON ai_usage
  FOR SELECT TO authenticated
  USING (
    stripe_customer_id = (
      SELECT sc.stripe_customer_id
      FROM stripe_customers sc
      WHERE sc.user_id = (select auth.uid())
    )
  );

-- subscription_cache — subquery JOIN pattern
DROP POLICY subscription_cache_select_own ON subscription_cache;
CREATE POLICY subscription_cache_select_own ON subscription_cache
  FOR SELECT TO authenticated
  USING (
    stripe_customer_id = (
      SELECT sc.stripe_customer_id
      FROM stripe_customers sc
      WHERE sc.user_id = (select auth.uid())
    )
  );

-- audit_log — direct pattern
DROP POLICY audit_log_select_own ON audit_log;
CREATE POLICY audit_log_select_own ON audit_log
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);
