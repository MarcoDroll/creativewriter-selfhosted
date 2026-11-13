-- Consolidate codex entry storyRole into metadata.storyRole and drop the legacy column.
--
-- Background: codex_entries.story_role and metadata->>'storyRole' both stored the
-- same value, written and read inconsistently across the codebase. The codex UI,
-- beat-AI, and most AI context paths use metadata.storyRole; the rest is now
-- aligned with that. This migration backfills any data that lives only in the
-- column and then drops the column.
--
-- Idempotency: guarded so a replay after the column has already been dropped
-- (e.g. stuck-user _cw_migrations recovery) is a no-op. Mirrors the pattern
-- used by 00009_simplify_ai_usage_monthly.sql.

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'codex_entries'
      AND column_name = 'story_role'
  ) THEN
    -- Backfill: copy story_role into metadata.storyRole where metadata doesn't already have it.
    UPDATE public.codex_entries
    SET metadata = jsonb_set(
      COALESCE(metadata, '{}'::jsonb),
      '{storyRole}',
      to_jsonb(story_role)
    )
    WHERE story_role IS NOT NULL
      AND story_role <> ''
      AND COALESCE(metadata->>'storyRole', '') = '';

    -- Drop the now-redundant column.
    ALTER TABLE public.codex_entries DROP COLUMN story_role;
  END IF;
END
$migration$;
