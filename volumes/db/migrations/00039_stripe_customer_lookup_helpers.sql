-- Helpers for Stripe orphan recovery and webhook auto-linking.
-- Both functions are SECURITY DEFINER and only callable by the service role
-- (Edge Functions). They are NOT exposed to anon/authenticated.

-- 1. Email -> auth user id lookup. auth.admin has no getUserByEmail.
CREATE OR REPLACE FUNCTION public.get_user_id_by_email(p_email TEXT)
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT id FROM auth.users WHERE lower(email) = lower(p_email) LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_user_id_by_email(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_user_id_by_email(TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_id_by_email(TEXT) TO service_role;

-- 2. Atomic stripe_customers upsert that handles all three unique constraints
-- (user_id, email, stripe_customer_id). Postgres ON CONFLICT only handles one
-- target column, so a re-checkout with a new stripe_customer_id can collide on
-- the other unique constraints. Pre-DELETE conflicting rows belonging to other
-- users so the INSERT can proceed deterministically.
CREATE OR REPLACE FUNCTION public.upsert_stripe_customer_mapping(
  p_user_id UUID,
  p_email TEXT,
  p_stripe_customer_id TEXT
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM stripe_customers
   WHERE (stripe_customer_id = p_stripe_customer_id AND user_id <> p_user_id)
      OR (lower(email) = lower(p_email) AND user_id <> p_user_id);

  INSERT INTO stripe_customers (user_id, email, stripe_customer_id, updated_at)
       VALUES (p_user_id, lower(p_email), p_stripe_customer_id, now())
  ON CONFLICT (user_id) DO UPDATE
     SET email = EXCLUDED.email,
         stripe_customer_id = EXCLUDED.stripe_customer_id,
         updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_stripe_customer_mapping(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_stripe_customer_mapping(UUID, TEXT, TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_stripe_customer_mapping(UUID, TEXT, TEXT) TO service_role;
