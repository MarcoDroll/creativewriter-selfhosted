# CreativeWriter Self-Hosted

Run CreativeWriter on your own server with Docker Compose. Self-hosting gives you full control over your data — your stories and all associated content stay on your infrastructure. This is for personal use only; redistribution is not permitted.

> **Full documentation** is available in the [`docs/`](docs/) directory.

## Channels

Two release channels are available, each published to its own branch:

| Channel | Branch | Compose File | Image Tag | Updated |
|---------|--------|-------------|-----------|---------|
| **Stable** | `main` | `docker-compose.stable.yml` | `:stable` | On each release |
| **Latest** | `develop` | `docker-compose.latest.yml` | `:latest` | On every push to `main` |

- **Stable** is recommended for most users — tested releases only.
- **Latest** tracks the development branch and may contain untested changes.

Clone the channel you want:
```bash
# Stable (recommended)
git clone --branch main https://github.com/MarcoDroll/creativewriter-selfhosted.git
cd creativewriter-selfhosted

# Or latest (bleeding edge)
git clone --branch develop https://github.com/MarcoDroll/creativewriter-selfhosted.git
cd creativewriter-selfhosted
```

## Requirements

- Docker Engine 20.10+ and Docker Compose v2
- 2 GB RAM minimum (4 GB recommended)
- 10 GB disk space

## Quick Start

> **Security note:** The included `.env` ships with known default secrets so you can start immediately.
> These are fine for local/private use, but for any publicly accessible deployment, run `./setup.sh`
> first to generate fresh secrets (see [Production Setup](#production-setup) below).

1. **Start services**
   ```bash
   # Stable (recommended)
   docker compose -f docker-compose.stable.yml up -d

   # Or latest (bleeding edge)
   docker compose -f docker-compose.latest.yml up -d
   ```

2. **Open the app** — navigate to `http://localhost:3000`

Storage buckets are initialized automatically on first boot. The included `.env` has working default secrets and email auto-confirm enabled — no manual configuration needed.

> **Reinstalling / starting over?** Deleting the project directory does **not** delete your data:
> Docker named volumes (`<project>_db-data`, `<project>_storage-data`) live under `/var/lib/docker/volumes/`
> and are silently reattached by a re-clone with the same directory name. Mixing old volumes with a fresh
> `.env` breaks Realtime in particular (its stored tenant config is encrypted with `DB_ENC_KEY`, so it
> crash-loops when the key no longer matches). For a genuinely fresh install run
> `docker compose -f docker-compose.stable.yml down -v` first — **this deletes all stories and users**.

### Production Setup

For any publicly accessible deployment, generate fresh secrets before starting:

```bash
./setup.sh              # Generates .env with fresh secrets
# ./setup.sh --force    # Overwrite existing .env
```

This creates random `POSTGRES_PASSWORD`, `JWT_SECRET`, `ANON_KEY`, `SERVICE_ROLE_KEY`, and security keys.

## Configuration

### SMTP (Email)

By default, `MAILER_AUTOCONFIRM=true` is set so signup works without email configuration.

> **Warning:** Without SMTP configured, **password reset is impossible**. Users who forget their password will have no recovery path. Even with auto-confirm enabled, consider setting up SMTP for password recovery.

For production with email confirmation and password reset, set `MAILER_AUTOCONFIRM=false` and configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_SENDER_EMAIL` in `.env`.

### Premium Features (License Key)

Self-hosted CreativeWriter is **single-tenant by design** — one operator, one set of users you trust. Premium features (AI Rewrite, Character Chat, AI Portrait Generation) unlock via a license key issued by [creativewriter.dev](https://creativewriter.dev). There is no local Stripe path: the edge functions reject Stripe webhooks and billing-portal calls with `410 Gone` when `SELF_HOSTED=true`.

> **You don't need the Premium plan — the cheapest Basic plan is enough.** A license key always grants full premium tier regardless of the hosted plan you subscribed to, because these features run on *your own* API keys and infrastructure. So subscribing to **Basic** at creativewriter.dev mints a full-premium, 1-year self-hosted license. The Premium plan only adds Included AI + managed hosting, both hosted-only and irrelevant to a self-hoster.

Two ways to apply a license key:

1. **Per-user** (recommended for shared instances) — subscribe at creativewriter.dev, open the billing page, click **Generate license key**, and paste it into Settings → Premium → License Key on this instance. Per-user keys take precedence over the server-wide fallback.
2. **Server-wide** — set the `LICENSE_KEY` env var in `.env` to a valid signed JWT. Every user on the instance is treated as premium for as long as the key is valid (1 year from generation).

Without a license key, every user stays on the **basic** tier (read/write stories, Beat AI, codex, scene summaries — everything except the three premium features above). Included AI (DeepSeek) is hosted-only and never available on self-hosted, license key or not.

See [`docs/pricing-and-billing.md`](../docs/pricing-and-billing.md#license-key-system-self-hosted) for the full license-key flow and signing details.

### Supabase Studio

Studio (database admin UI) starts automatically on port **54323** and is bound to `127.0.0.1` for security. Access it at `http://localhost:54323`.

To expose Studio on a remote server, use an SSH tunnel: `ssh -L 54323:localhost:54323 your-server`.

### Optional Services

- **imgproxy** (image transforms): `docker compose -f docker-compose.stable.yml --profile imgproxy up -d`

## Upgrading

Upgrades are safe — your data is stored in Docker named volumes (`db-data`, `storage-data`) which persist across container restarts and image updates.

```bash
# 1. Pull the latest compose file and config
git pull

# 2. Pull updated container images
docker compose -f docker-compose.stable.yml pull

# 3. Restart with new images (data volumes are preserved)
docker compose -f docker-compose.stable.yml up -d
```

> **Note:** If environment variables changed between versions, add `--force-recreate`:
> `docker compose -f docker-compose.stable.yml up -d --force-recreate`

> **Warning:** Never use `docker compose down -v` on an existing installation — the `-v` flag deletes all data volumes. Use `docker compose down` (without `-v`) to stop services while keeping data.

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

## Troubleshooting

- **Missing tables / REST 404s / `_cw_migrations` out of sync**: See [Migrate service issues](docs/troubleshooting.md) — the most common cause is forgetting `git pull` on upgrade (`docker compose pull` does not refresh host-mounted migrations).
- **Storage policies not working**: The `storage-init` service runs automatically on startup. If it failed, re-run manually: `docker compose run --rm storage-init`
- **Auth not sending emails**: Check SMTP configuration in `.env`
- **Container won't start**: Check logs with `docker compose -f docker-compose.stable.yml logs <service>`
- **Realtime not syncing**: Ensure `wal_level=logical` in PostgreSQL config (default in our compose)
- **GoTrue / PostgREST / Storage crash-looping with "password authentication failed"**: The `zz-bootstrap.sh` init script sets role passwords on first run. If this happens on a **fresh install**, reset with `docker compose down -v && docker compose up -d`. On an **existing install** with data, back up first (see Backup section), then reset volumes.
- **Realtime exits with `_realtime schema not found`**: Same cause — `zz-bootstrap.sh` creates the `_realtime` schema on first init. Same fix as above.
- **Kong exits immediately**: The entrypoint uses `sed` to substitute `ANON_KEY` and `SERVICE_ROLE_KEY` into `kong.yml`. Verify both variables are set in `.env`.
- **nginx fails to start with `directive "map" is not terminated by ";"` or similar**: Ensure the `map` block in `nginx.conf` uses quoted regex patterns for entries containing `{}`.
- **Video compression not working (air-gapped)**: The video compressor loads FFmpeg WASM from a CDN (jsdelivr.net) at runtime. Air-gapped deployments without internet access cannot compress videos. Videos can still be uploaded uncompressed.
