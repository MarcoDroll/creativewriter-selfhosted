-- Drop the single-story word count RPC; the total is now derived
-- client-side from per-scene stats (get_story_scene_stats).
-- DROP FUNCTION revokes all grants automatically, so an explicit REVOKE
-- before DROP would fail on idempotent re-runs (function already gone).
DROP FUNCTION IF EXISTS public.get_story_word_count(uuid);
