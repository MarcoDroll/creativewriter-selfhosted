-- Storage buckets and RLS policies for CreativeWriter.
-- The storage-init service runs this automatically on startup.
-- If it fails, run manually as a fallback:
--   docker compose exec db psql -U supabase_admin -f /docker-entrypoint-initdb.d/99-storage-setup.sql

DO $$
BEGIN
  -- Create buckets
  INSERT INTO storage.buckets (id, name, public)
    VALUES ('story-media', 'story-media', true)
    ON CONFLICT (id) DO UPDATE SET public = true;
  INSERT INTO storage.buckets (id, name)
    VALUES ('user-backgrounds', 'user-backgrounds')
    ON CONFLICT (id) DO NOTHING;

  -- Storage RLS policies
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Users access own story media' AND schemaname = 'storage'
  ) THEN
    CREATE POLICY "Users access own story media"
      ON storage.objects FOR ALL
      USING (bucket_id = 'story-media' AND (storage.foldername(name))[1] = auth.uid()::text)
      WITH CHECK (bucket_id = 'story-media' AND (storage.foldername(name))[1] = auth.uid()::text);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Users access own backgrounds' AND schemaname = 'storage'
  ) THEN
    CREATE POLICY "Users access own backgrounds"
      ON storage.objects FOR ALL
      USING (bucket_id = 'user-backgrounds' AND (storage.foldername(name))[1] = auth.uid()::text)
      WITH CHECK (bucket_id = 'user-backgrounds' AND (storage.foldername(name))[1] = auth.uid()::text);
  END IF;

EXCEPTION WHEN undefined_table OR invalid_schema_name THEN
  RAISE NOTICE 'Storage schema not ready — the storage-init service will retry automatically.';
  RAISE NOTICE 'Manual fallback: docker compose exec db psql -U supabase_admin -f /docker-entrypoint-initdb.d/99-storage-setup.sql';
END;
$$;
