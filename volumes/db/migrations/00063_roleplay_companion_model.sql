-- Migration: the companion's own model, per session
--
-- The companion is the author-facing advisor beside a roleplay scene. Its model was settable only
-- as a GLOBAL setting (`roleplayCompanion.selectedModel`) that had no UI at all — reachable by
-- hand-editing localStorage and nothing else. This column makes the pick per session, which is the
-- scope the feature actually wants: advice about a scene should follow that scene.
--
-- The global setting survives as the middle link of the chain rather than being replaced:
--   session.companion_model → roleplayCompanion.selectedModel → session.selected_model → global
-- Each answers a different question — this scene's advisor, my usual advisor, whatever the scene
-- runs on. Resolved in `RoleplayCompanionStore.companionModel()`; `model-default-resolution.ts`
-- structurally cannot express the third link, because no chain there can see a session.
--
-- A COLUMN, not a key inside `companion_state`, following 00058/00060/00062: there is exactly one
-- value per session and it is always read with the session row. `companion_state` would be the
-- wrong home for a second reason — that blob is the TRACKER's output, written by a background AI
-- call under a conditional `updated_at` write designed to lose races. An author's deliberate model
-- pick has no business sharing a cell with something built to be discarded.
--
-- NULL and empty string both mean "not pinned", and the reader trims before testing — the same
-- shape `selected_model` (00056) already has on this table, whose sibling this is.
--
-- No check constraint: a model id is an opaque `provider:model_id` string whose valid set changes
-- whenever a provider's catalogue does. A constraint would turn a newly-renamed model into a
-- failed write on a live table.
--
-- No GRANTs: `roleplay_sessions` already has them, and a column inherits its table's.
--
-- Replay-safe: `add column if not exists`.

alter table public.roleplay_sessions
  add column if not exists companion_model text;

comment on column public.roleplay_sessions.companion_model is
  'The model this session''s COMPANION runs on, as `provider:model_id`. Null or empty means not '
  'pinned, and the chain falls through to the global `roleplayCompanion.selectedModel` setting, '
  'then to this row''s `selected_model` (the scene''s own model), then to the global default — see '
  'RoleplayCompanionStore.companionModel(). Distinct from `selected_model`, which is the model the '
  'SCENE is played on: the advisor and the character need not be the same model, and a cheap '
  'advisor beside an expensive character is the point.';
