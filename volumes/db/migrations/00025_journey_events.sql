-- Journey tracking: lightweight user funnel analytics
-- Tables: journey_events (event log), journey_tracking_config (per-user enable/disable)

-- Event log
CREATE TABLE journey_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  story_id UUID,
  metadata JSONB DEFAULT '{}'::jsonb NOT NULL,
  device_type TEXT,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

ALTER TABLE journey_events ENABLE ROW LEVEL SECURITY;

-- Per-user tracking configuration
CREATE TABLE journey_tracking_config (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  admin_override BOOLEAN NOT NULL DEFAULT false,
  disabled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

ALTER TABLE journey_tracking_config ENABLE ROW LEVEL SECURITY;

-- Index for efficient per-user queries and auto-disable count
CREATE INDEX idx_journey_events_user_created ON journey_events (user_id, created_at DESC);

-- RLS: users can only read their own data
CREATE POLICY journey_events_select_own ON journey_events
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY journey_tracking_config_select_own ON journey_tracking_config
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

-- Batch insert RPC (SECURITY DEFINER — handles insert + auto-disable logic)
CREATE OR REPLACE FUNCTION log_journey_events(p_events JSONB)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := (select auth.uid());
  v_enabled BOOLEAN;
  v_admin_override BOOLEAN;
  v_event_count BIGINT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Check if config row already exists
  SELECT enabled, admin_override INTO v_enabled, v_admin_override
  FROM journey_tracking_config
  WHERE user_id = v_user_id;

  IF NOT FOUND THEN
    -- First call: create config row
    INSERT INTO journey_tracking_config (user_id)
    VALUES (v_user_id)
    ON CONFLICT (user_id) DO NOTHING;
    v_enabled := true;
    v_admin_override := false;
  END IF;

  -- If disabled, silently return (no unnecessary writes)
  IF NOT v_enabled THEN
    RETURN;
  END IF;

  -- Insert events (filter out malformed records)
  INSERT INTO journey_events (user_id, session_id, event_type, story_id, metadata, device_type, created_at)
  SELECT
    v_user_id,
    r.session_id,
    r.event_type,
    r.story_id,
    COALESCE(r.metadata, '{}'::jsonb),
    r.device_type,
    COALESCE(r.created_at, now())
  FROM jsonb_to_recordset(p_events) AS r(
    session_id UUID,
    event_type TEXT,
    story_id UUID,
    metadata JSONB,
    device_type TEXT,
    created_at TIMESTAMPTZ
  )
  WHERE r.session_id IS NOT NULL AND r.event_type IS NOT NULL;

  -- Auto-disable check: count via index scan on (user_id, created_at)
  IF NOT v_admin_override THEN
    SELECT COUNT(*) INTO v_event_count
    FROM journey_events
    WHERE user_id = v_user_id;

    IF v_event_count > 500 THEN
      UPDATE journey_tracking_config
      SET enabled = false, disabled_at = now(), updated_at = now()
      WHERE user_id = v_user_id;
    END IF;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION log_journey_events FROM public, anon;
GRANT EXECUTE ON FUNCTION log_journey_events TO authenticated;

-- Auto-purge: delete events older than 90 days (runs daily at 3 AM UTC)
-- pg_cron is only available on Supabase Pro+ plans; guard to avoid breaking migration
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'purge_journey_events',
      '0 3 * * *',
      'DELETE FROM journey_events WHERE created_at < now() - interval ''90 days'''
    );
  ELSE
    RAISE NOTICE 'pg_cron not available — skipping journey_events purge job. Events must be purged manually.';
  END IF;
END;
$$;
