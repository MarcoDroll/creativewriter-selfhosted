# Architecture

CreativeWriter Self-Hosted runs as a set of Docker containers managed by Docker Compose. All data — stories, characters, media, auth credentials — is stored locally in Docker volumes on your server. No data leaves your infrastructure unless you explicitly configure an external AI provider.

## Docker Services

| Service | Image | Purpose |
|---------|-------|---------|
| `frontend` | `ghcr.io/marcodroll/creativewriter-selfhosted` | Angular SPA + nginx reverse proxy. Serves the app and proxies API requests to Kong |
| `db` | `supabase/postgres:15.8.1.085` | PostgreSQL 15 database with `wal_level=logical` for Realtime |
| `auth` | `supabase/gotrue:v2.186.0` | Supabase Auth (GoTrue) — email/password authentication, session management |
| `rest` | `postgrest/postgrest:v14.5` | PostgREST — auto-generated REST API from the PostgreSQL schema |
| `realtime` | `supabase/realtime:v2.76.5` | Supabase Realtime — cross-device/cross-tab sync via postgres_changes |
| `storage` | `supabase/storage-api:v1.37.8` | Supabase Storage — file uploads (story media, user backgrounds) |
| `functions` | `supabase/edge-runtime:v1.70.3` | Deno Edge Functions — Stripe webhooks, premium features, AI proxies |
| `kong` | `kong:2.8.1` | API gateway — routes requests to auth, rest, storage, realtime, and functions |
| `studio` | `supabase/studio:20240326-5e5586d` | Supabase Studio — database admin UI on port 54323 (localhost only) |
| `meta` | `supabase/postgres-meta:v0.84.2` | PG Meta — required by Studio for database introspection |
| `migrate` | `supabase/postgres:15.8.1.085` | One-shot container that applies database migrations on startup |
| `imgproxy` | `darthsim/imgproxy:v3.8.0` | Image transforms (optional, enabled via `--profile imgproxy`) |

## Data Volumes

| Volume | Purpose |
|--------|---------|
| `db-data` | PostgreSQL data directory |
| `storage-data` | Uploaded files (story media, user backgrounds) |

Both volumes persist across container restarts and image updates. Never use `docker compose down -v` on an existing installation — the `-v` flag deletes all data.

## Network

All services communicate on a single Docker bridge network named `creativewriter`. Only the `frontend` (port 3000), `db` (port 5432, localhost only), and `studio` (port 54323, localhost only) expose ports to the host.

## Request Flow

```
Browser → frontend (nginx :3000)
  ├── Static files → served directly
  └── /auth/*, /rest/*, /storage/*, /realtime/*, /functions/* → kong (:8000)
        ├── /auth/*     → auth (GoTrue :9999)
        ├── /rest/*     → rest (PostgREST :3000)
        ├── /storage/*  → storage (:5000)
        ├── /realtime/* → realtime (:4000)
        └── /functions/* → functions (Deno :9000)
```

## Database

PostgreSQL stores stories in three tables (stories, chapters, scenes) for granular reads/writes. Row-Level Security (RLS) enforces `auth.uid() = user_id` on every table, with `user_id` denormalized on child tables.

## Edge Functions

The `functions` service mounts `supabase/functions/` read-only and runs with `VERIFY_JWT=false` (JWT verification is handled internally by each function). Key functions:

- `stripe` — Stripe webhooks, billing portal, subscription verification, license key generation
- `premium` — Premium feature access and AI proxying
- `proxy-*` — AI provider proxies
