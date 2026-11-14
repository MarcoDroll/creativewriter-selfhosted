-- A companion message's `seq` is assigned by the database, in the INSERT that writes it (#888).
--
-- The same change 00078 made for the scene transcript (#60), applied to `roleplay_companion_messages`.
-- `RoleplayCompanionService` used to read `max(seq)` and then insert `max + 1`: two sequential round
-- trips per message, plus a loop that re-read and retried when two tabs collided on
-- `idx_roleplay_companion_seq` (23505). The client now inserts without a `seq` and this trigger fills
-- it in, so an append is one round trip.
--
-- **0-based, unlike the scene.** Position 0 is the opening observation (00061), so an empty
-- conversation's first message lands at `coalesce(max(seq), -1) + 1` = 0 — what the client's `maxSeq()`
-- returned -1 for. Still `max + 1`, never a count or a sequence: a delete and *Clear advice* remove
-- rows, and the next message must land just past the survivors.
--
-- **The lock removes the race rather than detecting it.** Under READ COMMITTED two concurrent inserts
-- would both read the same max, and the unique index would turn the second into a 23505. The
-- transaction-scoped advisory lock, keyed on the session, makes the second insert wait until the first
-- commits; its `max` is then a fresh statement with a fresh snapshot, so it takes the next position.
-- The two-key form namespaces it apart from 00078's, so a scene turn and a companion message on one
-- session never wait on each other; a hash collision between two sessions only serialises their
-- appends.
--
-- **An explicit `seq` is kept**, as in 00078. The opening observation forces 0, and its 23505 is how
-- the client learns another tab greeted first — the unique index must keep arbitrating that, so the
-- trigger leaves it alone. The `.cwx` import writes whole transcripts with their own positions, and a
-- client bundle older than this migration still sends `max + 1` itself. None of those take the lock,
-- so a trigger-numbered append can still meet an uncommitted explicit `seq` on the unique index; the
-- client retries that once.
--
-- **SECURITY INVOKER, deliberately**, as 00078. The `max` runs under the inserting user's RLS, which is
-- `auth.uid() = user_id` — every row of an author's conversation is theirs, so it sees the whole
-- session and nothing of anyone else's. DEFINER would gain nothing and would read across users.
--
-- **The session must be the author's before the lock is taken.** The lock is keyed on a value the
-- client sends, and the table's policy checks only `user_id`, so without this anyone holding another
-- author's session id could take that session's lock with an insert of their own. The `exists` runs
-- under the same RLS, so a session the inserting user cannot see is refused before anything waits. It
-- is one primary-key lookup. A super user or the service role sees every session.
--
-- The refusal is 23503, a foreign-key violation, not 42501: under RLS "someone else's" and "gone" are
-- the same answer, and gone is the case that really happens (a session deleted in another tab). The
-- insert's own foreign key refused that with 23503 before this trigger existed.
--
-- No grants: a trigger function is invoked by the trigger, not called by a role, and 00078 has none.
-- No policy and no row changes.
--
-- Cost: none on the meter. One fewer PostgREST request per companion message (~300 B of response
-- each); the `max` is a backward scan of the (session_id, seq) index that the old client query already
-- paid. The table is not in the `supabase_realtime` publication.
--
-- Replay-safe: `create or replace function` with a stable return type, and the trigger is dropped
-- before it is created.

create or replace function public.cw_roleplay_companion_message_seq()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- An explicit position takes no lock, so it needs no ownership check here: RLS's WITH CHECK still
  -- gates the row, and the unique index arbitrates a collision.
  if new.seq is not null then
    return new;
  end if;

  if not exists (select 1 from public.roleplay_sessions s where s.id = new.session_id) then
    raise exception 'roleplay session % does not exist', new.session_id
      using errcode = '23503';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('cw_roleplay_companion_message_seq'), hashtext(new.session_id::text)
  );

  select coalesce(max(m.seq), -1) + 1
    into new.seq
    from public.roleplay_companion_messages m
   where m.session_id = new.session_id;

  return new;
end;
$$;

drop trigger if exists cw_roleplay_companion_message_seq on public.roleplay_companion_messages;
create trigger cw_roleplay_companion_message_seq before insert on public.roleplay_companion_messages
  for each row execute function public.cw_roleplay_companion_message_seq();

comment on column public.roleplay_companion_messages.seq is
  'The message''s position in its session''s companion conversation, 0-based: seq 0 is the opening '
  'observation. max(seq) + 1 within the session, assigned by the cw_roleplay_companion_message_seq '
  'trigger when an insert leaves it null (every append does); an explicit value (the opening''s 0, the '
  '.cwx import) is kept. Never count(*): deletes remove rows, and the next message must land past the '
  'survivors. Unique per session (idx_roleplay_companion_seq).';
