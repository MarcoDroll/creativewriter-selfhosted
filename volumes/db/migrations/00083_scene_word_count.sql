-- 00083: one word count per scene, written by the client (#1143).
--
-- The story list (get_story_word_counts), the Story Stats modal (get_story_chapter_stats) and the
-- structure panel's unopened scenes (get_story_scene_stats) used to count words here, in SQL:
-- strip tags, split on whitespace. The editor counts the scene it has open with
-- StoryStatsService, which drops beat nodes and decodes entities. A scene's badge therefore
-- changed the moment it was opened, and the three screens could show three totals for one story.
--
-- Now the client writes `scenes.word_count` on every save that writes `content`, from
-- StoryStatsService (the one calculator), and the RPCs read the column instead of `content`.
-- That also takes the detoast of every scene's full text out of each RPC call.
--
-- `null` means "no client count for this row": a scene inserted by a client older than this
-- migration. The RPCs count such a row the old way, in SQL (scene_html_word_count), so its number
-- is exactly what it was before. The backfill below writes that same SQL count into every existing
-- row, so an old scene keeps its current number until it is next saved.
--
-- Known gap, accepted: a save from a client older than 00083 leaves that scene's count stale until
-- a current client saves it. (An older client's UPDATE of `content` does not name `word_count`, so
-- the column keeps the count of the text before it.) The trigger fix, if it ever matters: #1438.
--
-- Replay-safe: the column and its check are added only when the column is missing; the functions
-- are CREATE OR REPLACE with unchanged signatures and return types; the backfill touches only
-- rows still `null`.
--
-- Locks: ADD COLUMN takes ACCESS EXCLUSIVE for an instant, and the backfill's DISABLE TRIGGER holds
-- SHARE ROW EXCLUSIVE (scene writes wait, reads do not) until the migration commits. Inside the
-- file's transaction (docker's migrate.sh wraps it in BEGIN/COMMIT) this timeout covers both: a
-- lock that cannot be had fast fails the migration, rather than queueing every scene read behind
-- it. Run outside a transaction, SET LOCAL is a warning and a no-op, never an error. The backfill is one regex pass over each scene's text: on dev, ~2 MB of scenes in 0.3–0.6 s.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.scenes
  ADD COLUMN IF NOT EXISTS word_count integer CHECK (word_count >= 0);

-- Today's SQL count, unchanged: tags become spaces, the result is trimmed, then split on
-- whitespace. Empty or null content, or content that is only tags, counts 0.
CREATE OR REPLACE FUNCTION public.scene_html_word_count(p_content text)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(
           array_length(
             regexp_split_to_array(
               NULLIF(trim(regexp_replace(COALESCE(p_content, ''), '<[^>]+>', ' ', 'g')), ''),
               '\s+'
             ),
             1
           ),
           0
         )::bigint;
$$;

-- Internal: only the SECURITY DEFINER RPCs below and this migration call it.
REVOKE ALL ON FUNCTION public.scene_html_word_count(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.scene_html_word_count(text) FROM anon, authenticated;

-- Backfill. set_updated_at is off for it so `updated_at` stays what the last save wrote: an open
-- editor compares a Realtime echo's `updated_at` with its own write to tell its saves from another
-- device's (#1108), and a backfill is neither. One block, so a failure rolls the disable back too.
DO $migration$
BEGIN
  ALTER TABLE public.scenes DISABLE TRIGGER set_updated_at;

  UPDATE public.scenes
  SET word_count = public.scene_html_word_count(content)
  WHERE word_count IS NULL;

  ALTER TABLE public.scenes ENABLE TRIGGER set_updated_at;
END
$migration$;

-- Per-scene counts for the structure panel. Scenes with 0 words are omitted; TypeScript defaults
-- missing scenes to 0.
CREATE OR REPLACE FUNCTION public.get_story_scene_stats(p_story_id uuid)
RETURNS TABLE (scene_id uuid, word_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.scene_id, c.word_count
  FROM (
    SELECT s.id AS scene_id,
           CASE
             WHEN s.word_count IS NOT NULL THEN s.word_count::bigint
             ELSE public.scene_html_word_count(s.content)
           END AS word_count
    FROM public.scenes s
    WHERE s.story_id = p_story_id
      AND s.user_id = auth.uid()
  ) c
  WHERE c.word_count > 0;
$$;

GRANT EXECUTE ON FUNCTION public.get_story_scene_stats(uuid) TO authenticated;

-- Per-chapter totals for the Story Stats modal. Chapters with 0 words are omitted.
CREATE OR REPLACE FUNCTION public.get_story_chapter_stats(p_story_id uuid)
RETURNS TABLE (chapter_id uuid, word_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT s.chapter_id,
         SUM(
           CASE
             WHEN s.word_count IS NOT NULL THEN s.word_count::bigint
             ELSE public.scene_html_word_count(s.content)
           END
         )::bigint AS word_count
  FROM public.scenes s
  WHERE s.story_id = p_story_id
    AND s.user_id = auth.uid()
  GROUP BY s.chapter_id
  HAVING SUM(
           CASE
             WHEN s.word_count IS NOT NULL THEN s.word_count::bigint
             ELSE public.scene_html_word_count(s.content)
           END
         ) > 0;
$$;

GRANT EXECUTE ON FUNCTION public.get_story_chapter_stats(uuid) TO authenticated;

-- Per-story totals for the story list, for the ids asked. Stories with 0 words are omitted.
CREATE OR REPLACE FUNCTION public.get_story_word_counts(p_story_ids uuid[])
RETURNS TABLE (story_id uuid, word_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.story_id, SUM(c.word_count)::bigint AS word_count
  FROM (
    SELECT s.story_id,
           CASE
             WHEN s.word_count IS NOT NULL THEN s.word_count::bigint
             ELSE public.scene_html_word_count(s.content)
           END AS word_count
    FROM public.scenes s
    WHERE s.story_id = ANY(p_story_ids)
      AND s.user_id = auth.uid()
  ) c
  GROUP BY c.story_id
  HAVING SUM(c.word_count) > 0;
$$;

GRANT EXECUTE ON FUNCTION public.get_story_word_counts(uuid[]) TO authenticated;
