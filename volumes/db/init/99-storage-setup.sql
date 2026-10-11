-- Storage buckets and RLS policies for CreativeWriter.
-- The storage-init service runs this automatically on startup after
-- storage-api has finished applying its own schema migrations.
-- If it fails, re-run manually: docker compose run --rm storage-init

DO $$
BEGIN
  -- Create story-media bucket. The `public` column is added by storage-api's
  -- own migrations (on first boot) — if it doesn't exist yet, create the
  -- bucket without it; storage-init will retry the full run until the column
  -- exists and the bucket can be configured public.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'public'
  ) THEN
    INSERT INTO storage.buckets (id, name, public)
      VALUES ('story-media', 'story-media', true)
      ON CONFLICT (id) DO UPDATE SET public = true;
  ELSE
    INSERT INTO storage.buckets (id, name)
      VALUES ('story-media', 'story-media')
      ON CONFLICT (id) DO NOTHING;
  END IF;

  -- user-backgrounds does not reference the `public` column, so it is
  -- always safe to insert regardless of storage-api migration state.
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

-- undefined_column is kept in the handler as defense-in-depth: the IF EXISTS
-- check above and the INSERT are not atomic, so a concurrent storage-api
-- migration could drop the column between them. Cheap safety net.
EXCEPTION WHEN undefined_table OR invalid_schema_name OR undefined_column THEN
  RAISE NOTICE 'Storage schema not ready — the storage-init service will retry automatically.';
  RAISE NOTICE 'Manual fallback: docker compose run --rm storage-init';
END;
$$;
