/**
 * The `render-relay` bucket on account deletion (ADR 0021).
 *
 * A relayed render parks its pictures at `${userId}/${relayId}/${n}.ext` (`render-relay/relay.ts`)
 * until the author's device collects them. The relay's own purge drains what is left after an
 * hour, but only on the back of a later render, so a deleted author's pictures could sit there
 * until someone else rendered. Deleting them with the account is the privacy half of GDPR erasure.
 *
 * Storage `remove` takes exact paths, and the objects sit two levels down, so: list the user's
 * folder, list each relay folder (paginated), remove in chunks. A failure is reported in the
 * returned paths, as the other buckets' failures are, rather than aborting the deletion: the
 * purge still reaches anything left.
 *
 * Kept free of the Supabase client so it can be unit-tested.
 */

export interface StorageEntry {
  name: string;
  /** Null for a folder (Supabase Storage lists a common prefix with no object id). */
  id: string | null;
}

export interface RelayBucketPort {
  list(prefix: string, options: { limit: number; offset: number }): Promise<{
    data: StorageEntry[] | null;
    error: { message: string } | null;
  }>;
  remove(paths: string[]): Promise<{ error: { message: string } | null }>;
}

const PAGE = 100;
const REMOVE_CHUNK = 100;

async function listAll(bucket: RelayBucketPort, prefix: string): Promise<StorageEntry[] | null> {
  const entries: StorageEntry[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await bucket.list(prefix, { limit: PAGE, offset });
    if (error) {
      console.error(`[DeleteAccount] Could not list render-relay/${prefix}:`, error.message);
      return null;
    }
    entries.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGE) return entries;
  }
}

/**
 * Removes every object under `${userId}/` in the relay bucket. Returns the paths (or folder
 * prefixes, when a listing failed) that could not be removed.
 */
export async function sweepRenderRelay(bucket: RelayBucketPort, userId: string): Promise<string[]> {
  const failed: string[] = [];
  const folders = await listAll(bucket, userId);
  if (!folders) return [`${userId}/`];

  const paths: string[] = [];
  for (const entry of folders) {
    const prefix = `${userId}/${entry.name}`;
    if (entry.id !== null) {
      // A file directly under the user's folder: not today's layout, but it is theirs.
      paths.push(prefix);
      continue;
    }
    const files = await listAll(bucket, prefix);
    if (!files) {
      failed.push(`${prefix}/`);
      continue;
    }
    for (const file of files) if (file.id !== null) paths.push(`${prefix}/${file.name}`);
  }

  for (let i = 0; i < paths.length; i += REMOVE_CHUNK) {
    const chunk = paths.slice(i, i + REMOVE_CHUNK);
    const { error } = await bucket.remove(chunk);
    if (error) {
      console.error('[DeleteAccount] Error deleting render-relay chunk:', error.message);
      failed.push(...chunk);
    }
  }
  if (paths.length > 0) console.log(`[DeleteAccount] Processed ${paths.length} files from render-relay`);
  return failed;
}
