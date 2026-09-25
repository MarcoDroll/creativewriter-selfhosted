-- Per-scene word count RPC for story-structure sidebar.
-- Same HTML-stripping + word-counting logic as get_story_chapter_stats, but per scene (no GROUP BY).
-- Scenes with 0 words are omitted; TypeScript defaults missing scenes to 0.
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
