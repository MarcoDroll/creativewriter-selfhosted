-- Standalone index on created_at for efficient nightly purge by pg_cron.
-- The composite (user_id, created_at) index cannot serve
-- DELETE ... WHERE created_at < threshold without scanning all user_id values.
CREATE INDEX idx_journey_events_created ON journey_events (created_at);
