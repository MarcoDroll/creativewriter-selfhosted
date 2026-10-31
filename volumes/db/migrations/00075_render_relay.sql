-- The render relay (ADR 0021, issue #799): a render that survives the phone locking.
--
-- NanoGPT, Venice and OpenRouter answer a render in ONE request that takes 30–130 s, and Android
-- Chrome cuts a backgrounded tab's connections — so a Studio render was lost whenever the screen
-- locked, often after the provider had billed it. The `render-relay` Edge Function makes that
-- request instead, under `EdgeRuntime.waitUntil`, and writes the outcome here. The client named the
-- row (`id`, a uuid it made) and stored that name as the job's resume handle BEFORE the request left,
-- so a cut connection is collected later by the existing resume sweep.
--
-- One row per relayed request; no picture bytes in the database. A finished render's pictures are
-- parked in the private `render-relay` bucket at `<user>/<id>/<i>` (`paths`); `urls` is for a
-- provider whose links a browser can read (Included AI's fal CDN, issue #800).
--
-- Written only by the function: rows start through `start_render_relay` (the user's JWT, so
-- `auth.uid()` is the author) and finish through the service role. The client reads its own row
-- through `read_render_relay`, which also says how old the row is by the SERVER's clock, and
-- cancels through `cancel_render_relay`. No client INSERT/UPDATE/DELETE grant at all.
--
-- **Deliberately not in the `supabase_realtime` publication.** Nothing watches it live: the tab that
-- is still connected gets the function's own answer, and a tab coming back reads its row once.
--
-- Cost (supabase-cost.md, "Render relay"): < 1 KB per render, cleared after 2 hours; parked bytes are
-- deleted by the client right after it saved them, or by the function's purge after an hour.
--
-- Replay-safe: `if not exists`, policies and triggers dropped first, functions `create or replace`
-- with stable return types, bucket insert `on conflict do nothing`, the cron job guarded.

create table if not exists public.render_relay (
  id          uuid        primary key,
  user_id     uuid        not null references auth.users(id) on delete cascade,
  provider    text        not null check (provider in ('nanogpt', 'venice', 'openrouter', 'included')),
  status      text        not null default 'running'
                          check (status in ('running', 'done', 'failed', 'cancelled')),
  -- A failure the relay itself named (`provider-timeout`, `moderation`, …), or none: then
  -- `http_status` and `message` are the provider's own answer, which the client classifies with the
  -- same ladder as a direct call.
  code        text        check (code is null or char_length(code) <= 64),
  http_status smallint    check (http_status is null or http_status between 100 and 599),
  message     text        check (message is null or octet_length(message) <= 1024),
  urls        text[]      check (urls is null or cardinality(urls) <= 16),
  paths       text[]      check (paths is null or cardinality(paths) <= 16),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- The running cap's count (`start_render_relay`) and the purge both read by user and age.
create index if not exists render_relay_user_status_created_idx
  on public.render_relay (user_id, status, created_at);
create index if not exists render_relay_created_idx
  on public.render_relay (created_at);

alter table public.render_relay enable row level security;

drop policy if exists "Users read own render relay" on public.render_relay;
create policy "Users read own render relay"
  on public.render_relay for select
  using (auth.uid() = user_id);

drop trigger if exists set_updated_at on public.render_relay;
create trigger set_updated_at before update on public.render_relay
  for each row execute function public.update_updated_at();

-- Data API visibility: read-own only. Every write goes through the functions below or the service role.
GRANT SELECT ON TABLE public.render_relay TO authenticated;
GRANT ALL    ON TABLE public.render_relay TO service_role;

-- ----------------------------------------------------------------------------
-- Start a relayed render. Answers:
--   'started'   — the row is in, go render;
--   'duplicate' — this id exists already (a retried request, a double tap): the render is under way
--                 or done, so the caller collects it and must NOT render again;
--   'busy'      — the author already has 8 renders running (the eight-pictures cap). Only rows
--                 younger than 7 minutes count, so a row a killed worker never finished blocks no one.
-- An advisory lock on the author makes the count and the insert one step, so parallel requests and
-- double taps cannot both pass the cap.
-- ----------------------------------------------------------------------------
create or replace function public.start_render_relay(p_id uuid, p_provider text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  running integer;
begin
  if me is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('render_relay:' || me::text, 0));
  if exists (select 1 from public.render_relay where id = p_id) then
    return 'duplicate';
  end if;
  select count(*) into running
    from public.render_relay
   where user_id = me
     and status = 'running'
     and created_at > now() - interval '7 minutes';
  if running >= 8 then
    return 'busy';
  end if;
  insert into public.render_relay (id, user_id, provider) values (p_id, me, p_provider);
  return 'started';
end;
$$;

REVOKE EXECUTE ON FUNCTION public.start_render_relay(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.start_render_relay(uuid, text) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The author's own row, with its age by the database's clock — so a phone whose clock is wrong
-- cannot call a running render timed out, or a stuck one alive. No row: gone (cleared, or never
-- the caller's).
-- ----------------------------------------------------------------------------
create or replace function public.read_render_relay(p_id uuid)
returns table (
  status      text,
  code        text,
  http_status smallint,
  message     text,
  urls        text[],
  paths       text[],
  age_seconds integer
)
language sql
stable
security definer
set search_path = public
as $$
  select r.status, r.code, r.http_status, r.message, r.urls, r.paths,
         extract(epoch from (now() - r.created_at))::integer
    from public.render_relay r
   where r.id = p_id
     and r.user_id = auth.uid();
$$;

REVOKE EXECUTE ON FUNCTION public.read_render_relay(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.read_render_relay(uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- The author cancelled. Only a running row changes: one that already finished keeps its outcome,
-- and the caller then releases its parked pictures.
--
-- A row that does not exist YET — the cancel overtook the request, which is still on its way to the
-- function — gets a 'cancelled' tombstone, so the start that arrives after it answers 'duplicate' and
-- nothing is rendered or billed. Should the start win the race between the two statements, the update
-- is tried once more.
--
-- Returns true when nothing can be parked for this render (it was running, or had not started), false
-- when it had already finished (or is not the caller's): the caller then releases what it parked.
-- ----------------------------------------------------------------------------
create or replace function public.cancel_render_relay(p_id uuid, p_provider text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  touched integer;
begin
  if me is null then
    return false;
  end if;
  update public.render_relay set status = 'cancelled'
   where id = p_id and user_id = me and status = 'running';
  get diagnostics touched = row_count;
  if touched > 0 then
    return true;
  end if;
  if p_provider in ('nanogpt', 'venice', 'openrouter', 'included') then
    insert into public.render_relay (id, user_id, provider, status)
    values (p_id, me, p_provider, 'cancelled')
    on conflict (id) do nothing;
    get diagnostics touched = row_count;
    if touched > 0 then
      return true;
    end if;
    update public.render_relay set status = 'cancelled'
     where id = p_id and user_id = me and status = 'running';
    get diagnostics touched = row_count;
    return touched > 0;
  end if;
  return false;
end;
$$;

REVOKE EXECUTE ON FUNCTION public.cancel_render_relay(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.cancel_render_relay(uuid, text) TO authenticated;

-- ----------------------------------------------------------------------------
-- Parked pictures older than an hour, for the function's purge to delete through the Storage API
-- (a direct DELETE on storage.objects would leave the files behind). Service role only.
-- ----------------------------------------------------------------------------
create or replace function public.stale_render_relay_objects(p_limit integer default 500)
returns setof text
language sql
stable
security definer
set search_path = public, storage
as $$
  select o.name
    from storage.objects o
   where o.bucket_id = 'render-relay'
     and o.created_at < now() - interval '1 hour'
   order by o.created_at
   limit greatest(1, least(p_limit, 1000));
$$;

REVOKE EXECUTE ON FUNCTION public.stale_render_relay_objects(integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stale_render_relay_objects(integer) TO service_role;

-- ----------------------------------------------------------------------------
-- The private bucket. 15 MB per object bounds the worst case (a 4K PNG is ~12 MB); only the
-- function (service role) writes, the author reads and deletes their own folder.
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('render-relay', 'render-relay', false, 15728640,
        array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "Users read own render relay objects" on storage.objects;
create policy "Users read own render relay objects"
  on storage.objects for select
  using (bucket_id = 'render-relay' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "Users delete own render relay objects" on storage.objects;
create policy "Users delete own render relay objects"
  on storage.objects for delete
  using (bucket_id = 'render-relay' and (storage.foldername(name))[1] = auth.uid()::text);

-- ----------------------------------------------------------------------------
-- Rows older than two hours go, hourly. pg_cron is not on every plan or every self-hosted image, so
-- guarded like 00025; without it the function's purge clears old rows along with their objects.
-- ----------------------------------------------------------------------------
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'purge_render_relay',
      '17 * * * *',
      'DELETE FROM public.render_relay WHERE created_at < now() - interval ''2 hours'''
    );
  ELSE
    RAISE NOTICE 'pg_cron not available — skipping render_relay purge job; the render-relay function clears old rows.';
  END IF;
END;
$migration$;
