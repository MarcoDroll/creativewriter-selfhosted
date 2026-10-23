-- GIN index on story_snapshots.metadata for efficient JSONB containment queries.
-- Used to check if a media storage path is referenced by any snapshot.
CREATE INDEX IF NOT EXISTS idx_story_snapshots_metadata_gin
  ON public.story_snapshots USING gin (metadata jsonb_path_ops);

-- Check if a specific storage path is referenced by any snapshot for a story.
-- Used before deleting media files from storage to prevent breaking snapshot references.
CREATE OR REPLACE FUNCTION public.is_media_path_referenced_by_snapshot(
  p_story_id uuid,
  p_storage_path text
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.story_snapshots
    WHERE story_id = p_story_id
      AND user_id = auth.uid()
      AND metadata @> jsonb_build_object('mediaPaths', jsonb_build_array(p_storage_path))
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_media_path_referenced_by_snapshot(uuid, text) TO authenticated;

-- Find orphaned media paths when deleting a snapshot.
-- Returns paths from p_media_paths that are NOT referenced by any other snapshot
-- AND NOT present in active story_images or story_videos tables.
CREATE OR REPLACE FUNCTION public.get_orphaned_media_paths(
  p_story_id uuid,
  p_deleted_snapshot_id uuid,
  p_media_paths text[]
)
RETURNS text[]
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(array_agg(path), '{}')
  FROM unnest(p_media_paths) AS path
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.story_snapshots
    WHERE story_id = p_story_id
      AND user_id = auth.uid()
      AND id != p_deleted_snapshot_id
      AND metadata @> jsonb_build_object('mediaPaths', jsonb_build_array(path))
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.story_images
    WHERE story_id = p_story_id
      AND user_id = auth.uid()
      AND storage_path = path
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.story_videos
    WHERE story_id = p_story_id
      AND user_id = auth.uid()
      AND storage_path = path
  );
$$;

GRANT EXECUTE ON FUNCTION public.get_orphaned_media_paths(uuid, uuid, text[]) TO authenticated;
