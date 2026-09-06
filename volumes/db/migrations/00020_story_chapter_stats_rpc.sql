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
