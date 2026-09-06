-- Fix: add SET search_path = public to update_updated_at()
-- The original definition in 00001 lacked a pinned search_path,
-- which the Supabase Security Advisor flags as a risk.

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  new.updated_at = now();
  RETURN new;
END;
$$;
