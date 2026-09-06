-- 00042_data_api_table_grants.sql
-- Make Data API access explicit on every public-schema table.
-- Supabase removes implicit GRANTs to authenticated on public on 2026-05-30
-- for new projects and 2026-10-30 for existing projects. Existing dev/prod
-- tables keep their current grants, but fresh provisions (supabase db reset,
-- new self-host installs) after the cutoff would lose access without this.
--
-- Strategy: uniform privileges on all live tables. No anon grants — the app
-- is authenticated-only. RLS continues to enforce per-row access.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.profiles                  TO authenticated;
GRANT ALL                            ON TABLE public.profiles                  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.stories                   TO authenticated;
GRANT ALL                            ON TABLE public.stories                   TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chapters                  TO authenticated;
GRANT ALL                            ON TABLE public.chapters                  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.scenes                    TO authenticated;
GRANT ALL                            ON TABLE public.scenes                    TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.codexes                   TO authenticated;
GRANT ALL                            ON TABLE public.codexes                   TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.codex_categories          TO authenticated;
GRANT ALL                            ON TABLE public.codex_categories          TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.codex_entries             TO authenticated;
GRANT ALL                            ON TABLE public.codex_entries             TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.scene_chats               TO authenticated;
GRANT ALL                            ON TABLE public.scene_chats               TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.character_chats           TO authenticated;
GRANT ALL                            ON TABLE public.character_chats           TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.story_research            TO authenticated;
GRANT ALL                            ON TABLE public.story_research            TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.story_snapshots           TO authenticated;
GRANT ALL                            ON TABLE public.story_snapshots           TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.beat_histories            TO authenticated;
GRANT ALL                            ON TABLE public.beat_histories            TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.story_images              TO authenticated;
GRANT ALL                            ON TABLE public.story_images              TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.story_videos              TO authenticated;
GRANT ALL                            ON TABLE public.story_videos              TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.custom_backgrounds        TO authenticated;
GRANT ALL                            ON TABLE public.custom_backgrounds        TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.stripe_customers          TO authenticated;
GRANT ALL                            ON TABLE public.stripe_customers          TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.subscription_cache        TO authenticated;
GRANT ALL                            ON TABLE public.subscription_cache        TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_usage                  TO authenticated;
GRANT ALL                            ON TABLE public.ai_usage                  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.audit_log                 TO authenticated;
GRANT ALL                            ON TABLE public.audit_log                 TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_users               TO authenticated;
GRANT ALL                            ON TABLE public.admin_users               TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.cliche_phrases            TO authenticated;
GRANT ALL                            ON TABLE public.cliche_phrases            TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.story_cliche_index        TO authenticated;
GRANT ALL                            ON TABLE public.story_cliche_index        TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.journey_events            TO authenticated;
GRANT ALL                            ON TABLE public.journey_events            TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.journey_tracking_config   TO authenticated;
GRANT ALL                            ON TABLE public.journey_tracking_config   TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.codex_entry_current_state TO authenticated;
GRANT ALL                            ON TABLE public.codex_entry_current_state TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.codex_entry_scene_states  TO authenticated;
GRANT ALL                            ON TABLE public.codex_entry_scene_states  TO service_role;
