-- Make story-media bucket public so images use permanent public URLs
-- instead of signed URLs with 1-hour TTL that break after logout/login.
-- RLS policies still protect upload/delete operations.
UPDATE storage.buckets SET public = true WHERE id = 'story-media';
