-- Composite index for efficient snapshot queries filtered by type.
-- Used by: auto-prune (oldest auto-snapshot), count-by-type, bootstrap latest auto-snapshot time.
CREATE INDEX IF NOT EXISTS idx_story_snapshots_story_user_type
  ON public.story_snapshots(story_id, user_id, snapshot_type, created_at);
