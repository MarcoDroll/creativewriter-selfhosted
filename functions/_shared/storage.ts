/**
 * Supabase Storage bucket names, for the Edge Functions.
 *
 * **The database is the authority**, not this file: the buckets exist because a migration
 * created them, and the RLS policies in `00014`/`00015` key on `bucket_id = '…'`. These
 * constants — and the client's, in `src/app/shared/models/story-media.interface.ts` — are two
 * copies that must both match it.
 *
 * `npm run check:shared-constants` compares this file against the client's. It deliberately
 * does NOT compare either against the SQL: a bucket name appears throughout the migration
 * history by design (they are append-only), so "exactly once" cannot anchor there. Renaming a
 * bucket therefore stays a three-place change — migration, here, and the client — of which the
 * guard covers the two that are easy to forget.
 *
 * Getting it wrong here is silent: `delete-account` would report success having left the
 * user's files in a bucket it no longer names correctly.
 */
export const STORAGE_BUCKET_STORY_MEDIA = 'story-media';
export const STORAGE_BUCKET_USER_BACKGROUNDS = 'user-backgrounds';
