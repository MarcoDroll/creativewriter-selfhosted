-- Activation funnel view, revision 2 — adds the fine-grained behavioral steps
-- shipped for the empty-editor drop-off investigation:
--   editor_focused, first_text_typed, slash_dropdown_opened, beat_inserted,
--   editor_idle_empty
--
-- Replaces 00038's view body. Drop-and-recreate (NOT create-or-replace) so the
-- new columns can sit in logical funnel order — CREATE OR REPLACE VIEW only
-- allows appending columns at the end. Replay-safe: DROP VIEW IF EXISTS makes a
-- second apply a clean re-run.
--
-- Cohort/scope/interpretation notes are unchanged from 00038:
-- - Cohort: auth.users.created_at >= 2026-04-16 (journey tracking ship date).
-- - Self-hosted instances run with enableJourneyTracking = false and never
--   appear here by design.
-- - Require >=50 users at the inspected step before reading a conversion rate.

DROP VIEW IF EXISTS public.v_activation_funnel;

CREATE VIEW public.v_activation_funnel
WITH (security_invoker = true) AS
SELECT
  u.id                                                                              AS user_id,
  u.created_at                                                                      AS signup_at,
  MIN(e.created_at) FILTER (WHERE e.event_type = 'editor_opened')                   AS first_editor_opened_at,
  MIN(e.created_at) FILTER (WHERE e.event_type = 'editor_focused')                  AS first_editor_focused_at,
  MIN(e.created_at) FILTER (WHERE e.event_type = 'first_text_typed')                AS first_text_typed_at,
  MIN(e.created_at) FILTER (WHERE e.event_type = 'slash_dropdown_opened')           AS first_slash_dropdown_opened_at,
  MIN(e.created_at) FILTER (WHERE e.event_type = 'beat_inserted')                   AS first_beat_inserted_at,
  MIN(e.created_at) FILTER (WHERE e.event_type = 'beat_prompt_entered')             AS first_beat_prompt_entered_at,
  MIN(e.created_at) FILTER (WHERE e.event_type = 'ai_generation_started')           AS first_ai_generation_started_at,
  MIN(e.created_at) FILTER (WHERE e.event_type = 'ai_generation_completed')         AS first_ai_generation_completed_at,
  MIN(e.created_at) FILTER (WHERE e.event_type = 'ai_generation_failed')            AS first_ai_generation_failed_at,
  MIN(e.created_at) FILTER (WHERE e.event_type = 'beat_content_accepted')           AS first_beat_content_accepted_at,
  MIN(e.created_at) FILTER (WHERE e.event_type = 'editor_idle_empty')               AS first_editor_idle_empty_at,
  MIN(e.created_at) FILTER (WHERE e.created_at > u.created_at + interval '24 hours') AS first_return_day_2_at,
  -- Segmentation: primary device and top error_code computed in the same pass
  -- as the outer aggregation to avoid correlated subqueries over journey_events.
  mode() WITHIN GROUP (ORDER BY e.device_type)
    FILTER (WHERE e.device_type IS NOT NULL)                                        AS primary_device_type,
  CASE
    WHEN bool_or(e.event_type = 'onboarding_completed') THEN 'completed'
    WHEN bool_or(e.event_type = 'onboarding_skipped')   THEN 'skipped'
    ELSE 'unknown'
  END                                                                               AS onboarding_state,
  mode() WITHIN GROUP (ORDER BY e.metadata ->> 'error_code')
    FILTER (WHERE e.event_type = 'ai_generation_failed' AND e.metadata ? 'error_code') AS top_error_code
FROM auth.users u
LEFT JOIN public.journey_events e ON e.user_id = u.id
WHERE u.created_at >= '2026-04-16T00:00:00Z'::timestamptz  -- explicit UTC; bare date would use session timezone
GROUP BY u.id, u.created_at;

COMMENT ON VIEW public.v_activation_funnel IS
  'New-user activation funnel (signup -> editor_opened -> editor_focused -> first_text_typed/slash_dropdown_opened -> beat_inserted -> beat_prompt_entered -> ai_generation_started -> ai_generation_completed/failed -> beat_content_accepted -> return_day_2). '
  'beat_content_accepted only fires on rewrite-commit — ai_generation_completed is the activation terminal for first-time users. '
  'editor_idle_empty is a negative signal: 60s on an empty scene with zero interaction. '
  'Behavioral steps (editor_focused, first_text_typed, slash_dropdown_opened, editor_idle_empty) only exist for events recorded after 2026-06-10. '
  'Cohort: auth.users.created_at >= 2026-04-16 (journey tracking ship date). '
  'Self-hosted deployments disable journey tracking and never appear here. '
  'Require >=50 users at the inspected step before interpreting a conversion rate.';

-- Admin dashboard reads via service_role, which bypasses grants.
-- No access for anon/authenticated — security_invoker + auth.users scoping
-- already limit exposure, but revoke explicitly for defense in depth.
REVOKE ALL ON public.v_activation_funnel FROM PUBLIC;
REVOKE ALL ON public.v_activation_funnel FROM anon;
REVOKE ALL ON public.v_activation_funnel FROM authenticated;
