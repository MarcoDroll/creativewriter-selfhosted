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

## AI Proxy (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEPSEEK_API_KEY` | — | **No effect on self-hosted.** Included AI (DeepSeek) is only available on the hosted version |

## Signup Control

| Variable | Default | Description |
|----------|---------|-------------|
| `DISABLE_SIGNUP` | `false` | Set to `true` to disable new user registration (useful after creating your accounts) |

## Image Proxy

| Variable | Default | Description |
|----------|---------|-------------|
| `IMGPROXY_URL` | — (empty) | Set to `http://imgproxy:8080` only if running imgproxy (`docker compose --profile imgproxy up -d`) |

## License Key (Optional)

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
| `DB_ENC_KEY` | `supabaserealtime` | Realtime database encryption key — generate with `openssl rand -hex 16` |

## Advanced

| Variable | Default | Description |
|----------|---------|-------------|
| `POSTGRES_PORT` | `5432` | PostgreSQL port |
| `NO_MODULE_CACHE` | `true` | Disable Deno module caching for Edge Functions. Set to `false` for faster cold starts if functions are stable |
