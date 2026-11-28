-- The seal reads the WHOLE transcript (see 00056 and the seal's own comment): every turn from
-- seq 1, so the record is written from the scene rather than from a ~400-word running summary.
--
-- The cost that exposed: an assistant turn's prose lives at `variants[selected]`, so PostgREST
-- hands back EVERY rejected retry alternate for every turn purely so the client can index one of
-- them. PostgREST cannot index an array by a value from another column, which is why this is a
-- function rather than a smarter select.
--
-- **Where the saving is, precisely.** Postgres still de-TOASTs `variants` to evaluate the
-- expression below, so this does NOT reduce database IO or CPU — it removes the rejected
-- alternates from the wire, from PostgREST's serialisation, and from the client's heap. On a
-- retry-heavy scene that is the difference between ~1.5MB and ~150KB for one seal.
--
-- **The lateral is what keeps that honest.** `jsonb_typeof`, `jsonb_array_length` and `->>` each
-- de-TOAST their argument independently and Postgres does not eliminate the common subexpression,
-- so an inline version made an assistant row pay four de-TOASTs where the old plain select paid
-- one. `kept` is computed once per row; everything after it indexes a small in-memory value.
--
-- **The string filter is not defensive decoration — it is what makes this agree with the client.**
-- `rowToMessage` runs `stringsOf`, which drops non-string elements, and clamps `selected` against
-- the FILTERED length. Clamping against the raw length here would pick a different alternate for
-- any row holding a non-string: `["a", 1, "c"]` with `selected: 1` reads "c" in the client and "1"
-- here. No writer in the app can produce that today (`appendAssistantTurn`, `addVariant`,
-- `replaceAssistantText` and the `.cwx` import all filter to strings), but nothing in the schema
-- enforces it, and a disagreement would put prose the author never kept into a permanent record.
--
-- The clamp itself mirrors `rowToMessage` at both ends, because a stored `selected` can be out of
-- range; a row whose `variants` is null, empty or not an array reads as '' in both places.
CREATE OR REPLACE FUNCTION public.get_roleplay_transcript_for_summary(
  p_session_id uuid,
  p_after_seq integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  session_id uuid,
  seq integer,
  role text,
  turn_text text,
  character_id text,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.id,
         m.session_id,
         m.seq,
         m.role,
         CASE
           WHEN m.role = 'user' THEN COALESCE(m.scene, '')
           WHEN jsonb_array_length(v.kept) > 0
             THEN COALESCE(
               v.kept ->> LEAST(GREATEST(m.selected, 0), jsonb_array_length(v.kept) - 1),
               ''
             )
           ELSE ''
         END AS turn_text,
         m.character_id,
         m.created_at,
         m.updated_at
  FROM public.roleplay_messages m
  CROSS JOIN LATERAL (
    -- The string elements, in order — `stringsOf`'s answer, computed once.
    -- `jsonb_typeof` first because `$[*]` in lax mode wraps a bare scalar into a one-element
    -- array, which would read a non-array `variants` as prose where the client reads ''.
    SELECT CASE
             WHEN jsonb_typeof(m.variants) = 'array'
               THEN jsonb_path_query_array(m.variants, '$[*] ? (@.type() == "string")')
             ELSE '[]'::jsonb
           END AS kept
  ) v
  WHERE m.session_id = p_session_id
    -- SECURITY DEFINER bypasses RLS, so ownership is enforced here. Without this line the
    -- function would hand any session's transcript to any signed-in user.
    AND m.user_id = auth.uid()
    AND m.seq > p_after_seq
  ORDER BY m.seq ASC;
$$;

GRANT EXECUTE ON FUNCTION public.get_roleplay_transcript_for_summary(uuid, integer) TO authenticated;
