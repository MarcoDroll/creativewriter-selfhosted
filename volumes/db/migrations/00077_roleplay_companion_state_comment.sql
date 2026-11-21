-- The companion's column comment, rewritten for what the column holds now (#838).
--
-- 00062 described the v1 tracked note (motivations, goals, hooks, moves, refreshed every few
-- exchanges by a tracker). Since the companion became Read | Ask the column holds the v2 Read, written
-- only when the author taps Read or Refresh, or picks a path. The shape is the client's
-- (RoleplayCompanionState); no data changes here.
--
-- Replay-safe: `comment on column` replaces the comment, so a second apply is a no-op.

comment on column public.roleplay_sessions.companion_state is
  'The roleplay companion''s Read of the scene, version 2: { version: 2, readId, wants: [{name, wants}], '
  'tension, paths: [{title, sketch}], advice[], generatedAtSeq, readTurns?: [{seq, hash}], '
  'pick?: { choice: {kind: path, index} or {kind: own, text}, options: [{id, scene, direction}] } }. '
  'Written only when the author asks (Read, Refresh, a picked path, an edited or deleted option), never '
  'on a turn, by RoleplayArcService.updateCompanionState, which is CONDITIONAL on updated_at like the '
  'summary and seal writes. A value without version 2 (a v1 tracked note) reads as no Read; the next '
  'tap replaces it. generatedAtSeq and readTurns tell the panel how stale the Read is.';
