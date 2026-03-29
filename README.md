# CreativeWriter Self-Hosted

Run CreativeWriter on your own server with Docker Compose. Self-hosting gives you full control over your data — your stories and all associated content stay on your infrastructure. This is for personal use only; redistribution is not permitted.

> **Full documentation** is available in the [`docs/`](../docs/) directory of the source repository.

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

1. **Start services**
   ```bash
   # Stable (recommended)
   docker compose -f docker-compose.stable.yml up -d

   # Or latest (bleeding edge)
   docker compose -f docker-compose.latest.yml up -d
   ```

2. **Initialize storage buckets** (first run only)

   After all services are healthy, run the storage setup script:
   ```bash
   docker compose -f docker-compose.stable.yml exec db psql -U supabase_admin -f /docker-entrypoint-initdb.d/99-storage-setup.sql
   ```

   > **Latest channel:** Replace `docker-compose.stable.yml` with `docker-compose.latest.yml` in all commands.

3. **Open the app** — navigate to `http://localhost:3000`

The included `.env` has working default secrets and email auto-confirm enabled — no manual configuration needed.

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

For production with email confirmation and password reset, set `MAILER_AUTOCONFIRM=false` and configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_SENDER_EMAIL` in `.env`.

### Premium Features (Optional)

Premium features (AI Rewrite, Character Chat, Portrait Generation) are gated behind Stripe subscriptions. Without Stripe configuration, all users get free basic access.

To enable premium:
1. Create a Stripe account and products
2. Set `STRIPE_API_KEY`, `STRIPE_PUBLISHABLE_KEY`, and price IDs in `.env`
3. Configure a webhook endpoint pointing to `{your-url}/functions/v1/stripe/webhook`

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

- **Storage policies not working**: Run the storage setup script (step 2 above)
- **Auth not sending emails**: Check SMTP configuration in `.env`
- **Container won't start**: Check logs with `docker compose -f docker-compose.stable.yml logs <service>`
- **Realtime not syncing**: Ensure `wal_level=logical` in PostgreSQL config (default in our compose)
- **GoTrue / PostgREST / Storage crash-looping with "password authentication failed"**: The `zz-bootstrap.sh` init script sets role passwords on first run. If this happens on a **fresh install**, reset with `docker compose down -v && docker compose up -d`. On an **existing install** with data, back up first (see Backup section), then reset volumes.
- **Realtime exits with `_realtime schema not found`**: Same cause — `zz-bootstrap.sh` creates the `_realtime` schema on first init. Same fix as above.
- **Kong exits immediately**: The entrypoint uses `sed` to substitute `ANON_KEY` and `SERVICE_ROLE_KEY` into `kong.yml`. Verify both variables are set in `.env`.
- **nginx fails to start with `directive "map" is not terminated by ";"` or similar**: Ensure the `map` block in `nginx.conf` uses quoted regex patterns for entries containing `{}`.
