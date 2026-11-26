-- Migration: Codex entry "Illustration reference"
--
-- One optional extra reference picture per codex entry. When the author
-- illustrates a beat, it replaces the entry's active portrait as the picture
-- sent to the image model. See ADR 0023.
--
-- Deliberately a separate table, not a column on codex_entries:
--   * codex_entries is in the supabase_realtime publication, so a column there
--     would ship up to ~100 KB with every row change to every open session.
--     This table is NOT added to the publication.
--   * it keeps the bytes out of every hot select, the portrait gallery and the
--     portrait data-URL cache by construction.
--   * "does this entry have one?" is a plain `select entry_id where codex_id=…`.
--
-- The image is ONE inline PortraitGalleryItem (jsonb), held to the portrait
-- budget (~75 KB / 512 px) by the client; the CHECK is the server-side ceiling.

create table if not exists public.codex_entry_illustration_references (
  entry_id   uuid primary key references public.codex_entries(id) on delete cascade,
  codex_id   uuid not null references public.codexes(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  image      jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_ceir_codex_id on public.codex_entry_illustration_references(codex_id);
create index if not exists idx_ceir_user_id  on public.codex_entry_illustration_references(user_id);

alter table public.codex_entry_illustration_references
  drop constraint if exists codex_entry_illustration_references_image_size;
alter table public.codex_entry_illustration_references
  add constraint codex_entry_illustration_references_image_size
  check (octet_length(image::text) <= 400000);

alter table public.codex_entry_illustration_references enable row level security;

drop policy if exists "ceir_owner_all" on public.codex_entry_illustration_references;
create policy "ceir_owner_all"
  on public.codex_entry_illustration_references for all
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop trigger if exists set_updated_at on public.codex_entry_illustration_references;
create trigger set_updated_at
  before update on public.codex_entry_illustration_references
  for each row execute function public.update_updated_at();

grant select, insert, update, delete on table public.codex_entry_illustration_references to authenticated;
grant all on table public.codex_entry_illustration_references to service_role;
