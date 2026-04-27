# Troubleshooting

## "NetworkError when attempting to fetch resource" on sign in / sign up

**Symptom:** The login or "Create account" page shows the red error `NetworkError when attempting to fetch resource` (or a similar browser-level fetch failure) when you submit the form. No HTTP status code is returned.

**Cause:** The frontend is configured at boot with `SUPABASE_PUBLIC_URL` (default `http://localhost:3000`) and sends all Auth / REST / Storage calls to that origin. If you open the app via a *different* hostname than `SUPABASE_PUBLIC_URL` — for example `http://127.0.0.1:3000` when the default is `http://localhost:3000` — the browser treats every Supabase call as a cross-origin request. Firefox surfaces the resulting CORS / origin failure as `NetworkError when attempting to fetch resource`.

`localhost` and `127.0.0.1` are different origins to the browser, even though they resolve to the same machine.

**Fix — pick one:**

1. Access the app via the hostname that matches `SUPABASE_PUBLIC_URL`. With the defaults that means opening `http://localhost:3000`, not `http://127.0.0.1:3000`.
2. Or update `.env` so `SUPABASE_PUBLIC_URL` matches the hostname you actually use, then recreate the containers:
   ```bash
   # example: serving on 127.0.0.1
   SUPABASE_PUBLIC_URL=http://127.0.0.1:3000

   docker compose -f docker-compose.stable.yml up -d --force-recreate
   ```

The same rule applies to remote deployments: if you reach the app at `https://cw.example.com`, set `SUPABASE_PUBLIC_URL=https://cw.example.com` (no trailing slash) in `.env` before starting the stack. A mismatch between the URL in your browser's address bar and `SUPABASE_PUBLIC_URL` will break auth, data, storage, and realtime.

The app detects this mismatch on the sign in / sign up screen and shows an inline warning with the current and expected origin to make it obvious.

## Storage policies not working

Storage buckets are initialized automatically by the `storage-init` service on first boot. If it failed, re-run manually:

```bash
docker compose -f docker-compose.stable.yml run --rm storage-init
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

> **How this typically happens:** Docker named volumes (`<project>_db-data`, `<project>_storage-data`) persist on the host independently of the project directory. Wiping the directory and re-cloning, then re-running `setup.sh`, leaves the old volumes in place but writes a fresh `.env` whose credentials no longer match what `zz-bootstrap.sh` already baked into the database. `setup.sh` detects this and aborts with recovery instructions (it honours `COMPOSE_PROJECT_NAME` when set, otherwise the project directory name). If you hit the error anyway — for example after an older `setup.sh` ran, or with the Docker daemon stopped at setup time — restore the previous `.env` from `.env.backup.*` if available, or run `docker compose down -v` to discard the stale volumes.

## Realtime exits with "_realtime schema not found"

Same cause as above — `zz-bootstrap.sh` creates the `_realtime` schema on first init. Same fix.

## `docker compose ps` shows services as `Up` with no `(healthy)` suffix

`auth`, `rest`, `realtime`, `storage`, `functions`, `frontend`, `kong`, and `meta` do not define a `healthcheck:` in the compose file. Docker therefore reports no health status — **this is not the same as `unhealthy`**. A running service without a health indicator is fine. `studio` inherits a healthcheck from the upstream image that occasionally flaps to `unhealthy` while still serving traffic on port 54323; this is an upstream quirk and can be ignored.

If you already ran a buggy `setup.sh` (any version before this fix), your `.env` has a 32-byte `DB_ENC_KEY` and Realtime won't start. Recover with `./setup.sh --force && docker compose down -v && docker compose up -d` (destroys DB data — back up first if you have any).

## Migrate service exited non-zero

The `migrate` service is a one-shot container that runs `docker/volumes/db/migrate.sh` and then exits. It has `restart: "no"`, so a failure is not automatically retried. Common cause: on a slow host, the script's 90-second wait for storage-api's schema migrations (which add `storage.buckets.public` and related columns) expires before storage-api finishes, and migrations 00007 or 00015 fail.

Re-run it manually:

```bash
docker compose -f docker-compose.stable.yml run --rm migrate
```

Migration tracking is idempotent (`public._cw_migrations`), so previously applied migrations are skipped.

## Kong exits immediately

The entrypoint uses `sed` to substitute `ANON_KEY` and `SERVICE_ROLE_KEY` into `kong.yml`. Verify both variables are set in `.env`.

## Frontend exits with "ERROR: unsubstituted placeholders found in static assets"

**Symptom:** The `frontend` container fails to start and the logs show:

```
ERROR: unsubstituted placeholders found in static assets:
__SUPABASE_URL__
```

**Cause:** The frontend image ships with `__SUPABASE_URL__`, `__SUPABASE_ANON_KEY__`, `__SUPABASE_FUNCTIONS_URL__`, `__STRIPE_PUBLISHABLE_KEY__`, and `__STRIPE_PRICING_TABLE_ID__` literals baked into the JS bundle. The container's entrypoint substitutes them at boot using values from the environment, then runs a leak scan and refuses to start nginx if any placeholder survived. This protects you from running with `__SUPABASE_ANON_KEY__` as the literal API key.

The most common trigger is a missing or misnamed environment variable. `SUPABASE_PUBLIC_URL` and `ANON_KEY` are required; `STRIPE_PUBLISHABLE_KEY` and `STRIPE_PRICING_TABLE_ID` are optional and substitute to empty strings if unset.

**Fix:**

1. Confirm `.env` defines `SUPABASE_PUBLIC_URL` and `ANON_KEY`. The container will fail with `SUPABASE_PUBLIC_URL is required` (or the same for `ANON_KEY`) before reaching the leak scan if either is missing entirely — but a typo or a value bound to the wrong variable name can leave the placeholder in place.
2. If a *new* placeholder name appears in the error (one not in the list above), the image is newer than the entrypoint expects — pull a fresh image that knows about it, or report the placeholder name as a bug.
3. Recreate the container after fixing `.env`:
   ```bash
   docker compose -f docker-compose.stable.yml up -d --force-recreate frontend
   ```

## nginx fails to start with "directive 'map' is not terminated by ';'" or similar

Ensure the `map` block in `nginx.conf` uses quoted regex patterns for entries containing `{}`.
