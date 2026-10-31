/**
 * The render relay (ADR 0021, issue #799): a Studio render that survives the phone locking.
 *
 * NanoGPT, Venice and OpenRouter answer a render in ONE request that takes 30–130 s, and Android
 * Chrome cuts a backgrounded tab's connections, so the picture was lost — often after it was billed.
 * The client now names the render first (`relayId`, a uuid it stores as the job's resume handle
 * before the request leaves) and sends the provider's request here. This function makes it, under
 * `EdgeRuntime.waitUntil` so a dropped client does not stop it, and writes the outcome to the
 * `render_relay` row. A client still connected gets the same outcome as its answer; one that was
 * cut reads the row when it comes back (`RenderRelayService.collect`).
 *
 * - **Fixed upstream hosts.** The client names a provider and one of that provider's routes; the
 *   URL is built here. Nothing in the request can point this function anywhere else.
 * - **Pictures are always parked** in the private `render-relay` bucket, never returned inline: the
 *   function cannot know whether its answer arrived, so the bytes must outlive it either way. The
 *   client downloads them once and deletes them (`release`).
 * - **A provider's refusal is data, not an error of ours**: the row keeps its HTTP status and its
 *   own words, and the client classifies them with the same ladder as a direct call.
 * - **Never logs** a header, a body, a prompt or a key.
 *
 * Pure of `Deno.serve` and of Supabase clients — everything with a side effect comes in through
 * {@link RelayDeps}, so the tests drive it in-process.
 */

import { jsonResponse } from '../_shared/cors.ts';
import type { ErrorResponse } from '../_shared/types.ts';

export type RelayProvider = 'nanogpt' | 'venice' | 'openrouter';

/** Each provider's routes, and the one host each is sent to. */
const UPSTREAM: Readonly<Record<RelayProvider, { base: string; routes: readonly string[] }>> = {
  nanogpt: { base: 'https://nano-gpt.com/api/v1/', routes: ['images/generations'] },
  venice: { base: 'https://api.venice.ai/api/v1/', routes: ['image/generate', 'image/multi-edit'] },
  openrouter: { base: 'https://openrouter.ai/api/v1/', routes: ['images'] },
};

/** The most pictures one row parks: the eight-per-render cap with room, and the table's own check. */
const MAX_PICTURES = 16;
/** The table checks `message` at 1 KB; cut below it, on a character boundary. */
const MAX_MESSAGE_BYTES = 1000;
/** The platform's wall clock for one invocation: hosted paid plans and self-hosted (Q3) both allow 400 s. */
const DEFAULT_PLATFORM_LIMIT_MS = 400_000;
const DEFAULT_DEADLINE_MS = 380_000;
/** What the deadline always leaves before the platform's own limit, for the row's last write. */
const DEADLINE_MARGIN_MS = 20_000;
/**
 * How long the handler holds the connection before answering `202 {relay: 'running'}`. Hosted Supabase
 * answers 504 for a request that has sent nothing for 150 s, while the worker itself may run 400 s: past
 * this the client stops waiting and collects the row, and the render carries on under `waitUntil`.
 */
const DEFAULT_HOLD_MS = 140_000;
/** NanoGPT's 202: first asked after this, growing to the second — as the client's own collect does. */
const POLL_FIRST_MS = 3_000;
const POLL_MAX_MS = 8_000;
/** A stale parked picture is purged at most this often per isolate, piggybacking on real requests. */
const PURGE_EVERY_MS = 10 * 60_000;

export type StartAnswer = 'started' | 'duplicate' | 'busy';

/** One row's outcome — the function's answer and what `read_render_relay` returns, field for field. */
export interface RelayOutcome {
  status: 'done' | 'failed' | 'cancelled';
  code?: string;
  httpStatus?: number;
  message?: string;
  urls?: string[];
  paths?: string[];
}

/** Everything with a side effect. `index.ts` wires the real ones. */
export interface RelayStore {
  /** `start_render_relay`, as the author (their JWT), so `auth.uid()` owns the row. */
  start(jwt: string, id: string, provider: RelayProvider): Promise<StartAnswer>;
  /** The row's status, or null when it is gone. Service role. */
  statusOf(id: string): Promise<string | null>;
  /** Write a finished outcome **only if the row is still running**. Answers whether it was. */
  finish(id: string, outcome: RelayOutcome): Promise<boolean>;
  park(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  unpark(paths: string[]): Promise<void>;
  /** Parked objects older than an hour (`stale_render_relay_objects`). */
  staleObjects(limit: number): Promise<string[]>;
  /** Rows older than two hours, for an install without pg_cron. Answers how many went. */
  deleteOldRows(): Promise<number>;
}

export interface RelayDeps {
  store: RelayStore;
  /** The author's user id, or the 401 to answer with. */
  authenticate(request: Request, headers: Record<string, string>): Promise<{ userId: string } | Response>;
  fetch: typeof fetch;
  waitUntil(work: Promise<unknown>): void;
  env(name: string): string | undefined;
  sleep(ms: number): Promise<void>;
  now(): number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The relay's own deadline: `RELAY_DEADLINE_MS` (default 380 s), always 20 s inside the platform's limit. */
export function relayDeadlineMs(env: (name: string) => string | undefined): number {
  const platform = positive(env('RELAY_PLATFORM_LIMIT_MS')) ?? DEFAULT_PLATFORM_LIMIT_MS;
  const wanted = positive(env('RELAY_DEADLINE_MS')) ?? DEFAULT_DEADLINE_MS;
  return Math.max(1_000, Math.min(wanted, platform - DEADLINE_MARGIN_MS));
}

function positive(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

let lastPurge = 0;

/** For the tests: forget when the last opportunistic purge ran. */
export function resetPurgeClock(): void {
  lastPurge = 0;
}

/**
 * `POST /render-relay/<provider>` with `{relayId, route, body}` and the author's key in `X-API-Key`,
 * or `POST /render-relay/purge` with the service-role key.
 *
 * Answers 200 with the {@link RelayOutcome}; 202 `{relay: 'running'}` when the render outlasts the hold;
 * 409 `{relay: 'duplicate'}` for an id already started; an `ErrorResponse` for a request refused before
 * anything started.
 */
export async function handleRequest(request: Request, headers: Record<string, string>, deps: RelayDeps): Promise<Response> {
  const segment = new URL(request.url).pathname.split('/').filter(Boolean).pop() ?? '';
  if (request.method !== 'POST') return error('Method not allowed', 405, headers);
  if (segment === 'purge') return await purgeRoute(request, headers, deps);
  if (!(segment in UPSTREAM)) return error('Unknown provider', 404, headers);
  const provider = segment as RelayProvider;

  const auth = await deps.authenticate(request, headers);
  if (auth instanceof Response) return auth;
  const jwt = (request.headers.get('Authorization') ?? '').slice('Bearer '.length);

  const apiKey = request.headers.get('X-API-Key');
  if (!apiKey) return error('Missing X-API-Key header', 401, headers, 'api-key-invalid');

  let payload: { relayId?: unknown; route?: unknown; body?: unknown };
  try {
    payload = await request.json();
  } catch {
    return error('The request is not JSON', 400, headers);
  }
  const relayId = typeof payload?.relayId === 'string' && UUID.test(payload.relayId) ? payload.relayId.toLowerCase() : null;
  const route = typeof payload?.route === 'string' && UPSTREAM[provider].routes.includes(payload.route) ? payload.route : null;
  const body = payload?.body && typeof payload.body === 'object' && !Array.isArray(payload.body) ? payload.body : null;
  if (!relayId || !route || !body) return error('relayId, route and body are required', 400, headers);

  let started: StartAnswer;
  try {
    started = await deps.store.start(jwt, relayId, provider);
  } catch {
    return error('The render could not be started', 502, headers, 'provider-unavailable');
  }
  // **Never a failure**: this id is already under way (a retried request, a double tap), and a second
  // render would be billed twice. The client reads 409 as "go collect".
  if (started === 'duplicate') return jsonResponse({ relay: 'duplicate' }, 409, headers);
  if (started === 'busy') {
    return error('Eight renders are already running. Wait for one to finish.', 429, headers, 'rate-limited');
  }

  const work = render({ relayId, userId: auth.userId, provider, route, body, apiKey, origin: request.headers.get('Origin') }, deps);
  deps.waitUntil(work);
  maybePurge(deps);
  const hold = positive(deps.env('RELAY_HOLD_MS')) ?? DEFAULT_HOLD_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const held = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), hold); });
  try {
    const outcome = await Promise.race([work, held]);
    // Still rendering: the client collects the row when it is written.
    return outcome ? jsonResponse(outcome, 200, headers) : jsonResponse({ relay: 'running' }, 202, headers);
  } finally {
    clearTimeout(timer);
  }
}

interface RenderJob {
  relayId: string;
  userId: string;
  provider: RelayProvider;
  route: string;
  body: object;
  apiKey: string;
  origin: string | null;
}

/** One picture, its bytes and type. */
interface Picture {
  bytes: Uint8Array;
  contentType: string;
}

/**
 * Where one picture's bytes will come from — held as the provider sent it until its turn to be parked.
 *
 * **One picture's bytes at a time**, because a worker has 256 MB: eight 4K PNGs are ~128 MB of base64,
 * and decoding them all before parking any held that twice over. The base64 strings stay referenced
 * (they are slices of the parsed answer), but each decoded copy is dropped as soon as it is parked.
 */
type PictureSource =
  | { readonly base64: string }
  | { readonly bytes: Uint8Array }
  | { readonly nanoGptLink: string };

/** Make the render, park what it made and write the row. Never rejects. */
export async function render(job: RenderJob, deps: RelayDeps): Promise<RelayOutcome> {
  const deadline = deps.now() + relayDeadlineMs(deps.env);
  let outcome: RelayOutcome;
  try {
    outcome = await renderOnce(job, deadline, deps);
  } catch (caught) {
    outcome = caught instanceof RelayFailure
      ? caught.outcome
      : { status: 'failed', code: 'provider-unavailable', message: 'The render relay could not finish this render.' };
  }
  try {
    if (outcome.status === 'cancelled' || !(await deps.store.finish(job.relayId, outcome))) {
      // Cancelled while it ran: nothing stays parked for a render nobody is waiting for.
      if (outcome.paths?.length) await deps.store.unpark(outcome.paths);
      return { status: 'cancelled' };
    }
  } catch {
    // The row could not be written. The client sees it running until it times out; nothing better to do here.
  }
  return outcome;
}

class RelayFailure extends Error {
  constructor(readonly outcome: RelayOutcome) {
    super(outcome.message ?? outcome.code ?? 'failed');
  }
}

function fail(code: string | undefined, message: string, httpStatus?: number): RelayFailure {
  return new RelayFailure({
    status: 'failed',
    ...(code ? { code } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    message: capMessage(message),
  });
}

async function renderOnce(job: RenderJob, deadline: number, deps: RelayDeps): Promise<RelayOutcome> {
  const url = UPSTREAM[job.provider].base + job.route;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${job.apiKey}`,
    'Content-Type': 'application/json',
  };
  if (job.provider === 'openrouter') {
    // What the browser-direct call sent: OpenRouter attributes the request to the app with these.
    headers['HTTP-Referer'] = job.origin ?? 'https://creativewriter.dev';
    headers['X-Title'] = 'Creative Writer';
  }
  const response = await timed(deps, deadline, signal => deps.fetch(url, {
    method: 'POST', headers, body: JSON.stringify(job.body), signal,
  }));
  if (!response.ok) throw await upstreamFailure(response);
  if (job.provider === 'venice' && response.headers.get('x-venice-is-content-violation') === 'true') {
    await response.body?.cancel();
    throw fail('moderation', 'Venice declined to generate this image');
  }

  let sources: PictureSource[];
  let urls: string[] = [];
  if (job.provider === 'venice' && job.route === 'image/multi-edit') {
    // Venice's edit route answers with the raw picture, not JSON.
    const bytes = new Uint8Array(await timed(deps, deadline, () => response.arrayBuffer()));
    sources = bytes.length ? [{ bytes }] : [];
  } else {
    let parsed = await readJson(response, deps, deadline);
    if (job.provider === 'nanogpt' && response.status === 202) {
      parsed = await collectNanoGpt(parsed, deadline, deps);
    }
    ({ sources, urls } = picturesOf(job.provider, parsed));
  }
  if (!sources.length && !urls.length) throw fail('provider-unavailable', 'The provider answered without a picture.');
  if (sources.length + urls.length > MAX_PICTURES) {
    sources = sources.slice(0, MAX_PICTURES);
    urls = urls.slice(0, Math.max(0, MAX_PICTURES - sources.length));
  }

  // Asked once more before anything is written: a render cancelled while it ran parks nothing.
  if ((await deps.store.statusOf(job.relayId)) !== 'running') return { status: 'cancelled' };
  const paths: string[] = [];
  try {
    for (const [index, source] of sources.entries()) {
      const picture = await pictureOf(source, deadline, deps);
      if (!picture.contentType) {
        throw fail('provider-unavailable', 'The provider answered with something that is not a picture.');
      }
      const path = `${job.userId}/${job.relayId}/${index}.${extensionOf(picture.contentType)}`;
      try {
        await deps.store.park(path, picture.bytes, picture.contentType);
      } catch {
        throw fail('provider-unavailable', 'The finished picture could not be stored. The provider may still have billed it.');
      }
      paths.push(path);
    }
  } catch (caught) {
    if (paths.length) await deps.store.unpark(paths).catch(() => undefined);
    throw caught;
  }
  return { status: 'done', ...(paths.length ? { paths } : {}), ...(urls.length ? { urls } : {}) };
}

/** One source's bytes, decoded or downloaded only now, at its turn to be parked. */
async function pictureOf(source: PictureSource, deadline: number, deps: RelayDeps): Promise<Picture> {
  if ('bytes' in source) return { bytes: source.bytes, contentType: sniffImageType(source.bytes) ?? '' };
  if ('base64' in source) return decodePicture(source.base64);
  return await downloadNanoGptPicture(source.nanoGptLink, deadline, deps);
}

/**
 * The pictures in a provider's JSON answer.
 * - NanoGPT and OpenRouter: `data[].b64_json`; NanoGPT's `url` (a fallback when it cannot give bytes) is
 *   fetched here, because its storage sends no CORS header a browser could read it by; OpenRouter's
 *   hosted `url` is kept as a link, as the direct call always kept it.
 * - Venice `image/generate`: `images[]`, bare base64.
 */
function picturesOf(provider: RelayProvider, body: unknown): { sources: PictureSource[]; urls: string[] } {
  const sources: PictureSource[] = [];
  const urls: string[] = [];
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  if (provider === 'venice') {
    for (const item of Array.isArray(record['images']) ? record['images'] : []) {
      if (typeof item === 'string' && item) sources.push({ base64: item });
    }
    return { sources, urls };
  }
  for (const item of Array.isArray(record['data']) ? record['data'] : []) {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    if (typeof row['b64_json'] === 'string' && row['b64_json']) {
      sources.push({ base64: row['b64_json'] });
    } else if (typeof row['url'] === 'string' && row['url']) {
      if (provider === 'openrouter') urls.push(row['url']);
      else sources.push({ nanoGptLink: row['url'] });
    }
  }
  return { sources, urls };
}

/** Where a NanoGPT picture link may point: its own host, or the Cloudflare R2 storage it serves from (measured 2026-10-30). */
export function isNanoGptPictureHost(url: URL): boolean {
  return url.protocol === 'https:' && !url.port && (
    url.hostname === 'nano-gpt.com' || url.hostname.endsWith('.nano-gpt.com')
    || url.hostname.endsWith('.r2.cloudflarestorage.com'));
}

async function downloadNanoGptPicture(link: string, deadline: number, deps: RelayDeps): Promise<Picture> {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw fail('provider-unavailable', 'NanoGPT answered with a picture link that is not a URL.');
  }
  if (!isNanoGptPictureHost(url)) throw fail('provider-unavailable', 'NanoGPT answered with a picture link outside its own storage.');
  const response = await timed(deps, deadline, signal => deps.fetch(url.toString(), { redirect: 'manual', signal }));
  if (!response.ok) {
    await response.body?.cancel();
    throw fail('provider-unavailable', `The finished picture could not be downloaded (${response.status}).`);
  }
  const bytes = new Uint8Array(await timed(deps, deadline, () => response.arrayBuffer()));
  return { bytes, contentType: sniffImageType(bytes) ?? '' };
}

/**
 * NanoGPT answered `202 {"status": "processing", "submissions": [{statusCheckUrl}]}`: ask that URL until
 * it hands back the picture, or the deadline passes.
 *
 * **Pinned to `https://nano-gpt.com`, exactly**, and fetched with `redirect: 'manual'`: the URL comes
 * from a response, and a function that followed it anywhere would be a way into wherever this runs.
 * No key goes with it — the URL carries its own token. Only an explicit failure or the deadline stops
 * it; a blip (no answer, a reset), a 429 or a 5xx is asked again, as the client's own collect does —
 * NanoGPT has the render, and probably billed it.
 */
async function collectNanoGpt(accepted: unknown, deadline: number, deps: RelayDeps): Promise<unknown> {
  const submission = (accepted as { submissions?: { statusCheckUrl?: unknown }[] } | null)?.submissions?.[0];
  const statusUrl = pinnedStatusUrl(submission?.statusCheckUrl);
  if (!statusUrl) throw fail('provider-unavailable', 'NanoGPT answered 202 without a status address on nano-gpt.com.');
  let interval = POLL_FIRST_MS;
  while (deps.now() < deadline) {
    await deps.sleep(Math.min(interval, Math.max(0, deadline - deps.now())));
    interval = Math.min(Math.round(interval * 1.5), POLL_MAX_MS);
    if (deps.now() >= deadline) break;
    let response: Response;
    let text: string;
    try {
      response = await timed(deps, deadline, signal => deps.fetch(statusUrl, { redirect: 'manual', signal }));
      text = await timed(deps, deadline, () => response.text());
    } catch (caught) {
      // Only the deadline ends the wait; `timed` codes every other failure `provider-unavailable`, a blip.
      if (caught instanceof RelayFailure && caught.outcome.code === 'provider-timeout') throw caught;
      continue;
    }
    if (response.status === 202 || response.status === 429 || response.status >= 500) continue;
    // A redirect (`manual` hands it back as 3xx or an opaque 0) is refused, never followed.
    if (response.status < 200 || response.status >= 300) {
      throw fail(response.status === 402 ? 'provider-balance-low' : undefined, text || `NanoGPT answered ${response.status}`, response.status);
    }
    let body: { data?: unknown[]; status?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      continue;
    }
    if (Array.isArray(body?.data) && body.data.length) return body;
    if (body?.status === 'failed' || body?.status === 'error') throw fail(undefined, text, 422);
  }
  throw timeoutFailure();
}

/** A status address from NanoGPT's 202, or null for one that is not exactly `https://nano-gpt.com/...`. */
export function pinnedStatusUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const url = new URL(raw, 'https://nano-gpt.com');
    return url.protocol === 'https:' && url.host === 'nano-gpt.com' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function timeoutFailure(): RelayFailure {
  return fail('provider-timeout', 'The provider did not finish this render in time. It may still be billed.');
}

/** Run one step against the deadline: past it, the step is aborted and the render is a timeout. */
async function timed<T>(deps: RelayDeps, deadline: number, step: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const remaining = deadline - deps.now();
  if (remaining <= 0) throw timeoutFailure();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutFailure());
    }, remaining);
  });
  try {
    return await Promise.race([step(controller.signal), expired]);
  } catch (caught) {
    if (caught instanceof RelayFailure) throw caught;
    if (controller.signal.aborted) throw timeoutFailure();
    throw fail('provider-unavailable', 'The provider could not be reached.');
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response: Response, deps: RelayDeps, deadline: number): Promise<unknown> {
  const text = await timed(deps, deadline, () => response.text());
  try {
    return JSON.parse(text);
  } catch {
    throw fail('provider-unavailable', 'The provider answered with something that is not JSON.');
  }
}

/** A provider's non-2xx: its status and its own words, for the client's ladder. */
async function upstreamFailure(response: Response): Promise<RelayFailure> {
  const text = await response.text().catch(() => '');
  return fail(undefined, text || `The provider answered ${response.status}`, response.status);
}

/** Bare base64, or a `data:` URL, as bytes and the type its leading bytes say. */
function decodePicture(encoded: string): Picture {
  const comma = encoded.startsWith('data:') ? encoded.indexOf(',') : -1;
  let bytes: Uint8Array;
  try {
    const binary = atob(comma >= 0 ? encoded.slice(comma + 1) : encoded);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    throw fail('provider-unavailable', 'The provider answered with a picture that could not be decoded.');
  }
  return { bytes, contentType: sniffImageType(bytes) ?? '' };
}

/** PNG, JPEG or WebP by magic bytes — the bucket takes those three only — or null. */
export function sniffImageType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

function extensionOf(contentType: string): string {
  return contentType === 'image/jpeg' ? 'jpg' : contentType === 'image/webp' ? 'webp' : 'png';
}

/** At most {@link MAX_MESSAGE_BYTES} of UTF-8, cut on a character. */
export function capMessage(message: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(message).length <= MAX_MESSAGE_BYTES) return message;
  let cut = message.slice(0, MAX_MESSAGE_BYTES);
  while (encoder.encode(cut).length > MAX_MESSAGE_BYTES) cut = cut.slice(0, -1);
  return cut;
}

function error(message: string, status: number, headers: Record<string, string>, code?: ErrorResponse['code']): Response {
  return jsonResponse<ErrorResponse>({ error: message, ...(code ? { code } : {}) }, status, headers);
}

// --- purge ----------------------------------------------------------------------------------------

/**
 * Delete parked pictures older than an hour, and rows older than two (an install without pg_cron).
 *
 * A picture is normally deleted by its own client seconds after it was saved; what is left here is a
 * render whose tab never came back, or came back past the hour (`relay-expired`). Through the Storage
 * API, because a DELETE on `storage.objects` would leave the files behind.
 */
export async function purgeStale(deps: RelayDeps): Promise<{ objects: number; rows: number }> {
  let objects = 0;
  for (let round = 0; round < 5; round++) {
    const stale = await deps.store.staleObjects(500);
    if (!stale.length) break;
    for (let i = 0; i < stale.length; i += 100) await deps.store.unpark(stale.slice(i, i + 100));
    objects += stale.length;
    if (stale.length < 500) break;
  }
  const rows = await deps.store.deleteOldRows();
  return { objects, rows };
}

/** At most once per {@link PURGE_EVERY_MS} per isolate, on the back of a real render, never in its way. */
function maybePurge(deps: RelayDeps): void {
  const now = deps.now();
  if (now - lastPurge < PURGE_EVERY_MS) return;
  lastPurge = now;
  deps.waitUntil(purgeStale(deps).catch(() => undefined));
}

/** `POST /render-relay/purge` — for a scheduler or an operator, with the service-role key as the bearer. */
async function purgeRoute(request: Request, headers: Record<string, string>, deps: RelayDeps): Promise<Response> {
  const expected = deps.env('SUPABASE_SERVICE_ROLE_KEY');
  const given = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/, '');
  if (!expected || !given || !(await sameSecret(given, expected))) return error('Not allowed', 401, headers, 'auth-required');
  try {
    return jsonResponse(await purgeStale(deps), 200, headers);
  } catch {
    return error('The purge did not finish', 502, headers, 'provider-unavailable');
  }
}

/** Compare two secrets by their SHA-256, so the comparison takes the same time whatever they share. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i];
  return difference === 0;
}
