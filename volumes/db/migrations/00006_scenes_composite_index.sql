-- Composite index on scenes(user_id, story_id) optimizes:
-- 1. get_story_word_count/get_story_word_counts RPCs
-- 2. All RLS-filtered scene queries that also filter by story_id
--
-- Drops redundant single-column idx_scenes_user_id since
-- the composite index covers user_id-only lookups via its leading column.

CREATE INDEX IF NOT EXISTS idx_scenes_user_id_story_id
  ON public.scenes (user_id, story_id);

DROP INDEX IF EXISTS idx_scenes_user_id;
