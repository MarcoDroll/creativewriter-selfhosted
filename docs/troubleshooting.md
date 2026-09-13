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

## Deep Writer pipeline — `wall clock duration reached` or stalled phases

**Symptom:** A Deep Writer (multi-step) generation aborts mid-stream. The `functions` container logs show `wall clock duration reached`, or the browser shows a generic generation error after running for ~60 seconds.

**Cause:** Before commit `9af6891` the entire pipeline (planning → research → draft → analyze → refine) ran in a single Edge Function request bound to one wall-clock window. On self-hosted that window was 60 s; on hosted free-tier it is 150 s. Larger thorough-preset runs would not finish.

The fix splits the pipeline into five separate phase endpoints (`/plan`, `/research`, `/draft`, `/analyze`, `/refine`) orchestrated client-side, each with its own ~150 s budget. The self-hosted main service (`supabase/functions/main/index.ts`) was bumped to match: `workerTimeoutMs = 150_000`, `cpuTimeSoftLimitMs = 150_000`, `cpuTimeHardLimitMs = 150_000`, `memoryLimitMb = 256`.

**Fix:** Pull the latest images and recreate the `functions` container so it picks up the new code:

```bash
docker compose -f docker-compose.stable.yml pull
docker compose -f docker-compose.stable.yml up -d --force-recreate functions
```

No `.env` changes are required — all limits are hardcoded in the Edge Function code.

**Stale browser tabs after deploy:** A tab opened before the new bundle is served will still POST to the removed `/generate` endpoint and get a 404. The user sees a generic error; reloading the page fixes it. Angular's `registerWhenStable:30000` strategy invalidates the cached PWA bundle on the next navigation.

**Reverse proxy in front of Kong:** If you front Supabase with your own nginx / Caddy / Traefik / Cloudflare Tunnel, the `/draft` and `/refine` phases stream over SSE for up to ~130 s. Default nginx `proxy_read_timeout` is 60 s. The 15 s server-side heartbeat (`: keepalive` SSE comment) resets the timeout on every read, so the default usually works — but if you see streams cut off at exactly your proxy's read-timeout interval, raise it to ≥160 s for `/functions/v1/agentic-writer/*`. Example for nginx:

```nginx
location /functions/v1/agentic-writer/ {
    proxy_read_timeout 160s;
    proxy_buffering    off;     # SSE must not buffer
    proxy_pass http://kong;
}
```

## Deep Writer's model slots are empty

**Settings → Deep Writer offers a narrower set of models than the rest of the app, and this is not a
bug.** Every other AI feature calls the model *from your browser*, so any provider you have configured
works. Deep Writer is a pipeline that runs **server-side**, so a slot may only name a provider that
*server* can reach:

| Provider | Deep Writer slot? |
|---|---|
| OpenRouter (your own key) | ✅ everywhere |
| Included AI | ✅ hosted plans only — never self-hosted |
| Ollama / OpenAI-compatible | ✅ **self-hosted only**, once the operator configures it (next section) |
| Gemini, Claude | ❌ anywhere — the app reaches these through browser-side proxies with your key, which the pipeline has no access to |

So a **hosted** author whose only provider is Gemini or Claude has no Deep Writer models, and adding a
third such key will not change that. The fix is an OpenRouter key (Settings → AI Models) or a plan
with Included AI. On **self-hosted** there is a second route: a local model server, below.

The tab itself now says which of these applies rather than showing four empty dropdowns. If it reports
a provider *is* configured but no models came back, that is a model-load failure rather than a
prerequisite — check the key is still valid and press **Load models**.

## Deep Writer with a local model (Ollama / OpenAI-compatible)

Deep Writer runs **server-side**, in the `functions` container — so it does not use the Ollama URL
you set in the app, and it cannot see anything on the browser's machine. On self-hosted the container
is yours, so it can reach your model server once configured.

**Prerequisites**, all three:

1. `OLLAMA_BASE_URL` (or `OPENAI_COMPATIBLE_BASE_URL`) set on the `functions` service, pointing at an
   address that resolves *from inside the container* — usually
   `http://host.docker.internal:11434`. See
   [Local AI Providers for Deep Writer](configuration.md#local-ai-providers-for-deep-writer-self-hosted).
2. The server listening where the container can reach it: `OLLAMA_HOST=0.0.0.0:11434`.
3. `OLLAMA_CONTEXT_LENGTH=16384` on the server. The in-app **Context Window** setting does **not**
   reach Deep Writer — the OpenAI-compatible `/v1` endpoint has no per-request `num_ctx`.

| Symptom | Cause | Fix |
|---|---|---|
| 400 *"Ollama is not configured on this server"* (or the `OPENAI_COMPATIBLE_BASE_URL` variant) | The env var is unset on the `functions` container. There is deliberately no fallback | Set it, then `up -d --force-recreate functions` |
| 400 *"…is invalid"* | Not a URL, or a scheme other than `http`/`https` | Only `http://`/`https://` are accepted |
| 400 *"Model provider … is not available on this instance"* | A slot names a provider the server cannot call — `gemini:` or `claude:` (reached through browser-side proxies), or a local one on the hosted service | Re-pick the slot in **Settings → Deep Writer** |
| Model API error 404 | The browser-side and container-side URLs point at different servers — e.g. `localhost` inside the container means the container | Use `host.docker.internal` or the LAN IP |
| DNS failure on `host.docker.internal` | Rootless Podman, or a Docker Engine older than the compose file's `extra_hosts` support | Use the host's LAN IP via a compose override |
| Thin or empty research context, `[ResearchAgent] Model rejected tool definitions … retrying once without tools` in the log | The model has no tool template. The pipeline retries that round once without tools and still returns a brief — degraded, not broken | Use a tool-capable model (e.g. `qwen2.5`) for the research slot |
| Truncated draft | `OLLAMA_CONTEXT_LENGTH` still at Ollama's silently-truncating 4096 default | Set it on the server and confirm with `ollama ps` |
| Consistent timeouts on one phase | A local server serialises requests; research is the most exposed (rounds are sequential per task) | Use the **Balanced** preset, or a smaller/faster model |

Confirm networking independently of the app before anything else:

```bash
docker compose -f docker-compose.stable.yml exec functions \
  deno eval "console.log(await (await fetch('http://host.docker.internal:11434/v1/models')).text())"
```

**Timeouts are source constants by design.** Each phase has its own per-LLM-call guard (planning
25 s, draft 90 s, refine 130 s, analyze 25 s) in `supabase/functions/agentic-writer/router.ts`. Raising
them buys almost nothing: `supabase/functions/main/index.ts` caps every worker at
`workerTimeoutMs`/`cpuTimeHardLimitMs` of **150 000 ms**, so anything past ~145 s is killed by the
runtime instead. Reach for the **Balanced** preset (which skips analyze + refine) rather than for the
constants.

## Intermittent read failures on flaky / mobile connections

Transient network errors on **read** queries are retried automatically by the Supabase client — no configuration required. Since `@supabase/supabase-js` 2.x (this app bundles `postgrest-js` 2.110.0 via `supabase-js` 2.110.0), `PostgrestBuilder` retries idempotent requests (`GET`/`HEAD`) up to 3 times on transient upstream failures (HTTP `503`/`520`), which is especially useful on mobile where connectivity drops mid-request. Writes (`POST`/`PATCH`/`DELETE`) are **not** retried, to avoid duplicate mutations. A specific query can opt out with `.retry(false)`. If reads still fail after the built-in retries, the cause is a persistent problem (auth/CORS, an unreachable Supabase origin — see the `NetworkError` section above, or a genuine 4xx), not a blip.

## Storage policies not working

Storage buckets are initialized automatically by the `storage-init` service on first boot. If it failed, re-run manually:

```bash
docker compose -f docker-compose.stable.yml run --rm storage-init
```

## Auth not sending emails

Check SMTP configuration in `.env`. Ensure `MAILER_AUTOCONFIRM=false` and that `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_SENDER_EMAIL` are correctly set.

## Verification emails land in spam / the link doesn't confirm

If verification emails arrive but land in the spam/junk folder — or don't arrive at all — the cause is almost always **missing email authentication** on the sender domain. Publish **SPF, DKIM, and a DMARC record** and send through a reputable transactional relay (Resend, Postmark, SES, Mailgun, SendGrid) rather than a raw mailbox. See [Email deliverability (SPF / DKIM / DMARC)](configuration.md#email-deliverability-spf--dkim--dmarc) for the full setup. A domain with no DMARC policy is increasingly rejected or spam-filed outright.

If the user found the email but clicking the link still shows **"verify your email":**

- **The verification link is single-use and can be consumed before the user clicks it.** Some corporate mail gateways and antivirus scanners *prefetch* every URL in an incoming message to check for threats — that prefetch spends the one-time token, so by the time the user clicks, it's already been used (or has expired). The account may in fact be confirmed, or may need a fresh link.
- **Switch to the token_hash confirmation flow (durable fix).** Repointing the confirmation email template at the app's `/auth/confirm` page makes the one-time token immune to `GET` prefetch (it's only spent by an explicit `POST`) and lets confirmation work cross-device. See [Robust email confirmation (token_hash flow)](configuration.md#robust-email-confirmation-token_hash-flow).
- **Have the user resend.** The login screen shows a **Resend verification email** button after signup (or after a sign-in attempt blocked by an unconfirmed address). It sends a new link with the same redirect target.
- **Check the confirmation redirect / allowlist.** The link redirects to `SUPABASE_PUBLIC_URL` (self-hosted) or the site URL / redirect allowlist configured in the Supabase dashboard (hosted). A mismatch between where the app is served and the configured redirect can leave the session unestablished after the click.

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

## Realtime container restart-loops (`Restarting (1)` in `docker ps`)

Everything else runs but `realtime` keeps restarting. Check `docker compose logs realtime --tail=50` and match the cause:

1. **Wrong `DB_ENC_KEY` length** — the key must be exactly 16 bytes (`openssl rand -hex 8`). If you ran a buggy `setup.sh` (any version before the `-hex 8` fix), your `.env` has a 32-byte key and Realtime won't start. Recover with `./setup.sh --force && docker compose down -v && docker compose up -d` (destroys DB data — back up first if you have any).
2. **Stale volumes with a changed `DB_ENC_KEY`** — Realtime's tenant row in the database is encrypted with `DB_ENC_KEY`, so it is the one service whose *stored* state depends on an `.env` secret beyond the DB password. Reattaching old volumes to a fresh `.env` (e.g. after deleting and re-cloning the project directory — named volumes survive that; see the callout in the [Docker README](../docker/README.md#quick-start)) makes Realtime alone crash-loop while everything else runs. Fix: restore the matching `.env` from `.env.backup.*`, or start fresh with `docker compose down -v && docker compose up -d` (destroys data).
3. **IPv6 disabled on the host** — `supabase/realtime` (Elixir/BEAM) attempts to use IPv6 and exits if it is unavailable, so on a host with IPv6 turned off on every interface Realtime alone crash-loops while everything else runs. Check the logs for an IPv6/`inet6`/`eaddrnotavail`-style bind error. Fix: enable IPv6 on the host — enabling it on the loopback (`lo`) interface is enough. (Reported in selfhosted#14.)

## `docker compose ps` shows services as `Up` with no `(healthy)` suffix

`auth`, `rest`, `realtime`, `storage`, `functions`, `frontend`, `kong`, and `meta` do not define a `healthcheck:` in the compose file. Docker therefore reports no health status — **this is not the same as `unhealthy`**. A running service without a health indicator is fine. `studio` inherits a healthcheck from the upstream image that occasionally flaps to `unhealthy` while still serving traffic on port 54323; this is an upstream quirk and can be ignored.

## Migrate service issues — missing tables, REST 404s, `_cw_migrations` out of sync

**Symptom:** REST calls return 404 or the database log shows `relation "<table>" does not exist` (e.g. `codex_entry_current_state`); `docker compose logs migrate` reports fewer applied migrations than `ls volumes/db/migrations/` shows on disk.

The `migrate` service is a one-shot container that runs `docker/volumes/db/migrate.sh` and then exits. It has `restart: "no"`, so a failure is not automatically retried.

### Diagnose

```bash
# What's bundled on disk
ls volumes/db/migrations/

# What the database thinks is applied
docker compose -f docker-compose.stable.yml exec db \
  psql -U supabase_admin -d postgres -c \
  "SELECT name FROM public._cw_migrations ORDER BY name;"

# What the migrate runner did/said last time it ran
docker compose -f docker-compose.stable.yml logs migrate
```

If the `SELECT` errors with `relation "_cw_migrations" does not exist`, the migrate container crashed before creating its tracking table — `docker compose logs migrate` is the more important artifact. Look for the `Failed while applying:` banner that names the offending migration.

### Three causes mapped to fixes

1. **Stale checkout** — your `volumes/db/migrations/` directory is missing files that the bundled image expects (it was first added to the public repo in 2026-03-04). The migrate runner now prints a `WARNING: migrations tracked in DB but not present on disk` block at the end of its log when this happens. Fix:
   ```bash
   git pull
   docker compose -f docker-compose.stable.yml run --rm migrate
   ```
   **Upgrade gotcha:** `docker compose pull` only refreshes images, **not** the host-mounted migrations directory. You have to `git pull` the selfhosted repo too.
2. **A migration failed mid-run** — the runner aborts on the first `ON_ERROR_STOP` failure and the new failure trap prints `Failed while applying: <filename>`. The most common cause is the storage-api race covered by the script's 90-second wait (migrations 00007 and 00015 reference columns storage-api adds on first boot). Fix the underlying error if it's not a transient race, then re-run:
   ```bash
   docker compose -f docker-compose.stable.yml run --rm migrate
   ```
3. **Migrate never re-ran** — because the service has `restart: "no"`, a stopped migrate container is **not** picked up by `docker compose start`. You need `docker compose -f docker-compose.stable.yml up -d` (which recreates one-shot containers) or an explicit `docker compose ... run --rm migrate`.

Migration tracking is idempotent (`public._cw_migrations`), so previously applied migrations are skipped on every re-run.

### Migrate fails at 00009 with `relation "ai_usage_daily" does not exist`

**Symptom:** `docker compose logs migrate` shows:

```
Applying migration: 00009_simplify_ai_usage_monthly.sql
ERROR: relation "ai_usage_daily" does not exist
```

…and `_cw_migrations` only contains rows up to `00008_monthly_ai_budget.sql`. Because the runner aborts at 00009, every later migration (notably `00032_codex_entry_current_state.sql`) is also missing, so the codex tracker view returns 404.

**Cause:** A historical drift between the init schema (which already declared the post-00009 form of `ai_usage`) and the bootstrap seed list (which only covered 00001–00005). Tracked as issue #11.

**Fix:** Pull the latest selfhosted release and re-run migrate. The fixed 00009 is a no-op on databases that don't have `ai_usage_daily`, so the runner will mark it applied and continue with 00010+.

```bash
git pull
docker compose -f docker-compose.stable.yml run --rm migrate
```

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
