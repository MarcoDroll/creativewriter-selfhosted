-- Renders in progress, announced to the author's other devices (ADR 0018, amending ADR 0010).
--
-- One row per open Image & Video Studio tab. The tab that started (or resumed) a Render writes a
-- SNAPSHOT of what it is watching — prompt, model, phase, a stripped provider handle — and the
-- author's other devices read it through Realtime and show "Rendering on iPhone · Safari" at the
-- head of their history rail. **No picture or source bytes travel here** (ADR 0005 stands): a
-- snapshot is a few KB at most, capped below by a check the client never reaches.
--
-- A snapshot per tab rather than a row per Render, because a tab already knows the whole of what
-- it is watching and can say it in one upsert; a per-Render lifecycle would need inserts, updates
-- and deletes that each have to reach the database for the rows to stay true, and a tab that is
-- frozen or closed mid-lifecycle would strand them. A snapshot that stops being written simply
-- ages: the reader says "No word since …" and then hides it.
--
-- `cancel_requests` is how another device asks this tab to cancel a Render it cannot cancel
-- directly. It is changed ONLY through the two functions below, never by a client
-- read-modify-write, so an append and a clear cannot race each other into losing a request.
--
-- Cost (supabase-cost.md): ~4–8 writes per Render, 0.5–3 KB each, delivered by Realtime to each of
-- the author's open sessions. Zero writes while nothing renders. Storage: a handful of tiny rows
-- per author; a new tab reuses one of its device's rows unwritten for a day (claim_render_watch_row).
--
-- Replay-safe: `if not exists`, every policy and trigger dropped first, functions
-- `create or replace` with a stable return type, the publication add guarded.

create table if not exists public.image_render_watch (
  user_id         uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  device_id       text        not null check (char_length(device_id) between 1 and 64),
  tab_id          text        not null check (char_length(tab_id) between 1 and 64),
  device_label    text        not null default '' check (char_length(device_label) <= 60),
  -- `{ v, at, renders: [...], recent: [...] }` — see `render-watch/snapshot.ts`.
  snapshot        jsonb       not null default '{}'::jsonb
                              check (octet_length(snapshot::text) <= 16384),
  -- `[{ renderId, by, at }]`
  cancel_requests jsonb       not null default '[]'::jsonb
                              check (jsonb_typeof(cancel_requests) = 'array'
                                     and octet_length(cancel_requests::text) <= 4096),
  updated_at      timestamptz not null default now(),
  primary key (user_id, device_id, tab_id)
);

alter table public.image_render_watch enable row level security;

drop policy if exists "Users read own render watch" on public.image_render_watch;
create policy "Users read own render watch"
  on public.image_render_watch for select
  using (auth.uid() = user_id);

drop policy if exists "Users insert own render watch" on public.image_render_watch;
create policy "Users insert own render watch"
  on public.image_render_watch for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users update own render watch" on public.image_render_watch;
create policy "Users update own render watch"
  on public.image_render_watch for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Users delete own render watch" on public.image_render_watch;
create policy "Users delete own render watch"
  on public.image_render_watch for delete
  using (auth.uid() = user_id);

drop trigger if exists set_updated_at on public.image_render_watch;
create trigger set_updated_at before update on public.image_render_watch
  for each row execute function public.update_updated_at();

-- Data API visibility (required since 2026-05-30 — see coding-standards.md)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.image_render_watch TO authenticated;
GRANT ALL                            ON TABLE public.image_render_watch TO service_role;

-- ----------------------------------------------------------------------------
-- Ask a tab to cancel one Render. A no-op when that Render is already asked for, and when the
-- tab's list is full (16 — far past the 7 Renders a tab can have in flight), so the 4 KB check is
-- never what refuses a write. Returns whether a row of the caller's took the request.
-- ----------------------------------------------------------------------------
create or replace function public.append_cancel_request(
  p_device text, p_tab text, p_render_id text, p_by text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  touched integer;
begin
  if auth.uid() is null or p_render_id is null or char_length(p_render_id) not between 1 and 64 then
    return false;
  end if;
  update public.image_render_watch w
     set cancel_requests = w.cancel_requests || jsonb_build_array(jsonb_build_object(
           'renderId', p_render_id,
           'by', left(coalesce(p_by, ''), 60),
           'at', (extract(epoch from now()) * 1000)::bigint))
   where w.user_id = auth.uid()
     and w.device_id = p_device
     and w.tab_id = p_tab
     and jsonb_array_length(w.cancel_requests) < 16
     -- `by` is cut to 60 characters, and four bytes each is possible: count bytes, so a full list
     -- answers `false` rather than a check violation.
     and octet_length(w.cancel_requests::text) + 256 + octet_length(left(coalesce(p_by, ''), 60)) <= 4096
     and not exists (
       select 1 from jsonb_array_elements(w.cancel_requests) r where r->>'renderId' = p_render_id);
  get diagnostics touched = row_count;
  return touched > 0;
end;
$$;

-- ----------------------------------------------------------------------------
-- The tab has seen these requests — acted on or not — and takes them off its list.
-- ----------------------------------------------------------------------------
create or replace function public.clear_cancel_requests(
  p_device text, p_tab text, p_ids text[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or p_ids is null or cardinality(p_ids) = 0 then
    return;
  end if;
  update public.image_render_watch w
     set cancel_requests = coalesce((
           select jsonb_agg(r)
             from jsonb_array_elements(w.cancel_requests) r
            where not ((r->>'renderId') = any (p_ids))), '[]'::jsonb)
   where w.user_id = auth.uid()
     and w.device_id = p_device
     and w.tab_id = p_tab
     and exists (
       select 1 from jsonb_array_elements(w.cancel_requests) r where (r->>'renderId') = any (p_ids));
end;
$$;

-- ----------------------------------------------------------------------------
-- A new tab takes over ONE of this device's rows unwritten for a day — its tab id renamed, its
-- contents emptied — before its first snapshot. A tab id lives in session storage and goes with its
-- tab, so without this every tab that ever rendered would leave a row behind for good.
--
-- An UPDATE, deliberately not a DELETE: Realtime cannot filter a delete by `user_id` on a table
-- without `replica identity full`, nor apply row-level security to one, so a client-side tidy-up
-- delete would be broadcast past the author's own sessions. Rows still pile up only as far as the
-- most tabs a device has open within a day. Returns whether a row was taken over.
-- ----------------------------------------------------------------------------
create or replace function public.claim_render_watch_row(p_device text, p_tab text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  touched integer;
begin
  if auth.uid() is null or p_tab is null or char_length(p_tab) not between 1 and 64 then
    return false;
  end if;
  if exists (select 1 from public.image_render_watch
              where user_id = auth.uid() and device_id = p_device and tab_id = p_tab) then
    return false;
  end if;
  update public.image_render_watch w
     set tab_id = p_tab, snapshot = '{}'::jsonb, cancel_requests = '[]'::jsonb
   where (w.user_id, w.device_id, w.tab_id) = (
     select o.user_id, o.device_id, o.tab_id from public.image_render_watch o
      where o.user_id = auth.uid() and o.device_id = p_device
        and o.updated_at < now() - interval '24 hours'
      order by o.updated_at
      limit 1);
  get diagnostics touched = row_count;
  return touched > 0;
exception
  -- Another tab of this device claimed the same id meanwhile: nothing to take over.
  when unique_violation then
    return false;
end;
$$;

REVOKE EXECUTE ON FUNCTION public.append_cancel_request(text, text, text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.clear_cancel_requests(text, text, text[]) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.claim_render_watch_row(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.append_cancel_request(text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.clear_cancel_requests(text, text, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_render_watch_row(text, text) TO authenticated;

-- ----------------------------------------------------------------------------
-- Realtime. `alter publication … add table` errors when the table is already in it, so it is
-- guarded (00056 explains why a bare add cannot be replayed). A database with no
-- `supabase_realtime` publication at all — a bare Postgres — is left alone.
-- ----------------------------------------------------------------------------
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'image_render_watch')
  THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.image_render_watch;
  END IF;
END
$migration$;
