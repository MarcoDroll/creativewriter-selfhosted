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
