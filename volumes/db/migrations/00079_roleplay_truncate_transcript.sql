-- 00079: truncate_roleplay_transcript — a roleplay truncation's summary reset and its delete, in ONE
-- transaction, conditional on the session's `updated_at` (#169).
--
-- WHY. Every truncation in a roleplay scene (Continue from here, Delete from here, regenerating an
-- earlier reply, editing your own turn) deletes the turns past a seq, and resets the running summary
-- when a deleted or edited turn is folded into it. Those were two requests: a conditional
-- `commitSummary('', 0)` and an unconditional `deleteAfter` (`.gt('seq', n)`, no token at all). #166
-- put the reset first so a failed reset destroyed nothing, but a delete failing AFTER a committed
-- reset still cost the author their running summary — hand-written, possibly — for a truncation that
-- never happened. And the delete was the one destructive roleplay write with no optimistic-concurrency
-- guard: `roleplay_sessions` is deliberately outside `supabase_realtime`, so the session's
-- `updated_at` compare is the only liveness signal two tabs have, and the delete never made it.
--
-- WHAT. One UPDATE on the session row, which is at once the compare (`updated_at = expected`), the
-- row lock, and the reset; then the delete; both or neither.
--
-- * **The session row is ALWAYS written**, reset or not, so its `set_updated_at` trigger moves the
--   token. A truncation changes what `summary_through_seq` counts over, and another tab's next
--   conditional write (a roll's commit, a seal, a hand-edited summary) must see that it happened.
--   The caller adopts the row this returns, as it does every session write.
-- * **The reset happens when the caller asks OR when the delete reaches a folded turn**
--   (`p_after_seq < summary_through_seq`). The caller asks for an edit of a folded turn whose reply
--   lies past the boundary, which no seq arithmetic here can see. The second half is a floor that
--   holds whatever a client sends: a summary describing turns that no longer exist is never left
--   behind.
-- * **Refused means nothing written.** A stale token, a sealed session (its transcript is the
--   permanent record), a session that is gone or another author's: zero rows, and the client throws
--   `stale-write`, exactly as `conditionalUpdate` does on a zero-row update. Four causes, one answer:
--   the store re-reads the row on a `stale-write` anyway, and that re-read is what tells a session
--   that is gone (`session-missing`) from one that merely moved.
-- * **This replaces the client's `deleteAfter`**, which `roleplay_messages.seq`'s column comment
--   (00078) still names. The tail it removes is the same.
--
-- SECURITY INVOKER (the default), as 00073: RLS on both tables (`auth.uid() = user_id`, FOR ALL)
-- already lets the author make both writes, so DEFINER would gain nothing and would remove a wall. The
-- explicit `user_id = auth.uid()` filters keep it scoped even if a policy changes. `search_path` is
-- pinned empty and every name is schema-qualified.
--
-- Cost: one PostgREST request where there were one or two; it answers with the session row, which a
-- reset already did and a plain delete did not (~1-30 KB, mostly `summary`). On a tap, not a loop.
--
-- Replay-safe: `create or replace function` with a return type that never changes; `REVOKE` and `GRANT` are
-- idempotent on their own. Asserted against the real image by `scripts/db-tests/roleplay-truncate-transcript.sql`.

create or replace function public.truncate_roleplay_transcript(
  p_session_id uuid,
  p_after_seq integer,
  p_reset_summary boolean,
  p_expected_updated_at timestamptz
)
returns setof public.roleplay_sessions
language plpgsql
set search_path = ''
as $$
declare
  v_row public.roleplay_sessions%rowtype;
  v_reset boolean := coalesce(p_reset_summary, false);
begin
  update public.roleplay_sessions as s
     set summary = case when v_reset or p_after_seq < s.summary_through_seq
                        then '' else s.summary end,
         summary_through_seq = case when v_reset or p_after_seq < s.summary_through_seq
                                    then 0 else s.summary_through_seq end
   where s.id = p_session_id
     and s.user_id = auth.uid()
     and s.updated_at = p_expected_updated_at
     and s.sealed_at is null
  returning s.* into v_row;

  if not found then
    return;
  end if;

  delete from public.roleplay_messages as m
   where m.session_id = p_session_id
     and m.user_id = auth.uid()
     and m.seq > p_after_seq;

  return next v_row;
end;
$$;

-- Authors only, as 00073: `create function` grants EXECUTE to PUBLIC, which reaches `anon`. It would
-- match no row anyway (no `auth.uid()`), but there is no reason to expose it.
revoke execute on function public.truncate_roleplay_transcript(uuid, integer, boolean, timestamptz) from public, anon;
grant execute on function public.truncate_roleplay_transcript(uuid, integer, boolean, timestamptz) to authenticated;
