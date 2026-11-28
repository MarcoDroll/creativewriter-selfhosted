/**
 * Deno tests for the render-relay sweep on account deletion.
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/delete-account/_tests_/relay-sweep.test.ts
 *
 * delete-account never listed this bucket: a deleted author's parked pictures waited for the
 * relay's purge, which runs only when someone renders.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { type RelayBucketPort, type StorageEntry, sweepRenderRelay } from '../relay-sweep.ts';

/** A bucket of object paths, listed the way Supabase Storage lists: one level, folders with id null. */
function fakeBucket(paths: string[], failList: string[] = [], failRemove = false) {
  const objects = new Set(paths);
  const removed: string[][] = [];
  const port: RelayBucketPort = {
    list: (prefix, { limit, offset }) => {
      if (failList.includes(prefix)) return Promise.resolve({ data: null, error: { message: 'list failed' } });
      const level = new Map<string, StorageEntry>();
      for (const p of [...objects].sort()) {
        if (!p.startsWith(`${prefix}/`)) continue;
        const [name, ...rest] = p.slice(prefix.length + 1).split('/');
        level.set(name, { name, id: rest.length ? null : `id-${p}` });
      }
      return Promise.resolve({ data: [...level.values()].slice(offset, offset + limit), error: null });
    },
    remove: (chunk) => {
      removed.push(chunk);
      if (failRemove) return Promise.resolve({ error: { message: 'remove failed' } });
      for (const p of chunk) objects.delete(p);
      return Promise.resolve({ error: null });
    },
  };
  return { port, objects, removed };
}

Deno.test("every parked picture of the user is removed, and nobody else's", async () => {
  const { port, objects } = fakeBucket([
    'u1/relay-a/0.png', 'u1/relay-a/1.png', 'u1/relay-b/0.webp',
    'u2/relay-c/0.png',
  ]);

  assertEquals(await sweepRenderRelay(port, 'u1'), []);
  assertEquals([...objects], ['u2/relay-c/0.png']);
});

Deno.test('listings are paginated, so a large backlog is removed in full', async () => {
  const many = Array.from({ length: 250 }, (_, i) => `u1/relay-${String(i).padStart(3, '0')}/0.png`);
  const { port, objects, removed } = fakeBucket(many);

  assertEquals(await sweepRenderRelay(port, 'u1'), []);
  assertEquals(objects.size, 0);
  assertEquals(removed.map(c => c.length), [100, 100, 50]);
});

Deno.test('a user with nothing parked costs one listing and no remove', async () => {
  const { port, removed } = fakeBucket(['u2/relay-c/0.png']);
  assertEquals(await sweepRenderRelay(port, 'u1'), []);
  assertEquals(removed, []);
});

Deno.test('failures are reported, never thrown', async () => {
  const listing = fakeBucket(['u1/relay-a/0.png'], ['u1']);
  assertEquals(await sweepRenderRelay(listing.port, 'u1'), ['u1/']);

  const folder = fakeBucket(['u1/relay-a/0.png', 'u1/relay-b/0.png'], ['u1/relay-a']);
  assertEquals(await sweepRenderRelay(folder.port, 'u1'), ['u1/relay-a/']);
  assertEquals([...folder.objects], ['u1/relay-a/0.png']);

  const removing = fakeBucket(['u1/relay-a/0.png'], [], true);
  assertEquals(await sweepRenderRelay(removing.port, 'u1'), ['u1/relay-a/0.png']);
});
