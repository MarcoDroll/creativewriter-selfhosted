/**
 * Deno tests for what the Included AI chat route lets a message carry (#468).
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/premium/included-chat-content.test.ts
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  MAX_CHAT_BODY_BYTES,
  MAX_CHAT_IMAGES,
  bodyTooLarge,
  normalizeMessageContent,
  MAX_CHAT_IMAGE_CHARS,
  MAX_CHAT_IMAGE_PAYLOAD_CHARS,
  checkMessageContents,
} from './included-chat-content.ts';

const picture = (chars = 1000) => ({
  type: 'image_url',
  image_url: { url: `data:image/jpeg;base64,${'A'.repeat(chars)}` },
});

Deno.test('a string, null or missing content is accepted, as it always was', () => {
  assertEquals(checkMessageContents([
    { role: 'system', content: 'rules' }, { role: 'user', content: null }, { role: 'assistant' },
  ]), null);
});

Deno.test('text and inline pictures in a user message are accepted', () => {
  assertEquals(checkMessageContents([
    { role: 'system', content: 'rules' },
    { role: 'user', content: [{ type: 'text', text: 'Image 1:' }, picture(), { type: 'text', text: 'Image 2:' }, picture()] },
  ]), null);
});

Deno.test('a picture outside a user message is refused', () => {
  assertEquals(typeof checkMessageContents([{ role: 'system', content: [picture()] }]), 'string');
  assertEquals(typeof checkMessageContents([{ role: 'assistant', content: [picture()] }]), 'string');
});

Deno.test('only inline JPEG/PNG/WebP/GIF data URLs — never a URL DeepSeek would fetch', () => {
  const bad = [
    'https://example.com/a.png',
    'data:image/svg+xml;base64,AAAA',
    'data:text/html;base64,AAAA',
    'data:image/png;base64,not base64!',
  ];
  for (const url of bad) {
    assertEquals(typeof checkMessageContents([{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }]), 'string', url);
  }
  for (const kind of ['jpeg', 'png', 'webp', 'gif']) {
    assertEquals(checkMessageContents([{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/${kind};base64,AAAA` } }] }]), null, kind);
  }
});

Deno.test('malformed parts are refused', () => {
  const cases: unknown[] = [
    { role: 'user', content: 7 },
    { role: 'user', content: { type: 'text', text: 'x' } },
    { role: 'user', content: ['x'] },
    { role: 'user', content: [{ type: 'text', text: 7 }] },
    { role: 'user', content: [{ type: 'audio', data: 'x' }] },
    { role: 'user', content: [{ type: 'image_url' }] },
    { role: 'user', content: Array.from({ length: 65 }, () => ({ type: 'text', text: 'x' })) },
  ];
  for (const message of cases) {
    assertEquals(typeof checkMessageContents([message as { role: string; content: unknown }]), 'string', JSON.stringify(message).slice(0, 60));
  }
});

Deno.test('caps: pictures per request, per picture, and together — across messages, each by its own rule', () => {
  const many = Array.from({ length: MAX_CHAT_IMAGES }, () => picture());
  assertEquals(checkMessageContents([{ role: 'user', content: many }]), null);
  assertEquals(checkMessageContents([
    { role: 'user', content: many }, { role: 'user', content: [picture()] },
  ]), `A request may carry at most ${MAX_CHAT_IMAGES} pictures`);

  assertEquals(checkMessageContents([{ role: 'user', content: [picture(MAX_CHAT_IMAGE_CHARS)] }]),
    'A picture must be a data URL within the size limit');

  // Each just under the per-picture cap; five of them over the total.
  const big = Math.floor((MAX_CHAT_IMAGE_CHARS - 100) / 4) * 4;
  assertEquals(checkMessageContents([{ role: 'user', content: Array.from({ length: 5 }, () => picture(big)) }]),
    'The pictures together exceed the size limit');
});

Deno.test('every role but user is refused a picture, and any role may send text parts', () => {
  for (const role of ['system', 'assistant', 'tool', 'developer']) {
    assertEquals(checkMessageContents([{ role, content: [picture()] }]), 'Only a user message may carry a picture', role);
    assertEquals(checkMessageContents([{ role, content: [{ type: 'text', text: 'x' }] }]), null, role);
  }
});

Deno.test('a null part, a string image_url and a non-string url are refused', () => {
  assertEquals(typeof checkMessageContents([{ role: 'user', content: [null] }]), 'string');
  assertEquals(typeof checkMessageContents([{ role: 'user', content: [{ type: 'image_url', image_url: 'data:image/png;base64,AAAA' }] }]), 'string');
  assertEquals(typeof checkMessageContents([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 7 } }] }]), 'string');
});

Deno.test('a truncated base64 payload is refused here, not left for DeepSeek to reject vaguely', () => {
  assertEquals(typeof checkMessageContents([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAAA' } }] }]), 'string');
});

Deno.test('what is forwarded is rebuilt from the checked fields only — no detail, no extras', () => {
  assertEquals(normalizeMessageContent([
    { type: 'text', text: 'Image 1:', cache_control: { type: 'ephemeral' } },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'high' }, extra: 1 },
  ]), [
    { type: 'text', text: 'Image 1:' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
  ]);
  assertEquals(normalizeMessageContent('plain'), 'plain');
  assertEquals(normalizeMessageContent(null), null);
});

Deno.test('a body declaring more than the ceiling is refused before it is parsed', () => {
  const sized = (length?: number) => new Request('https://x.test', {
    method: 'POST', headers: length === undefined ? {} : { 'content-length': String(length) },
  });
  assertEquals(bodyTooLarge(sized(MAX_CHAT_BODY_BYTES + 1)), true);
  assertEquals(bodyTooLarge(sized(MAX_CHAT_BODY_BYTES)), false);
  assertEquals(bodyTooLarge(sized(1000)), false);
  // No declared length (chunked): let through to the content caps.
  assertEquals(bodyTooLarge(sized()), false);
});
