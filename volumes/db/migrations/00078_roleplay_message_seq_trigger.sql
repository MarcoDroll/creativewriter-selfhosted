-- A roleplay turn's `seq` is assigned by the database, in the INSERT that writes the turn (#60).
--
-- `RoleplayMessageService.append()` used to read `max(seq)` and then insert `max + 1`: two
-- sequential round trips for every turn side, four per exchange, and the first two sat between the
-- Send tap and the first streamed token. On a phone at 200-500ms RTT that was ~0.4-1s of dead time
-- before the character started speaking. The client now inserts without a `seq` and this trigger
-- fills it in, so an append is one round trip.
--
-- **Still `max + 1`, never a count or a sequence.** Editing a turn deletes everything after it
-- (`deleteAfter`), so the next turn must land just past the survivors — a count collides with a
-- surviving row, and a sequence object would leave a gap where the deleted turns were. Readers do
-- not care about gaps, but `summary_through_seq` arithmetic is easier to reason about without them,
-- and the client-side value was max + 1 since 00056.
--
-- **The lock removes the race rather than detecting it.** Under READ COMMITTED two concurrent
-- inserts would both read the same max, and the unique index `idx_roleplay_messages_seq` would turn
-- the second into a 23505 — what the client-side read-then-insert already did. The transaction-scoped
-- advisory lock, keyed on the session, makes the second insert wait until the first commits; its
-- `max` is then a fresh statement with a fresh snapshot, so it sees the first row and takes the next
-- position. The lock is released at commit (one PostgREST request), and only appends to the SAME
-- session ever wait on it. The two-key form namespaces it, so it cannot collide with any other
-- advisory lock; a hash collision between two sessions only serialises their appends.
--
-- **An explicit `seq` is kept.** The `.cwx` import writes a whole transcript with its own positions,
-- in bulk, and a client bundle older than this migration still sends `max + 1` itself. Both are left
-- exactly as they were — no lock, the unique index still arbitrates. So the lock serialises only the
-- inserts it assigns: an old bundle's explicit `max + 1` racing a new one can still meet a 23505, as
-- before.
--
-- **SECURITY INVOKER, deliberately.** The `max` runs under the inserting user's RLS, which is
-- `auth.uid() = user_id` — every row of an author's session is theirs, so it sees the whole session
-- and nothing of anyone else's. DEFINER would gain nothing and would read across users.
--
-- **The session must be the author's before the lock is taken.** The lock is keyed on a value the
-- client sends, and the table's policy checks only `user_id`, so without this anyone holding another
-- author's session id could take that session's lock with an insert of their own. The `exists` runs
-- under the same RLS, so a session the inserting user cannot see is refused before anything waits.
-- It is one primary-key lookup. A super user or the service role sees every session.
--
-- The refusal is 23503, a foreign-key violation, not 42501. Under RLS "someone else's" and "gone"
-- are the same answer, and gone is the case that really happens: a session deleted in another tab.
-- Before this trigger the insert's own foreign key refused it with 23503, which the client shows as a
-- missing reference; 42501 would have told the author they lack permission to write their own scene.
--
-- Cost: none on the meter. One fewer PostgREST request per turn side (~300 B of response each); the
-- `max` is a backward scan of the (session_id, seq) index that the old client query already paid.
--
-- Replay-safe: `create or replace function` with a stable return type, and the trigger is dropped
-- before it is created.

create or replace function public.cw_roleplay_message_seq()
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

  perform pg_advisory_xact_lock(hashtext('cw_roleplay_message_seq'), hashtext(new.session_id::text));

  select coalesce(max(m.seq), 0) + 1
    into new.seq
    from public.roleplay_messages m
   where m.session_id = new.session_id;

  return new;
end;
$$;

drop trigger if exists cw_roleplay_message_seq on public.roleplay_messages;
create trigger cw_roleplay_message_seq before insert on public.roleplay_messages
  for each row execute function public.cw_roleplay_message_seq();

comment on column public.roleplay_messages.seq is
  'The turn''s position in its session, 1-based. max(seq) + 1 within the session, assigned by the '
  'cw_roleplay_message_seq trigger when an insert leaves it null (the app always does); an explicit '
  'value (the .cwx import) is kept. Never count(*): deleteAfter removes a tail, and the next turn must '
  'land past the survivors. Unique per session (idx_roleplay_messages_seq).';
