# Administration

With a self-hosted instance, you control the entire stack and are responsible for backups, upgrades, and monitoring. All data stays in Docker volumes on your server.

## Backup

Always back up before upgrading to a new version.

### Database

```bash
docker compose -f docker-compose.stable.yml exec db pg_dump -U supabase_admin postgres > backup.sql
```

### Restore Database

```bash
cat backup.sql | docker compose -f docker-compose.stable.yml exec -T db psql -U supabase_admin postgres
```

### Storage

```bash
docker compose -f docker-compose.stable.yml cp storage:/var/lib/storage ./storage-backup
```

## Upgrading

Your data is stored in Docker named volumes (`db-data`, `storage-data`) which persist across container restarts and image updates.

```bash
# 1. Pull the latest compose file and config
git pull

# 2. Pull updated container images
docker compose -f docker-compose.stable.yml pull

# 3. Restart with new images (data volumes are preserved)
docker compose -f docker-compose.stable.yml up -d
```

If environment variables changed between versions, add `--force-recreate`:

```bash
docker compose -f docker-compose.stable.yml up -d --force-recreate
```

> **Warning:** Never use `docker compose down -v` on an existing installation — the `-v` flag deletes all data volumes. Use `docker compose down` (without `-v`) to stop services while keeping data.

> Skipping `git pull` is the most common cause of "table not found" / REST 404 errors after an upgrade — `docker compose pull` only refreshes images, not the host-mounted `volumes/db/migrations/` directory. See [Migrate service issues](troubleshooting.md) if this happens.

### Upgrading the Supabase stack (pinned images)

The compose file pins **every** Supabase image, so the routine `git pull && docker compose pull && up -d` above only moves *within* those pins — it does **not** jump Postgres or GoTrue to a new major version, and none of the 2026 upstream breaking changes below are hit until you deliberately bump a pin.

Current pins (`docker/docker-compose.yml`):

| Service | Image |
|---------|-------|
| Database | `supabase/postgres:15.8.1.085` |
| Auth (GoTrue) | `supabase/gotrue:v2.186.0` |
| REST | `postgrest/postgrest:v14.5` |
| Realtime | `supabase/realtime:v2.76.5` |
| Storage | `supabase/storage-api:v1.37.8` |
| Edge Functions | `supabase/edge-runtime:v1.70.3` |
| Studio | `supabase/studio:20240326-5e5586d` |
| Postgres Meta | `supabase/postgres-meta:v0.84.2` |
| Kong (gateway) | `kong:2.8.1` |

**Before bumping any pin, back up (see [Backup](#backup)) and review the upstream release notes and the [Supabase self-hosting guide](https://supabase.com/docs/guides/self-hosting) for the target version.** Do not treat the notes below as exact edit instructions — they flag *what to verify*, because some upstream change summaries are imprecise. The relevant 2026 breaking changes:

- **Postgres 15 → 17** (2026-05-18): a major-version jump. Named volumes are **not** upgraded in place — plan a `pg_dump`/restore or use Supabase's guided major-version upgrade path. Verify extension compatibility first. The Studio image below is also very stale (`2024-03-26`) and should be bumped in the same maintenance window.
- **Studio DB role `supabase_admin` → `postgres`** (2026-05-18): newer Studio/postgres-meta images connect as a different role. Only relevant when you bump `studio`/`meta`; re-check the meta service's DB connection env against the upstream compose.
- **`API_EXTERNAL_URL` / `/auth/v1` auth-path change** (2026-06-18): before bumping `gotrue`, re-verify the GoTrue env (`API_EXTERNAL_URL`, `GOTRUE_SITE_URL`, the `GOTRUE_MAILER_URLPATHS_*` values) and the Kong `/auth/v1/` route against the upstream self-hosting guide — an auth-path mismatch breaks sign-in and email links silently.
- **Analytics & Vector opt-in** (2026-05-18): **N/A for this stack.** The compose file runs neither an `analytics` (Logflare) nor a `vector` service, so the "analytics is now opt-in / requires a key" changes do not apply here — no action, and no need to re-investigate.

After any bump, recreate with `--force-recreate` and confirm each service comes up (`docker compose ... ps` and `logs`), then run a smoke test (sign in, open a story, generate). See also the upstream [Supabase changelog](https://supabase.com/changelog).

## Authentication security

### Leaked-password protection (HaveIBeenPwned)

Supabase Auth can reject passwords that appear in the [HaveIBeenPwned](https://haveibeenpwned.com) breach corpus. For a password-auth app this is a high-value, one-toggle protection.

- **Hosted (managed Supabase projects):** enable **Authentication → Policies → "Leaked password protection"** in the dashboard. This is a **per-project** setting and cannot be set from code or migrations — it must be flipped in the dashboard for **each** project (dev and prod). The security advisor flags it as `auth_leaked_password_protection` while disabled — see the [remediation guide](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection). Re-run `get_advisors type=security` afterwards to confirm the warning clears.
- **Self-hosted (this Docker stack):** the bundled GoTrue image exposes an equivalent HIBP password check via its own configuration. It is **not** enabled in `docker/docker-compose.yml` today; before turning it on, verify the exact GoTrue setting for the pinned image against the upstream [GoTrue / Auth password-security docs](https://supabase.com/docs/guides/auth/password-security) rather than assuming an env-var name.

## Supabase Studio

Studio (database admin UI) starts automatically on port **54323**, bound to `127.0.0.1` for security.

- Local access: `http://localhost:54323`
- Remote access via SSH tunnel: `ssh -L 54323:localhost:54323 your-server`

## Viewing Logs

```bash
# All services
docker compose -f docker-compose.stable.yml logs

# Specific service
docker compose -f docker-compose.stable.yml logs <service>

# Follow logs
docker compose -f docker-compose.stable.yml logs -f <service>
```

Replace `<service>` with: `frontend`, `db`, `auth`, `rest`, `realtime`, `storage`, `functions`, `kong`, `studio`, `meta`.

## Optional Services

### imgproxy (Image Transforms)

```bash
docker compose -f docker-compose.stable.yml --profile imgproxy up -d
```
