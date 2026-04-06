# Troubleshooting

## Storage policies not working

Storage buckets are initialized automatically by the `storage-init` service on first boot. If it failed, re-run manually:

```bash
docker compose -f docker-compose.stable.yml exec db psql -U supabase_admin -f /docker-entrypoint-initdb.d/99-storage-setup.sql
```

## Auth not sending emails

Check SMTP configuration in `.env`. Ensure `MAILER_AUTOCONFIRM=false` and that `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_SENDER_EMAIL` are correctly set.

## Container won't start

Check logs:

```bash
docker compose -f docker-compose.stable.yml logs <service>
```

## Realtime not syncing

Ensure `wal_level=logical` in PostgreSQL config. This is set by default in the compose file.

## GoTrue / PostgREST / Storage crash-looping with "password authentication failed"

The `zz-bootstrap.sh` init script sets role passwords on first run.

- **Fresh install:** Reset with `docker compose down -v && docker compose up -d`
- **Existing install with data:** Back up first (see [Administration](administration.md#backup)), then reset volumes

## Realtime exits with "_realtime schema not found"

Same cause as above — `zz-bootstrap.sh` creates the `_realtime` schema on first init. Same fix.

## Kong exits immediately

The entrypoint uses `sed` to substitute `ANON_KEY` and `SERVICE_ROLE_KEY` into `kong.yml`. Verify both variables are set in `.env`.

## nginx fails to start with "directive 'map' is not terminated by ';'" or similar

Ensure the `map` block in `nginx.conf` uses quoted regex patterns for entries containing `{}`.
