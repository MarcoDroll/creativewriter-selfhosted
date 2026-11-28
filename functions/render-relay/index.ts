import { corsHeaders, handleCorsPreflightIfNeeded } from '../_shared/cors.ts';
import { extractAuthFromRequest } from '../_shared/auth.ts';
import { rateLimitResponse } from '../_shared/rate-limit.ts';
import { getAdminClient } from '../_shared/supabase-admin.ts';
import { getUserClient } from '../_shared/supabase-user.ts';
import { STORAGE_BUCKET_RENDER_RELAY } from '../_shared/storage.ts';
import { handleRequest, type RelayDeps, type RelayStore, type StartAnswer } from './relay.ts';

// Injected by the edge runtime, hosted and self-hosted alike; declared for the type-checker only.
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

/** The real side effects: the author's client to start a row, the service role for everything after. */
const store: RelayStore = {
  async start(jwt, id, provider) {
    const { data, error } = await getUserClient(jwt).rpc('start_render_relay', { p_id: id, p_provider: provider });
    if (error) throw error;
    return data as StartAnswer;
  },
  async statusOf(id) {
    const { data, error } = await getAdminClient().from('render_relay').select('status').eq('id', id).maybeSingle();
    if (error) throw error;
    return (data?.status as string | undefined) ?? null;
  },
  async finish(id, outcome) {
    const { data, error } = await getAdminClient().from('render_relay')
      .update({
        status: outcome.status,
        code: outcome.code ?? null,
        http_status: outcome.httpStatus ?? null,
        message: outcome.message ?? null,
        urls: outcome.urls ?? null,
        paths: outcome.paths ?? null,
      })
      .eq('id', id)
      .eq('status', 'running')
      .select('id');
    if (error) throw error;
    return (data?.length ?? 0) > 0;
  },
  async park(path, bytes, contentType) {
    const { error } = await getAdminClient().storage.from(STORAGE_BUCKET_RENDER_RELAY)
      .upload(path, bytes, { contentType, upsert: true });
    if (error) throw error;
  },
  async unpark(paths) {
    const { error } = await getAdminClient().storage.from(STORAGE_BUCKET_RENDER_RELAY).remove(paths);
    if (error) throw error;
  },
  async staleObjects(limit) {
    const { data, error } = await getAdminClient().rpc('stale_render_relay_objects', { p_limit: limit });
    if (error) throw error;
    return (data as string[] | null) ?? [];
  },
  async deleteOldRows() {
    const { data, error } = await getAdminClient().from('render_relay')
      .delete()
      .lt('created_at', new Date(Date.now() - 2 * 60 * 60_000).toISOString())
      .select('id');
    if (error) throw error;
    return data?.length ?? 0;
  },
};

const deps: RelayDeps = {
  store,
  authenticate: async (request, headers) => {
    const auth = await extractAuthFromRequest(request, headers);
    return auth instanceof Response ? auth : { userId: auth.userId };
  },
  fetch: (input, init) => fetch(input, init),
  // Without it (an old local runtime) the handler still awaits the render; only a dropped client is no longer covered.
  waitUntil: work => {
    if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(work);
  },
  env: name => Deno.env.get(name),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

Deno.serve(async (request: Request) => {
  const headers = corsHeaders(request.headers.get('Origin') || '');
  const preflight = handleCorsPreflightIfNeeded(request, headers);
  if (preflight) return preflight;
  // A render is one request, so this is a bound on abuse, not on polling — there is none.
  const limited = rateLimitResponse(request, headers, 30, 60_000, 'render-relay');
  if (limited) return limited;
  return await handleRequest(request, headers, deps);
});
