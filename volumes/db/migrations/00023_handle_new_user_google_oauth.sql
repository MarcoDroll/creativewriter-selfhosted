-- Fix handle_new_user() for Google OAuth compatibility:
-- 1. Username collision: Google OAuth doesn't set 'username' metadata, so the
--    trigger falls back to email prefix. Two users with the same prefix would
--    violate the UNIQUE constraint. Fix: use INSERT ON CONFLICT DO NOTHING to
--    handle both existing collisions and concurrent-insert races atomically.
-- 2. display_name fallback: Google populates 'full_name' in user_metadata.
--    Add it to the coalesce chain so OAuth users get a proper display name.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  base_username text;
  final_username text;
  attempt int := 0;
BEGIN
  base_username := coalesce(
    new.raw_user_meta_data->>'username',
    split_part(new.email, '@', 1)
  );
  final_username := base_username;

  -- Try inserting; on username collision append a random suffix and retry.
  -- Uses ON CONFLICT DO NOTHING to handle both existing rows and concurrent
  -- inserts atomically (no TOCTOU race).
  LOOP
    INSERT INTO public.profiles (id, username, display_name, email)
    VALUES (
      new.id,
      final_username,
      coalesce(
        new.raw_user_meta_data->>'display_name',
        new.raw_user_meta_data->>'full_name',
        split_part(new.email, '@', 1)
      ),
      new.email
    )
    ON CONFLICT (username) DO NOTHING;

    EXIT WHEN FOUND;

    attempt := attempt + 1;
    IF attempt >= 20 THEN
      RAISE EXCEPTION 'Could not generate unique username for %', new.email;
    END IF;

    final_username := base_username || '_' || substr(md5(random()::text), 1, 4);
  END LOOP;

  RETURN new;
END;
$$;
