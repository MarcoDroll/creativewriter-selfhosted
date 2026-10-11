/**
 * Which bucket counts what. The shape this guards: polls sharing the submit's 30-per-minute budget,
 * so one long render (or two at once) 429s its own polling and looks failed while it succeeds.
 */
import { assertEquals, assertNotEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { rateBucketFor } from '../buckets.ts';

Deno.test('a status read of a prediction is a poll, in a bucket of its own', () => {
  const poll = rateBucketFor('GET', '/proxy-replicate/predictions/abc123');
  assertEquals(poll.name, 'proxy-replicate-poll');
  assertEquals(poll.max, 500);
  assertEquals(poll.windowMs, 60_000);
});

Deno.test('HEAD is a poll too, and a trailing slash does not change that', () => {
  assertEquals(rateBucketFor('HEAD', '/proxy-replicate/predictions/abc123').name, 'proxy-replicate-poll');
  assertEquals(rateBucketFor('GET', '/proxy-replicate/predictions/abc123/').name, 'proxy-replicate-poll');
});

Deno.test('a submit is real inference and stays on the tight shared bucket', () => {
  const shared = rateBucketFor('POST', '/proxy-replicate/models/prunaai/p-video/predictions');
  assertEquals(shared.name, 'proxy-replicate');
  assertEquals(shared.max, 30);
  assertEquals(rateBucketFor('POST', '/proxy-replicate/predictions').name, 'proxy-replicate');
});

Deno.test('a cancel is a POST on a prediction and is not a poll', () => {
  assertEquals(rateBucketFor('POST', '/proxy-replicate/predictions/abc123/cancel').name, 'proxy-replicate');
  assertEquals(rateBucketFor('GET', '/proxy-replicate/predictions/abc123/cancel').name, 'proxy-replicate');
});

Deno.test('model and collection reads stay on the shared bucket', () => {
  assertEquals(rateBucketFor('GET', '/proxy-replicate/collections/image-to-video').name, 'proxy-replicate');
  assertEquals(rateBucketFor('GET', '/proxy-replicate/models/prunaai/p-video').name, 'proxy-replicate');
  assertEquals(rateBucketFor('GET', '/proxy-replicate/predictions').name, 'proxy-replicate');
});

Deno.test('the two buckets have different names, so they never share a budget', () => {
  assertNotEquals(
    rateBucketFor('GET', '/proxy-replicate/predictions/x').name,
    rateBucketFor('POST', '/proxy-replicate/predictions').name,
  );
});
