# Configuration

All configuration is done via environment variables in the `.env` file. The `.env.example` file documents every available variable. A fresh self-hosted install communicates with no external services — AI providers, SMTP, and Stripe are all opt-in, so your data stays local by default.

## Required Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_PASSWORD` | `<generated-by-setup-sh>` | PostgreSQL password — use a strong random string |
| `JWT_SECRET` | `<generated-by-setup-sh>` | JWT secret — minimum 32 characters, used by all Supabase services |
| `ANON_KEY` | `<generated-by-setup-sh>` | Supabase anonymous key — HS256 JWT signed with `JWT_SECRET` |
| `SERVICE_ROLE_KEY` | `<generated-by-setup-sh>` | Supabase service role key — HS256 JWT signed with `JWT_SECRET` |
| `SUPABASE_PUBLIC_URL` | `http://localhost:3000` | Public-facing URL for auth redirects, CORS, and API routing |
| `FRONTEND_PORT` | `3000` | Port the frontend listens on (maps to nginx container port 80) |

### Rotating `JWT_SECRET`

Three values move together, and **`setup.sh` is the wrong tool for it on a live instance.**

`ANON_KEY` and `SERVICE_ROLE_KEY` are themselves HS256 JWTs *signed with* `JWT_SECRET`, so
changing it alone leaves two credentials nothing in the stack can verify. But re-running
`setup.sh` to regenerate them does three other things you almost certainly do not want here:
it rotates `POSTGRES_PASSWORD` in the same pass (which will not match the password already
baked into the existing database volume — the script detects this and refuses to run rather
than leave you crash-looping), and it copies `.env.example` over your `.env`, discarding every
other secret you have set: SMTP, Stripe, AI provider keys, your domain.

Edit `.env` by hand instead:

```bash
cd docker
NEW_SECRET=$(openssl rand -base64 40 | tr -d '\n')

# Same signing the installer does — see `sign_jwt()` in setup.sh, which this mirrors.
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
sign() {
  h=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
  p=$(printf '{"role":"%s","iss":"supabase","iat":1700000000,"exp":2200000000}' "$1" | b64url)
  s=$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -hmac "$NEW_SECRET" -binary | b64url)
  printf '%s.%s.%s' "$h" "$p" "$s"
}

# Replace exactly these three lines in .env, leaving everything else alone.
echo "JWT_SECRET=$NEW_SECRET"
echo "ANON_KEY=$(sign anon)"
echo "SERVICE_ROLE_KEY=$(sign service_role)"

docker compose up -d
```

Two consequences worth expecting rather than discovering:

- **Every signed-in user is signed out.** GoTrue signs session tokens with this same secret
  (`GOTRUE_JWT_SECRET`), so all outstanding tokens stop verifying. During incident response
  that is the point; do not be surprised by it otherwise.
- **The Edge Functions need no redeploy.** They re-derive the verification key on every
  request and hold no cached copy, so the new secret takes effect on the next call and — the
  part that matters after a leak — the old one stops being accepted immediately.

## SMTP (Email)

| Variable | Default | Description |
|----------|---------|-------------|
| `SMTP_HOST` | `smtp.example.com` | SMTP server hostname |
| `SMTP_PORT` | `587` | SMTP server port |
| `SMTP_USER` | — | SMTP username |
| `SMTP_PASS` | — | SMTP password |
| `SMTP_SENDER_EMAIL` | `noreply@example.com` | Sender email address |
| `MAILER_AUTOCONFIRM` | `true` | Skip email confirmation (set `false` for production) |

When `MAILER_AUTOCONFIRM=true`, signup works without email configuration. For production with email confirmation and password reset, set it to `false` and configure the SMTP variables.

### Email deliverability (SPF / DKIM / DMARC)

Once `MAILER_AUTOCONFIRM=false`, GoTrue sends verification and password-reset emails through your SMTP server. Whether those emails reach the inbox — instead of the spam folder or being dropped silently — depends on the DNS records for your **sender domain** (the domain in `SMTP_SENDER_EMAIL`). Configure all three:

- **SPF** — a TXT record on the sender domain that authorizes your relay's servers to send on its behalf (e.g. `v=spf1 include:<relay-spf-host> ~all`). Without it, most providers flag the mail as unauthenticated.
- **DKIM** — a cryptographic signature added by your relay; publish the relay-provided public key as a TXT/CNAME record. This lets receivers verify the message wasn't forged or altered.
- **DMARC** — a `_dmarc.<domain>` TXT record (e.g. `v=DMARC1; p=quarantine; rua=mailto:dmarc@<domain>`) that tells receivers what to do when SPF/DKIM fail and where to send reports. Many inbox providers now **reject or spam-file mail from domains with no DMARC policy at all.**

**Prefer a reputable transactional SMTP relay** — Resend, Postmark, Amazon SES, Mailgun, or SendGrid — over sending from a raw mailbox or a self-run mail server. Relays maintain sender reputation, provide the DKIM keys and SPF includes to publish, and dramatically improve inbox placement. A raw mailbox on a fresh domain (no SPF/DKIM/DMARC) will almost always land in spam.

> Users who don't find the email should check their spam/junk folder and search for **CreativeWriter** (the `GOTRUE_SMTP_SENDER_NAME`). The in-app **Resend verification email** button on the login screen sends a fresh link if the first one was missed or expired.

### Robust email confirmation (token_hash flow)

By default, GoTrue's confirmation email links to `GET /auth/v1/verify?token=…`, which **consumes the one-time token server-side on that GET request**. Corporate mail gateways and antivirus scanners *prefetch* every link in an incoming email to scan it — spending the token before the user clicks, so the link reads as "already used / expired" (the root of the "I clicked it but it still says verify your email" reports).

The app ships a hardened alternative at **`/auth/confirm`** that uses Supabase's `verifyOtp({ token_hash })` flow: the email links to the app's static confirm page, and the token is only spent when the page's JavaScript makes an explicit `POST`. A scanner's `GET` prefetch (no JS) can't consume it, and — because it needs no PKCE `code_verifier` — confirmation also works **cross-device** (sign up on desktop, confirm on phone). The page is dormant until you repoint the confirmation email template at it.

**Hosted (Supabase cloud):** In the dashboard under **Authentication → Email Templates → Confirm signup**, replace the default `{{ .ConfirmationURL }}` link with:

```
{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email
```

**Self-hosted:** GoTrue does **not** read email templates from mounted Docker volumes — it fetches each template over **HTTP**. So serve the shipped template (`docker/volumes/templates/confirmation.html`) from a small sidecar on the internal Docker network and point GoTrue at its URL. Add to your compose (or an override file):

```yaml
services:
  auth:
    environment:
      GOTRUE_MAILER_TEMPLATES_CONFIRMATION: "http://templates-server/confirmation.html"
      GOTRUE_MAILER_SUBJECTS_CONFIRMATION: "Confirm your CreativeWriter email"
    depends_on:
      templates-server:
        condition: service_started

  templates-server:
    image: caddy:2-alpine
    command: ["caddy", "file-server", "--root", "/srv", "--listen", ":80"]
    volumes:
      - ./volumes/templates:/srv:ro
    networks:
      - creativewriter
```

This is **opt-in** — it adds one container and only matters when `MAILER_AUTOCONFIRM=false` (email confirmation is actually in use). The default stack is unchanged. Only repoint the **Confirm signup** template; leave password-recovery and email-change on their defaults (the `/auth/confirm` page only handles `type=email`/`signup`).

## Premium Features (Optional)

If you don't configure Stripe, all users get free basic access. Premium features (AI Rewrite, Character Chat, Portrait Generation) require a Stripe subscription.

| Variable | Default | Description |
|----------|---------|-------------|
| `STRIPE_API_KEY` | — | Stripe secret API key |
| `STRIPE_PUBLISHABLE_KEY` | — | Stripe publishable key |
| `STRIPE_PRICING_TABLE_ID` | — | Stripe pricing table ID |
| `STRIPE_WEBHOOK_SECRET` | — | Stripe webhook signing secret |
| `STRIPE_BASIC_PRICE_ID_MONTHLY` | — | Stripe price ID for basic monthly |
| `STRIPE_BASIC_PRICE_ID_YEARLY` | — | Stripe price ID for basic yearly |
| `STRIPE_PREMIUM_PRICE_ID_MONTHLY` | — | Stripe price ID for premium monthly |
| `STRIPE_PREMIUM_PRICE_ID_YEARLY` | — | Stripe price ID for premium yearly |
| `STRIPE_TRIAL_DAYS` | `7` | Free trial duration in days |
| `SUCCESS_URL` | `http://localhost:3000/?subscription=success` | Default return URL for billing portal sessions |

Configure a webhook endpoint pointing to `{your-url}/functions/v1/stripe/webhook`.

## Operational Alerts (Optional)

When a Stripe webhook is orphaned (`webhook.orphan_skipped` — a paying customer could not be mapped to a user) or fails to process (`webhook.processing_failed`), the `stripe` Edge Function can email the operator so they can reconcile it by hand (`scripts/reconcile-stripe-orphans.ts --customer cus_…`) instead of spelunking the `audit_log` table. Delivery uses the [Resend](https://resend.com) HTTP API.

| Variable | Default | Description |
|----------|---------|-------------|
| `RESEND_API_KEY` | — | Resend API key. **Absent → alerts no-op.** |
| `ALERT_EMAIL_TO` | — | Operator recipient address. **Absent → alerts no-op.** |
| `ALERT_EMAIL_FROM` | `onboarding@resend.dev` | Sender. The default is Resend's shared sender (no domain verification, delivers to the account owner); prod overrides it with a verified-domain address. |

Alerts fire **only when both `RESEND_API_KEY` and `ALERT_EMAIL_TO` are set** — self-hosted and unconfigured-hosted instances stay silent, with no behavior change to the webhook responses. The send is fire-and-forget (un-awaited), so it adds zero latency to the webhook and never blocks or fails the Stripe handler.

> This is a **separate** email path from the [SMTP relay](#smtp-email) used for auth emails (GoTrue can't be called for arbitrary alerts). Enabling alerts means adding a Resend account **in addition to** whatever SMTP relay you already run — the edge function calls Resend's HTTP API directly (a single `fetch`) to avoid SMTP connection/TLS overhead in the function.

On hosted, these are **manual per-project Supabase secrets** on dev + prod (like `STRIPE_API_KEY`) — set via the dashboard or `supabase secrets set`; they are not CI-injected.

## AI Proxy (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEPSEEK_API_KEY` | — | **No effect on self-hosted.** Included AI text (DeepSeek) is only available on the hosted version |
| `FAL_KEY` | — | **No effect on self-hosted.** fal.ai key for the included image model (FLUX.1 [schnell]) that powers AI cover images, codex portraits and "Illustrate this moment". Still exactly one included model — illustration's character-reference variant uses a different fal endpoint against the **author's own key**, never this one. Metered against the same shared monthly budget as included text. Set as a Supabase secret on dev + prod; CI deploys the `premium` Edge Function that reads it |

## Local AI Providers for Deep Writer (self-hosted)

The Deep Writer pipeline (plan → research → draft → analyze → refine) runs **server-side**, inside the `functions` container. That is why it is the one feature whose model server is configured with env vars rather than in the app: the browser-side base URL you set under **Settings → AI Providers** is never seen by the pipeline, and on the hosted service a local model is impossible in principle. On a self-hosted instance the edge runtime is *your* container, so it can reach your own Ollama / LM Studio / vLLM once you point it at one.

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_BASE_URL` | — (empty) | The **functions container's** address for Ollama. Empty → `ollama:` slots answer 400 naming this variable; nothing falls back |
| `OPENAI_COMPATIBLE_BASE_URL` | — (empty) | Same, for LM Studio / vLLM / llama.cpp servers |
| `OPENAI_COMPATIBLE_API_KEY` | — (empty) | Optional bearer token (e.g. vLLM's `--api-key`). The **in-app** API key is not used — Deep Writer never forwards a browser-side credential |
| `OLLAMA_API_KEY` | — (empty) | Optional; only if Ollama sits behind an authenticating proxy |

All of `http://host:11434`, `http://host:11434/v1` and `http://host:11434/v1/chat/completions` are accepted — the trailing path is normalised. Only `http://` and `https://` are allowed.

### Which address to use

The value is resolved from *inside* the container, so `http://localhost:11434` means the container itself and will not work.

| Where your model server runs | Value |
|---|---|
| On the Docker host | `http://host.docker.internal:11434` |
| A sibling container on the `creativewriter` network | `http://ollama:11434` |
| Another machine on the LAN | `http://192.168.1.50:11434` |

`host.docker.internal` is provided free by Docker Desktop; on Linux Engine the compose file declares it (`extra_hosts: host-gateway` on the `functions` service only). Rootless Podman has been inconsistent here — if the name does not resolve, use the host's LAN IP via a compose override.

Verify networking before blaming the app:

```bash
docker compose -f docker-compose.stable.yml exec functions \
  deno eval "console.log(await (await fetch('http://host.docker.internal:11434/v1/models')).text())"
```

### Context length is a server-side setting here

Deep Writer talks to the OpenAI-compatible `/v1/chat/completions` endpoint, which has **no per-request `num_ctx`** — so the in-app **Context Window** setting does not reach it. Start Ollama with `OLLAMA_CONTEXT_LENGTH=16384` (or bake `PARAMETER num_ctx` into a Modelfile), or the pipeline silently runs against the 4096-token default and comes back with truncated drafts. `ollama ps` shows the context actually in use. Ollama also has to listen on an address the container can reach: `OLLAMA_HOST=0.0.0.0:11434`.

### Security

The base URL comes from the environment **only**. No request field carries it, and none may be added: a client-supplied URL would turn every authenticated user into an arbitrary-origin POST proxy inside your Docker network, with reach to `db:5432` and `kong:8000`. The model id from a slot only ever becomes the request body's `model` field — it is never interpolated into the URL.

## Signup Control

| Variable | Default | Description |
|----------|---------|-------------|
| `DISABLE_SIGNUP` | `false` | Set to `true` to disable new user registration (useful after creating your accounts) |

## Image Proxy

| Variable | Default | Description |
|----------|---------|-------------|
| `IMGPROXY_URL` | — (empty) | Set to `http://imgproxy:8080` only if running imgproxy (`docker compose --profile imgproxy up -d`) |

## License Key (Optional)

Premium features on a self-hosted instance (AI Rewrite, Character Chat, Portrait Generation) are unlocked with a license key generated by the hosted service. **You do not need the Premium plan for this — the cheapest Basic plan is enough.** Because these features run on *your own* API keys and infrastructure, a hosted Basic subscription mints a full-premium, 1-year self-hosted license.

To obtain one:

1. Subscribe to **Basic** at [creativewriter.dev](https://creativewriter.dev) (any paid plan works; Basic is the cheapest).
2. Open **Settings > Premium > Generate License Key** and copy the `LICENSE_KEY=…` line.
3. Add it either per-user in **Settings > Premium > License Key** on your instance, or server-wide via the `LICENSE_KEY` env var below.

Included AI (subsidised DeepSeek text + fal image) stays hosted-only and is never part of a self-hosted license — you use your own provider keys instead.

| Variable | Default | Description |
|----------|---------|-------------|
| `LICENSE_KEY` | — | Server-wide license key fallback. Per-user keys (entered in Settings > Premium > License Key) take precedence |

## Supabase Studio

| Variable | Default | Description |
|----------|---------|-------------|
| `STUDIO_PORT` | `54323` | Studio admin UI port (bound to `127.0.0.1`) |

Access Studio at `http://localhost:54323`. For remote servers, use an SSH tunnel: `ssh -L 54323:localhost:54323 your-server`.

## Security (Production)

| Variable | Default | Description |
|----------|---------|-------------|
| `SECRET_KEY_BASE` | hardcoded default | Realtime session secret — generate with `openssl rand -base64 32` |
| `DB_ENC_KEY` | `supabaserealtime` | Realtime database encryption key — generate with `openssl rand -hex 8` (must be exactly 16 bytes; `-hex 16` yields 32 bytes and crash-loops Realtime) |

## Advanced

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_PORT` | `5432` | PostgreSQL port |
| `NO_MODULE_CACHE` | `true` | Disable Deno module caching for Edge Functions. Set to `false` for faster cold starts if functions are stable |
