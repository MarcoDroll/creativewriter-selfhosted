-- 00080: roleplay_latest_session — where "Continue" in the Roleplay sheet goes.
--
-- WHY. Reaching a roleplay session took three to five taps (sheet → My roleplays → Arc → session),
-- and nothing remembered where the author last played. The story list's Roleplay sheet now opens with
-- "Continue: <Arc> · Session n", and this answers which session that is — on any device, so the phone
-- knows what was played on the desktop.
--
-- WHAT. The session holding the author's newest turn, by `created_at` of their own (`role = 'user'`)
-- messages. Then: if that session's Arc has an open session, that one instead — sealing Session 3 and
-- starting Session 4 without playing a turn yet must land in 4, where play goes on, not in the frozen 3.
-- Otherwise the session itself, sealed or not (it opens read-only, with its Re-open banner). No row when
-- the author has never played a turn.
--
-- * **The author's turns, by `created_at`, not every message by `updated_at`.** `roleplay_messages`
--   carries `set_updated_at`, so an `updated_at` index would take a new entry on every Retry, variant
--   step and edit — none of them HOT any more. `user_id`, `role` and `created_at` never change, so the
--   partial index below is written once per author turn and never again. A Retry always follows an
--   author turn in the same session, so it changes nothing about which session is latest.
-- * **`id` breaks a `created_at` tie**, so the answer is stable.
--
-- SECURITY INVOKER (the default), as 00073/00079: RLS on all three tables already scopes every read to
-- the author; the explicit `user_id = (select auth.uid())` filters keep it scoped if a policy changes and
-- let the planner use the index. `search_path` is pinned empty and every name is schema-qualified.
--
-- Cost: one PostgREST call, ~200 B, when the story list is entered and when its Roleplay sheet opens.
-- Index: one small entry per author turn.
--
-- Replay-safe: `create index if not exists`; `create or replace function` with a return type that never
-- changes; `REVOKE` and `GRANT` are idempotent. Asserted by `scripts/db-tests/roleplay-latest-session.sql`.

create index if not exists idx_roleplay_messages_user_latest_turn
  on public.roleplay_messages(user_id, created_at desc, id desc)
  where role = 'user';

create or replace function public.roleplay_latest_session()
returns table (
  story_id uuid,
  arc_id uuid,
  arc_title text,
  session_id uuid,
  session_sequence integer
)
language sql
stable
set search_path = ''
as $$
  with latest as (
    select s.id as session_id, s.arc_id
      from public.roleplay_messages m
      join public.roleplay_sessions s on s.id = m.session_id
     where m.user_id = (select auth.uid())
       and m.role = 'user'
     order by m.created_at desc, m.id desc
     limit 1
  )
  select t.story_id, a.id, a.title, t.id, t.sequence
    from latest l
    join public.roleplay_sessions t
      on t.id = coalesce(
           (select o.id
              from public.roleplay_sessions o
             where o.arc_id = l.arc_id
               and o.sealed_at is null
               and o.user_id = (select auth.uid())),
           l.session_id)
    join public.roleplay_arcs a on a.id = t.arc_id
   where t.user_id = (select auth.uid());
$$;

-- Authors only, as 00079: `create function` grants EXECUTE to PUBLIC, which reaches `anon`. It would
-- match no row anyway (no `auth.uid()`), but there is no reason to expose it.
revoke execute on function public.roleplay_latest_session() from public, anon;
grant execute on function public.roleplay_latest_session() to authenticated;
