-- Activation funnel view — powers the admin dashboard "Activation Funnel" tab.
--
-- One row per signed-up user with the timestamp of the first occurrence of each
-- funnel step. The admin app aggregates from this (counts, conversion rates,
-- per-segment breakdowns). Keeping per-user rows in the view rather than a
-- pre-aggregated shape lets the admin slice by segments without new migrations.
--
-- Cohort: auth.users.created_at >= 2026-04-16 (journey tracking shipped that day).
-- Earlier signups have no events and would crush conversion rates to noise.
--
-- Self-hosted scope: self-hosted instances run with
-- environment.enableJourneyTracking = false and never emit events, so they are
-- invisible to this view by design. Surface that caveat in the admin UI so the
-- zero counts there don't surprise operators.
--
-- Interpretation: require a cohort of >=50 users reaching the step under
-- inspection before drawing any conclusion about conversion rate. Below that,
-- extend the window.

CREATE OR REPLACE VIEW public.v_activation_funnel
WITH (security_invoker = true) AS
SELECT
  u.id                                                                              AS user_id,
  u.created_at                                                                      AS signup_at,
  MIN(e.created_at) FILTER (WHERE e.event_type = 'editor_opened')                   AS first_editor_opened_at,
  MIN(e.created_at) FILTER (WHERE e.event_type = 'beat_prompt_entered')             AS first_beat_prompt_entered_at,
  MIN(e.created_at) FILTER (WHERE e.event_type = 'ai_generation_started')           AS first_ai_generation_started_at,
  MIN(e.created_at) FILTER (WHERE e.event_type = 'ai_generation_completed')         AS first_ai_generation_completed_at,
  MIN(e.created_at) FILTER (WHERE e.event_type = 'ai_generation_failed')            AS first_ai_generation_failed_at,
  MIN(e.created_at) FILTER (WHERE e.event_type = 'beat_content_accepted')           AS first_beat_content_accepted_at,
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
  'New-user activation funnel (signup -> editor_opened -> beat_prompt_entered -> ai_generation_started -> ai_generation_completed/failed -> beat_content_accepted -> return_day_2). '
  'Cohort: auth.users.created_at >= 2026-04-16 (journey tracking ship date). '
  'Self-hosted deployments disable journey tracking and never appear here. '
  'Require >=50 users at the inspected step before interpreting a conversion rate.';

-- Admin dashboard reads via service_role, which bypasses grants.
-- No access for anon/authenticated — security_invoker + auth.users scoping
-- already limit exposure, but revoke explicitly for defense in depth.
REVOKE ALL ON public.v_activation_funnel FROM PUBLIC;
REVOKE ALL ON public.v_activation_funnel FROM anon;
REVOKE ALL ON public.v_activation_funnel FROM authenticated;
