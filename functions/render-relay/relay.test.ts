/**
 * Deno tests for the render relay (ADR 0021, #799).
 *
 *   deno test --node-modules-dir=none --allow-env --allow-net supabase/functions/render-relay/
 *
 * Every side effect is a fake on {@link RelayDeps}: the store records rows and parked objects, the
 * fetch answers from a script and records every URL it was asked for. That last list is what the
 * host tests read — what this function may reach is the security property, not what it returns.
 */

import { assert, assertEquals, assertFalse } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  capMessage, handleRequest, isNanoGptPictureHost, pinnedStatusUrl, purgeStale, relayDeadlineMs, resetPurgeClock,
  sniffImageType, type RelayDeps, type RelayOutcome, type StartAnswer,
} from './relay.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const ID = '0b0e5f0e-8a8e-4f0c-9d55-2f6a1b7d3c11';
const USER = 'user-1';
const HEADERS = { 'Access-Control-Allow-Origin': 'https://creativewriter.dev' };

type Script = (url: string, init?: RequestInit) => Response | Promise<Response>;

interface Fake {
  deps: RelayDeps;
  rows: Map<string, { status: string; outcome?: RelayOutcome }>;
  parked: Map<string, string>;
  /** Every park ever asked for, kept after an unpark — "parks nothing" means never wrote, not wrote and took back. */
  parkCalls: string[];
  fetched: string[];
  waited: Promise<unknown>[];
  clock: { now: number };
}

function fake(script: Script, opts: { start?: StartAnswer; env?: Record<string, string>; stale?: string[] } = {}): Fake {
  const rows = new Map<string, { status: string; outcome?: RelayOutcome }>();
  const parked = new Map<string, string>();
  const parkCalls: string[] = [];
  const fetched: string[] = [];
  const waited: Promise<unknown>[] = [];
  const clock = { now: 1_000_000 };
  let stale = [...(opts.stale ?? [])];
  resetPurgeClock();
  const deps: RelayDeps = {
    store: {
      start(_jwt, id) {
        const answer = opts.start ?? (rows.has(id) ? 'duplicate' : 'started');
        if (answer === 'started') rows.set(id, { status: 'running' });
        return Promise.resolve(answer);
      },
      statusOf: id => Promise.resolve(rows.get(id)?.status ?? null),
      finish(id, outcome) {
        const row = rows.get(id);
        if (!row || row.status !== 'running') return Promise.resolve(false);
        rows.set(id, { status: outcome.status, outcome });
        return Promise.resolve(true);
      },
      park(path, _bytes, contentType) {
        parkCalls.push(path);
        parked.set(path, contentType);
        return Promise.resolve();
      },
      unpark(paths) {
        for (const path of paths) parked.delete(path);
        stale = stale.filter(path => !paths.includes(path));
        return Promise.resolve();
      },
      staleObjects: limit => Promise.resolve(stale.slice(0, limit)),
      deleteOldRows: () => Promise.resolve(0),
    },
    authenticate: () => Promise.resolve({ userId: USER }),
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      fetched.push(url);
      return Promise.resolve(script(url, init));
    }) as typeof fetch,
    waitUntil: work => { waited.push(work); },
    env: name => opts.env?.[name],
    sleep: ms => { clock.now += ms; return Promise.resolve(); },
    now: () => clock.now,
  };
  return { deps, rows, parked, parkCalls, fetched, waited, clock };
}

function relayRequest(provider: string, payload: unknown, extra: Record<string, string> = {}): Request {
  return new Request(`https://edge.test/functions/v1/render-relay/${provider}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer jwt', 'X-API-Key': 'own-key', 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify(payload),
  });
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

// --- fixed hosts --------------------------------------------------------------------------------

Deno.test('each provider goes to its own fixed host, whatever the body says', async () => {
  const cases: [string, string, string][] = [
    ['nanogpt', 'images/generations', 'https://nano-gpt.com/api/v1/images/generations'],
    ['venice', 'image/generate', 'https://api.venice.ai/api/v1/image/generate'],
    ['openrouter', 'images', 'https://openrouter.ai/api/v1/images'],
  ];
  for (const [provider, route, expected] of cases) {
    const f = fake(() => json(provider === 'venice' ? { images: [b64(PNG)] } : { data: [{ b64_json: b64(PNG) }] }));
    const response = await handleRequest(relayRequest(provider, {
      relayId: ID, route, body: { url: 'https://evil.test/', model: 'm' },
    }), HEADERS, f.deps);
    assertEquals(response.status, 200);
    assertEquals(f.fetched, [expected]);
  }
});

Deno.test('a route the provider does not have is refused before anything starts', async () => {
  const f = fake(() => json({}));
  const response = await handleRequest(relayRequest('nanogpt', { relayId: ID, route: '../../evil', body: {} }), HEADERS, f.deps);
  assertEquals(response.status, 400);
  assertEquals(f.fetched, []);
  assertEquals(f.rows.size, 0);
});

Deno.test('an unknown provider is a 404 and reaches nothing', async () => {
  const f = fake(() => json({}));
  const response = await handleRequest(relayRequest('example.com', { relayId: ID, route: 'x', body: {} }), HEADERS, f.deps);
  assertEquals(response.status, 404);
  assertEquals(f.fetched, []);
});

Deno.test('the author\'s key goes upstream as a bearer, and no other request header follows it', async () => {
  let sent: Headers | undefined;
  const f = fake((_url, init) => {
    sent = new Headers(init?.headers);
    return json({ data: [{ b64_json: b64(PNG) }] });
  });
  await handleRequest(relayRequest('nanogpt', { relayId: ID, route: 'images/generations', body: {} }, { Cookie: 'c=1' }), HEADERS, f.deps);
  assertEquals(sent?.get('Authorization'), 'Bearer own-key');
  assertEquals(sent?.get('Cookie'), null);
});

// --- NanoGPT's 202 ------------------------------------------------------------------------------

Deno.test('pinnedStatusUrl: only https://nano-gpt.com, exactly', () => {
  assertEquals(pinnedStatusUrl('/api/status/abc'), 'https://nano-gpt.com/api/status/abc');
  assertEquals(pinnedStatusUrl('https://nano-gpt.com/api/status/abc?t=1'), 'https://nano-gpt.com/api/status/abc?t=1');
  assertEquals(pinnedStatusUrl('https://nano-gpt.com.evil.test/x'), null);
  assertEquals(pinnedStatusUrl('https://evil.test/x'), null);
  assertEquals(pinnedStatusUrl('http://nano-gpt.com/x'), null);
  assertEquals(pinnedStatusUrl('https://nano-gpt.com:8443/x'), null);
  assertEquals(pinnedStatusUrl('https://user:pw@nano-gpt.com/x'), null);
  assertEquals(pinnedStatusUrl('//evil.test/x'), null);
  assertEquals(pinnedStatusUrl(42), null);
});

Deno.test('a 202 is collected from its status URL, which is fetched without following redirects', async () => {
  const inits: RequestInit[] = [];
  let asks = 0;
  const f = fake((url, init) => {
    if (url.endsWith('/images/generations')) {
      return json({ status: 'processing', submissions: [{ statusCheckUrl: 'https://nano-gpt.com/api/status/s1' }] }, 202);
    }
    inits.push(init ?? {});
    asks++;
    return asks < 2 ? json({ status: 'processing' }, 202) : json({ data: [{ b64_json: b64(PNG) }] });
  });
  const response = await handleRequest(relayRequest('nanogpt', { relayId: ID, route: 'images/generations', body: {} }), HEADERS, f.deps);
  const outcome = await response.json() as RelayOutcome;
  assertEquals(outcome.status, 'done');
  assertEquals(f.fetched.slice(1), ['https://nano-gpt.com/api/status/s1', 'https://nano-gpt.com/api/status/s1']);
  assert(inits.every(init => init.redirect === 'manual'));
});

Deno.test('a status check that gets no answer is asked again, not a failed render NanoGPT has billed', async () => {
  let asks = 0;
  const f = fake(url => {
    if (url.endsWith('/images/generations')) {
      return json({ status: 'processing', submissions: [{ statusCheckUrl: '/api/status/s1' }] }, 202);
    }
    asks++;
    if (asks === 1) throw new TypeError('connection reset');
    return json({ data: [{ b64_json: b64(PNG) }] });
  });
  const outcome = await (await handleRequest(relayRequest('nanogpt', { relayId: ID, route: 'images/generations', body: {} }), HEADERS, f.deps)).json();
  assertEquals(outcome.status, 'done');
  assertEquals(asks, 2);
});

Deno.test('the pictures are parked one by one; a non-picture after a good one takes the parked one back out', async () => {
  const f = fake(() => json({ images: [b64(PNG), btoa('<html>')] }));
  const outcome = await (await handleRequest(relayRequest('venice', { relayId: ID, route: 'image/generate', body: {} }), HEADERS, f.deps)).json();
  assertEquals(outcome.status, 'failed');
  assertEquals(f.parkCalls, [`${USER}/${ID}/0.png`]);
  assertEquals(f.parked.size, 0);
});

Deno.test('a 202 whose status URL is off nano-gpt.com fails without fetching it', async () => {
  const f = fake(url => url.endsWith('/images/generations')
    ? json({ status: 'processing', submissions: [{ statusCheckUrl: 'https://evil.test/status' }] }, 202)
    : json({ data: [{ b64_json: b64(PNG) }] }));
  const outcome = await (await handleRequest(relayRequest('nanogpt', { relayId: ID, route: 'images/generations', body: {} }), HEADERS, f.deps)).json();
  assertEquals(outcome.status, 'failed');
  assertEquals(outcome.code, 'provider-unavailable');
  assertEquals(f.fetched.length, 1);
});

Deno.test('a redirect from the status URL is refused, never followed', async () => {
  const f = fake(url => url.endsWith('/images/generations')
    ? json({ status: 'processing', submissions: [{ statusCheckUrl: '/api/status/s1' }] }, 202)
    : new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/' } }));
  const outcome = await (await handleRequest(relayRequest('nanogpt', { relayId: ID, route: 'images/generations', body: {} }), HEADERS, f.deps)).json();
  assertEquals(outcome.status, 'failed');
  assertFalse(f.fetched.some(url => url.includes('169.254')));
});

Deno.test('a NanoGPT picture link is fetched only from its own storage', () => {
  assert(isNanoGptPictureHost(new URL('https://abc123.r2.cloudflarestorage.com/image-generations/x.png')));
  assert(isNanoGptPictureHost(new URL('https://nano-gpt.com/files/x.png')));
  assertFalse(isNanoGptPictureHost(new URL('http://abc123.r2.cloudflarestorage.com/x')));
  assertFalse(isNanoGptPictureHost(new URL('https://r2.cloudflarestorage.com.evil.test/x')));
  assertFalse(isNanoGptPictureHost(new URL('https://kong:8000/storage/v1/object')));
  assertFalse(isNanoGptPictureHost(new URL('https://abc.r2.cloudflarestorage.com:444/x')));
});

// --- the deadline -------------------------------------------------------------------------------

Deno.test('relayDeadlineMs: 380 s by default, and never closer than 20 s to the platform limit', () => {
  assertEquals(relayDeadlineMs(() => undefined), 380_000);
  assertEquals(relayDeadlineMs(name => ({ RELAY_PLATFORM_LIMIT_MS: '150000' })[name]), 130_000);
  assertEquals(relayDeadlineMs(name => ({ RELAY_DEADLINE_MS: '999999' })[name]), 380_000);
  assertEquals(relayDeadlineMs(name => ({ RELAY_DEADLINE_MS: '60000' })[name]), 60_000);
  assertEquals(relayDeadlineMs(name => ({ RELAY_DEADLINE_MS: 'nonsense' })[name]), 380_000);
});

Deno.test('a 202 that never finishes becomes failed/provider-timeout at the deadline', async () => {
  const f = fake(url => url.endsWith('/images/generations')
    ? json({ status: 'processing', submissions: [{ statusCheckUrl: '/api/status/s1' }] }, 202)
    : json({ status: 'processing' }, 202), { env: { RELAY_DEADLINE_MS: '30000' } });
  const outcome = await (await handleRequest(relayRequest('nanogpt', { relayId: ID, route: 'images/generations', body: {} }), HEADERS, f.deps)).json();
  assertEquals(outcome.status, 'failed');
  assertEquals(outcome.code, 'provider-timeout');
  assertEquals(f.rows.get(ID)?.status, 'failed');
});

Deno.test('an upstream that never answers is aborted at the deadline and the row fails', async () => {
  const f = fake((_url, init) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }), { env: { RELAY_DEADLINE_MS: '1000' } });
  const outcome = await (await handleRequest(relayRequest('venice', { relayId: ID, route: 'image/generate', body: {} }), HEADERS, f.deps)).json();
  assertEquals(outcome.code, 'provider-timeout');
  assertEquals(f.rows.get(ID)?.status, 'failed');
});

// --- start: duplicate and busy ------------------------------------------------------------------

Deno.test('a replayed id answers 409 and renders nothing', async () => {
  const f = fake(() => json({ data: [{ b64_json: b64(PNG) }] }));
  const first = await handleRequest(relayRequest('nanogpt', { relayId: ID, route: 'images/generations', body: {} }), HEADERS, f.deps);
  assertEquals(first.status, 200);
  const again = await handleRequest(relayRequest('nanogpt', { relayId: ID, route: 'images/generations', body: {} }), HEADERS, f.deps);
  assertEquals(again.status, 409);
  assertEquals(await again.json(), { relay: 'duplicate' });
  assertEquals(f.fetched.length, 1);
});

Deno.test('past the running cap the start answers 429 and nothing is fetched', async () => {
  const f = fake(() => json({}), { start: 'busy' });
  const response = await handleRequest(relayRequest('openrouter', { relayId: ID, route: 'images', body: {} }), HEADERS, f.deps);
  assertEquals(response.status, 429);
  assertEquals((await response.json()).code, 'rate-limited');
  assertEquals(f.fetched, []);
});

Deno.test('the render runs under waitUntil, so a dropped client does not stop it', async () => {
  const f = fake(() => json({ data: [{ b64_json: b64(PNG) }] }));
  await handleRequest(relayRequest('nanogpt', { relayId: ID, route: 'images/generations', body: {} }), HEADERS, f.deps);
  assert(f.waited.length >= 1);
  assertEquals((await f.waited[0] as RelayOutcome).status, 'done');
});

Deno.test('no key, no JSON or no relayId: refused before a row starts', async () => {
  const f = fake(() => json({}));
  const noKey = new Request('https://edge.test/render-relay/nanogpt', {
    method: 'POST', headers: { Authorization: 'Bearer jwt' }, body: JSON.stringify({ relayId: ID, route: 'images/generations', body: {} }),
  });
  assertEquals((await handleRequest(noKey, HEADERS, f.deps)).status, 401);
  assertEquals((await handleRequest(relayRequest('nanogpt', { relayId: 'not-a-uuid', route: 'images/generations', body: {} }), HEADERS, f.deps)).status, 400);
  assertEquals(f.rows.size, 0);
});

Deno.test('a render that outlasts the hold answers 202 running, and still finishes its row', async () => {
  let release: (response: Response) => void = () => undefined;
  const f = fake(() => new Promise<Response>(resolve => { release = resolve; }), { env: { RELAY_HOLD_MS: '20' } });
  const response = await handleRequest(relayRequest('nanogpt', { relayId: ID, route: 'images/generations', body: {} }), HEADERS, f.deps);
  assertEquals(response.status, 202);
  assertEquals(await response.json(), { relay: 'running' });
  assertEquals(f.rows.get(ID)?.status, 'running');
  release(json({ data: [{ b64_json: b64(PNG) }] }));
  await f.waited[0];
  assertEquals(f.rows.get(ID)?.status, 'done');
});

// --- results ------------------------------------------------------------------------------------

Deno.test('bytes are always parked under <user>/<relayId>/, never returned inline', async () => {
  const f = fake(() => json({ images: [b64(PNG), b64(JPEG)] }));
  const response = await handleRequest(relayRequest('venice', { relayId: ID, route: 'image/generate', body: {} }), HEADERS, f.deps);
  const text = await response.text();
  const outcome = JSON.parse(text) as RelayOutcome;
  assertEquals(outcome.status, 'done');
  assertEquals(outcome.paths, [`${USER}/${ID}/0.png`, `${USER}/${ID}/1.jpg`]);
  assertEquals([...f.parked.entries()], [[`${USER}/${ID}/0.png`, 'image/png'], [`${USER}/${ID}/1.jpg`, 'image/jpeg']]);
  assertFalse(text.includes(b64(PNG)));
  assertEquals(f.rows.get(ID)?.outcome?.paths, outcome.paths);
});

Deno.test('Venice multi-edit\'s raw bytes are parked as the picture they are', async () => {
  const f = fake(() => new Response(JPEG, { status: 200, headers: { 'Content-Type': 'image/jpeg' } }));
  const outcome = await (await handleRequest(relayRequest('venice', { relayId: ID, route: 'image/multi-edit', body: {} }), HEADERS, f.deps)).json();
  assertEquals(outcome.paths, [`${USER}/${ID}/0.jpg`]);
});

Deno.test('Venice\'s content-violation header fails the row as moderation and parks nothing', async () => {
  const f = fake(() => json({ images: [b64(PNG)] }, 200, { 'x-venice-is-content-violation': 'true' }));
  const outcome = await (await handleRequest(relayRequest('venice', { relayId: ID, route: 'image/generate', body: {} }), HEADERS, f.deps)).json();
  assertEquals(outcome.status, 'failed');
  assertEquals(outcome.code, 'moderation');
  assertEquals(f.parked.size, 0);
});

Deno.test('OpenRouter\'s hosted url is kept as a link, as the direct call kept it', async () => {
  const f = fake(() => json({ data: [{ url: 'https://cdn.openrouter.test/x.png' }] }));
  const outcome = await (await handleRequest(relayRequest('openrouter', { relayId: ID, route: 'images', body: {} }), HEADERS, f.deps)).json();
  assertEquals(outcome.urls, ['https://cdn.openrouter.test/x.png']);
  assertEquals(f.fetched, ['https://openrouter.ai/api/v1/images']);
});

Deno.test('NanoGPT\'s url fallback is downloaded from its storage and parked', async () => {
  const f = fake(url => url.includes('r2.cloudflarestorage.com')
    ? new Response(PNG, { status: 200 })
    : json({ data: [{ url: 'https://abc.r2.cloudflarestorage.com/image-generations/x' }] }));
  const outcome = await (await handleRequest(relayRequest('nanogpt', { relayId: ID, route: 'images/generations', body: {} }), HEADERS, f.deps)).json();
  assertEquals(outcome.paths, [`${USER}/${ID}/0.png`]);
});

Deno.test('a provider refusal keeps its status and its own words, for the client\'s ladder', async () => {
  const f = fake(() => json({ error: { message: 'Insufficient balance' } }, 402));
  const outcome = await (await handleRequest(relayRequest('nanogpt', { relayId: ID, route: 'images/generations', body: {} }), HEADERS, f.deps)).json();
  assertEquals(outcome.status, 'failed');
  assertEquals(outcome.httpStatus, 402);
  assertEquals(outcome.code, undefined);
  assertEquals(JSON.parse(outcome.message).error.message, 'Insufficient balance');
});

Deno.test('something that is not a picture is never parked', async () => {
  const f = fake(() => json({ data: [{ b64_json: btoa('<html>') }] }));
  const outcome = await (await handleRequest(relayRequest('nanogpt', { relayId: ID, route: 'images/generations', body: {} }), HEADERS, f.deps)).json();
  assertEquals(outcome.status, 'failed');
  assertEquals(f.parked.size, 0);
});

// --- cancel -------------------------------------------------------------------------------------

Deno.test('a row cancelled while the render ran parks nothing', async () => {
  let f: Fake;
  f = fake(() => {
    f.rows.set(ID, { status: 'cancelled' });
    return json({ data: [{ b64_json: b64(PNG) }] });
  });
  const outcome = await (await handleRequest(relayRequest('nanogpt', { relayId: ID, route: 'images/generations', body: {} }), HEADERS, f.deps)).json();
  assertEquals(outcome.status, 'cancelled');
  assertEquals(f.parkCalls, []);
  assertEquals(f.rows.get(ID)?.status, 'cancelled');
});

Deno.test('a cancel that lands after the pictures were parked takes them back out', async () => {
  const f = fake(() => json({ data: [{ b64_json: b64(PNG) }] }));
  const park = f.deps.store.park;
  f.deps.store.park = async (path, bytes, type) => {
    await park(path, bytes, type);
    f.rows.set(ID, { status: 'cancelled' });
  };
  const outcome = await (await handleRequest(relayRequest('nanogpt', { relayId: ID, route: 'images/generations', body: {} }), HEADERS, f.deps)).json();
  assertEquals(outcome.status, 'cancelled');
  assertEquals(f.parked.size, 0);
});

// --- purge --------------------------------------------------------------------------------------

Deno.test('the purge route needs the service-role key', async () => {
  const f = fake(() => json({}), { env: { SUPABASE_SERVICE_ROLE_KEY: 'service' }, stale: ['u/r/0.png'] });
  const denied = await handleRequest(new Request('https://edge.test/render-relay/purge', {
    method: 'POST', headers: { Authorization: 'Bearer jwt' },
  }), HEADERS, f.deps);
  assertEquals(denied.status, 401);
  const allowed = await handleRequest(new Request('https://edge.test/render-relay/purge', {
    method: 'POST', headers: { Authorization: 'Bearer service' },
  }), HEADERS, f.deps);
  assertEquals(allowed.status, 200);
  assertEquals((await allowed.json()).objects, 1);
});

Deno.test('purgeStale removes every stale object it is shown, in chunks', async () => {
  const stale = Array.from({ length: 250 }, (_, i) => `u/r${i}/0.png`);
  const f = fake(() => json({}), { stale });
  const removedChunks: number[] = [];
  const unpark = f.deps.store.unpark;
  f.deps.store.unpark = paths => { removedChunks.push(paths.length); return unpark(paths); };
  assertEquals((await purgeStale(f.deps)).objects, 250);
  assertEquals(removedChunks, [100, 100, 50]);
});

// --- small pure helpers -------------------------------------------------------------------------

Deno.test('sniffImageType knows PNG, JPEG and WebP, and nothing else', () => {
  assertEquals(sniffImageType(PNG), 'image/png');
  assertEquals(sniffImageType(JPEG), 'image/jpeg');
  assertEquals(sniffImageType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assertEquals(sniffImageType(new TextEncoder().encode('<svg>')), null);
});

Deno.test('capMessage holds a message under the table\'s 1 KB check without splitting a character', () => {
  const long = 'é'.repeat(800);
  const capped = capMessage(long);
  assert(new TextEncoder().encode(capped).length <= 1000);
  assertEquals(capped, 'é'.repeat(500));
  assertEquals(capMessage('short'), 'short');
});
