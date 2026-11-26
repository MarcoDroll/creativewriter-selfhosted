-- 00059_roleplay_home_indexes.sql
--
-- Two indexes for the Roleplay home, which is the first surface to read these tables WITHOUT a
-- story or an Arc in hand.
--
-- Roleplay shipped reachable only from inside a story's editor, so every read was already
-- narrowed: `idx_roleplay_arcs_lookup` leads with `story_id`, and `idx_roleplay_sessions_one_open`
-- leads with `arc_id`. Neither can serve a `user_id`-only predicate — a leading column is not
-- optional.
--
-- **What that costs is not "a small per-user scan".** RLS filters rows AFTER the planner has
-- chosen how to find them, so without a usable index these two queries are a sequential scan of
-- the WHOLE table across every user on the instance, on the app's new second home screen. That is
-- the reason this migration exists rather than being left for later.
--
-- Replay-safe: `create index if not exists` only, no data touched.

-- Arcs by owner, newest first — `listAllArcs()`.
create index if not exists idx_roleplay_arcs_user
  on public.roleplay_arcs(user_id, updated_at desc);

-- Every Arc's open tip, by owner — `listOpenSessions()`. Partial, because "open" is a small and
-- permanently small slice: an Arc has at most one open session at a time, so this indexes roughly
-- one row per Arc rather than one per session.
create index if not exists idx_roleplay_sessions_user_open
  on public.roleplay_sessions(user_id) where sealed_at is null;
