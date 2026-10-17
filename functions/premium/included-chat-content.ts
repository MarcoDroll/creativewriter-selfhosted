/**
 * What a message may carry on the Included AI chat route (`handleIncludedAiChat`).
 *
 * A string, as it always was — or, since #468, OpenAI-style content parts: text, and **inline**
 * pictures in a **user** message. DeepSeek's V4.1 Flash (`deepseek-flash`, the wire model since
 * the V4 alias was retired) reads `image_url` parts with thinking on or off; probed
 * 2026-10-02, a 64px PNG cost ~190 input tokens, and DeepSeek caps a picture at 1024 tokens. The
 * client's Prompt Improvement sends at most 6 pictures of ≤1024px, ≤200 KB each, so the caps here
 * sit well above what the app sends and well below what one request could cost the budget.
 *
 * **Inline `data:` pictures only.** An `https://` URL would have DeepSeek fetch it, which hands
 * the caller a request whose size and content this function never sees.
 */

/** The most pictures one request may carry. The app sends at most 6. */
export const MAX_CHAT_IMAGES = 8;
/** One picture's `data:` URL, in characters (~1.1 MB of bytes). The app's are ≤ ~270 KB. */
export const MAX_CHAT_IMAGE_CHARS = 1_500_000;
/** Every picture in the request together, in characters. */
export const MAX_CHAT_IMAGE_PAYLOAD_CHARS = 6_000_000;

/**
 * The most a chat request's body may be, in bytes, checked from `Content-Length` **before** it is
 * parsed: the picture total plus room for a long conversation's text. A body that declares no
 * length (chunked) is let through to the content caps, which still bound the pictures.
 */
export const MAX_CHAT_BODY_BYTES = MAX_CHAT_IMAGE_PAYLOAD_CHARS + 2_000_000;

export function bodyTooLarge(request: Request): boolean {
  const declared = Number(request.headers.get('content-length'));
  return Number.isFinite(declared) && declared > MAX_CHAT_BODY_BYTES;
}

const DATA_URL =/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * Check every message's content; `null` when they are all acceptable, else the reason, as the
 * 400's error text. Counts pictures across the whole request.
 */
export function checkMessageContents(messages: readonly { role?: unknown; content?: unknown }[]): string | null {
  let images = 0;
  let imageChars = 0;
  for (const message of messages) {
    const content = message.content;
    if (content === null || content === undefined || typeof content === 'string') continue;
    if (!Array.isArray(content)) return 'Message content must be a string, null or an array of parts';
    if (content.length > 64) return 'Message content exceeds maximum of 64 parts';
    for (const part of content) {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return 'Each content part must be an object';
      const record = part as Record<string, unknown>;
      if (record['type'] === 'text') {
        if (typeof record['text'] !== 'string') return 'A text part must carry a string text';
        continue;
      }
      if (record['type'] !== 'image_url') return 'A content part must be text or image_url';
      if (message.role !== 'user') return 'Only a user message may carry a picture';
      const imageUrl = record['image_url'];
      const url = imageUrl && typeof imageUrl === 'object' ? (imageUrl as Record<string, unknown>)['url'] : undefined;
      if (typeof url !== 'string' || url.length > MAX_CHAT_IMAGE_CHARS) return 'A picture must be a data URL within the size limit';
      // Whole base64 quads too: a truncated payload passes the pattern and would come back from
      // DeepSeek as a vague upstream error instead of this clear 400.
      if (!DATA_URL.test(url) || (url.length - url.indexOf(',') - 1) % 4 !== 0) {
        return 'A picture must be an inline JPEG, PNG, WebP or GIF data URL';
      }
      images++;
      imageChars += url.length;
      if (images > MAX_CHAT_IMAGES) return `A request may carry at most ${MAX_CHAT_IMAGES} pictures`;
      if (imageChars > MAX_CHAT_IMAGE_PAYLOAD_CHARS) return 'The pictures together exceed the size limit';
    }
  }
  return null;
}

/**
 * A message's content as it is forwarded, **after** {@link checkMessageContents} accepted it:
 * each part rebuilt from the fields that were checked, and nothing else. Without this, a field
 * nobody validated would reach DeepSeek — `image_url.detail: "high"` above all, which could cost
 * more per picture than the caps above were sized for.
 */
export function normalizeMessageContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map(part => {
    const record = part as Record<string, unknown>;
    if (record['type'] === 'text') return { type: 'text', text: record['text'] };
    const url = (record['image_url'] as Record<string, unknown>)['url'];
    return { type: 'image_url', image_url: { url } };
  });
}
