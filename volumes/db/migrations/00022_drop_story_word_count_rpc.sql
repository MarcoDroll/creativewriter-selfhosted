-- Drop the single-story word count RPC; the total is now derived
-- client-side from per-scene stats (get_story_scene_stats).
REVOKE EXECUTE ON FUNCTION public.get_story_word_count(uuid) FROM authenticated;
DROP FUNCTION IF EXISTS public.get_story_word_count(uuid);
