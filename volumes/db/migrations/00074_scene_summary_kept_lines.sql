-- 00074: Kept lines for a Scene Summary — up to five verbatim lines from the
-- scene, each followed by " — " and a few words on who said it and what it
-- answered. The roleplay seal already keeps them for a sealed session; this
-- gives an outline scene the same, so beat generation's story-so-far keeps a
-- distant scene's voice and callbacks once its events are compressed into a
-- summary.
--
-- A column of its own rather than text appended to `summary`: every current
-- consumer of `summary` (Scene Chat, Character Chat, Roleplay, the outline
-- itself) keeps reading prose and nothing else.
--
-- NULL means none. The client is the real cap (5 lines, 300 characters each,
-- `stories/utils/kept-lines.util.ts`); the check below is only a backstop
-- against a client that does not cap at all, so its total sits above 5 × 300.
--
-- No client SELECT on a hot path names this column — `getStory`,
-- `getStoryOutline` and `getScene` are all read by a frontend that CI deploys
-- in parallel with this migration, so naming it there would 400 every editor
-- open until the migration landed. It is read only through
-- `StoryService.getSceneKeptLines`, which degrades to "no kept lines".
--
-- No new GRANTs: `scenes` is an existing frontend-facing table and already
-- carries the authenticated/service_role grants.
--
-- The constraint is added NOT VALID and validated separately: a plain ADD
-- CONSTRAINT validates under ACCESS EXCLUSIVE, blocking every read and write on
-- `scenes` for a full-table scan, while VALIDATE CONSTRAINT scans under SHARE
-- UPDATE EXCLUSIVE, which blocks neither. Every row is NULL here, so it passes.
--
-- Replay-safe: `add column if not exists`, the constraint guarded by a
-- pg_constraint lookup, VALIDATE a no-op on an already valid constraint, and
-- the COMMENT an unconditional replacement.

ALTER TABLE public.scenes
  ADD COLUMN IF NOT EXISTS summary_kept_lines text[];

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'scenes_summary_kept_lines_cap'
      AND conrelid = 'public.scenes'::regclass
  ) THEN
    ALTER TABLE public.scenes
      ADD CONSTRAINT scenes_summary_kept_lines_cap CHECK (
        summary_kept_lines IS NULL
        OR (
          cardinality(summary_kept_lines) <= 5
          AND char_length(array_to_string(summary_kept_lines, '')) <= 2000
        )
      ) NOT VALID;
  END IF;
END
$migration$;

ALTER TABLE public.scenes VALIDATE CONSTRAINT scenes_summary_kept_lines_cap;

COMMENT ON COLUMN public.scenes.summary_kept_lines IS
  'Up to 5 verbatim lines from the scene, each "<line> — <who said it, what it answered>". NULL means none. Read only through a narrow select, never by the hot story reads.';
