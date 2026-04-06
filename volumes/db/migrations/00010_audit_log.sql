-- Audit log for subscription and security events
CREATE TABLE audit_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb NOT NULL,
  ip_address INET,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
-- No RLS policies = service-role only (same pattern as ai_usage, subscription_cache)

CREATE INDEX idx_audit_log_user_id ON audit_log (user_id);
CREATE INDEX idx_audit_log_event_type ON audit_log (event_type);
CREATE INDEX idx_audit_log_created_at ON audit_log (created_at);

CREATE OR REPLACE FUNCTION log_audit_event(
  p_user_id UUID,
  p_event_type TEXT,
  p_metadata JSONB DEFAULT '{}',
  p_ip_address INET DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO audit_log (user_id, event_type, metadata, ip_address)
  VALUES (p_user_id, p_event_type, p_metadata, p_ip_address);
END;
$$;

REVOKE EXECUTE ON FUNCTION log_audit_event FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION log_audit_event TO service_role;
