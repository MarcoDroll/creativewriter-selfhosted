-- 00073: set_story_favorites(story_id, lists) — write a story's model favorites in ONE statement.
--
-- WHY (issue #654). `ModelFavoritesService` used to write a story's favorites as a read-modify-write
-- of `stories.settings`: select the whole JSON, replace the touched lists, update the whole JSON
-- back. Two costs:
--   * a RACE — any whole-settings write landing between the two requests (an illustration style
--     saved in the same second, a title save, the planner) lost its other keys to the stale copy;
--   * EGRESS — the read is the whole settings JSON (templates included; 5.9 KB average and
--     11.8 KB largest on dev, 2026-10-19), paid on every burst of stars.
--
-- This merges only the given sublists into `settings.favoriteModelLists`, inside the UPDATE, so the
-- row is never read by the client and nothing else in the JSON can be overwritten. The legacy
-- `settings.favoriteModels` keeps mirroring `beatInput` when `beatInput` is written.
--
-- Input is validated rather than trusted: only the five known list names are taken, each must be a
-- JSON array of strings, and each is capped at 32 entries (the app's own cap is 6; the slack only
-- tolerates a legacy list) and 512 characters per id. Anything else is rejected with 22023, so a
-- malformed call cannot bloat the row every Realtime subscriber receives.
--
-- Returns `{ favoriteModelLists, favoriteModels }` as stored after the merge: the client takes them
-- for the lists it did not touch. Both, because a legacy row's `beatInput` lives only in
-- `favoriteModels`.
--
-- SECURITY INVOKER (the default): RLS on `stories` (`auth.uid() = user_id`) already scopes the
-- UPDATE, and the explicit `user_id = auth.uid()` filter keeps it scoped even if a policy changes.
-- `search_path` is pinned empty and every name is schema-qualified.
--
-- Idempotency: `create or replace function` with a return type that never changes, so a replay
-- against an already-migrated schema (the Migrations E2E "stuck-user" nightly) is a true no-op.
-- `GRANT` is idempotent on its own.

create or replace function public.set_story_favorites(p_story_id uuid, p_lists jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_lists jsonb := '{}'::jsonb;
  v_key text;
  v_value jsonb;
  v_result jsonb;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_lists is null or jsonb_typeof(p_lists) <> 'object' then
    raise exception 'lists must be a JSON object' using errcode = '22023';
  end if;

  for v_key, v_value in select key, value from jsonb_each(p_lists) loop
    -- Mirrors FAVORITE_LIST_KEYS (src/app/shared/utils/model-favorites.utils.ts), compared by
    -- `npm run check:shared-constants`: a list the client knows and this refuses fails every star.
    if v_key not in ('beatInput', 'sceneSummary', 'rewrite', 'characterChat', 'roleplay') then
      raise exception 'unknown favorites list %', v_key using errcode = '22023';
    end if;
    -- Nested rather than one OR: SQL does not promise to evaluate an OR left to right, and
    -- jsonb_array_length raises on a non-array.
    if jsonb_typeof(v_value) <> 'array' then
      raise exception 'favorites list % must be an array of at most 32 model ids', v_key using errcode = '22023';
    end if;
    if jsonb_array_length(v_value) > 32 or exists (
      select 1 from jsonb_array_elements(v_value) as element
       where jsonb_typeof(element) <> 'string' or length(element #>> '{}') > 512
    ) then
      raise exception 'favorites list % must be an array of at most 32 model ids', v_key using errcode = '22023';
    end if;
    v_lists := v_lists || jsonb_build_object(v_key, v_value);
  end loop;

  update public.stories as s
     set settings = (
       with base as (
         select case when jsonb_typeof(s.settings) = 'object' then s.settings else '{}'::jsonb end as settings
       ), merged as (
         select base.settings,
                case when jsonb_typeof(base.settings -> 'favoriteModelLists') = 'object'
                     then base.settings -> 'favoriteModelLists' else '{}'::jsonb end || v_lists as lists
           from base
       )
       select jsonb_set(merged.settings, '{favoriteModelLists}', merged.lists)
              || case when v_lists ? 'beatInput'
                      then jsonb_build_object('favoriteModels', v_lists -> 'beatInput')
                      else '{}'::jsonb end
         from merged
     )
   where s.id = p_story_id
     and s.user_id = v_user
  returning jsonb_build_object(
    'favoriteModelLists', s.settings -> 'favoriteModelLists',
    'favoriteModels', s.settings -> 'favoriteModels'
  ) into v_result;

  if not found then
    raise exception 'story not found' using errcode = 'P0002';
  end if;

  return v_result;
end;
$$;

-- Authors only. `create function` grants EXECUTE to PUBLIC, which reaches `anon`; it would get
-- 42501 anyway (no `auth.uid()`), but there is no reason to expose it. No `service_role` grant:
-- a service caller has no `auth.uid()` either, so it could only ever be refused.
revoke execute on function public.set_story_favorites(uuid, jsonb) from public, anon;
grant execute on function public.set_story_favorites(uuid, jsonb) to authenticated;
