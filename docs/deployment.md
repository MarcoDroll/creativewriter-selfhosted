# Production Deployment

Self-hosting is designed for personal use so you keep full control over your data. A production deployment means running on your own server with proper secrets — not exposing the app as a public service for others. Redistribution is not permitted.

## Generate Fresh Secrets

For any publicly accessible deployment, generate fresh secrets before starting:

```bash
./setup.sh              # Generates .env with fresh secrets
# ./setup.sh --force    # Overwrite existing .env
```

This creates random values for:
- `POSTGRES_PASSWORD`
- `JWT_SECRET`
- `ANON_KEY` (HS256 JWT with role=anon)
- `SERVICE_ROLE_KEY` (HS256 JWT with role=service_role)
- `SECRET_KEY_BASE`
- `DB_ENC_KEY`

The script requires `openssl` and verifies that generated JWTs decode correctly.

## Configure SMTP

For production, you need working email for signup confirmation and password reset:

1. Set `MAILER_AUTOCONFIRM=false` in `.env`
2. Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_SENDER_EMAIL`

## Set the Public URL

Update `SUPABASE_PUBLIC_URL` in `.env` to your actual domain:

```
SUPABASE_PUBLIC_URL=https://your-domain.com
```

This is used for auth redirects, CORS, and API routing.

## Start Services

```bash
docker compose -f docker-compose.stable.yml up -d
```

## Optional: Configure Premium

See the [Premium Features section in Configuration](configuration.md#premium-features-optional) for Stripe setup.

## Optional: Enable imgproxy

```bash
docker compose -f docker-compose.stable.yml --profile imgproxy up -d
```

## HTTPS / TLS Termination

CreativeWriter's nginx container serves plain HTTP on port 80. For production, terminate TLS with a reverse proxy in front of it.

### Option 1: Caddy (automatic HTTPS)

Caddy obtains and renews certificates automatically via Let's Encrypt.

```
# Caddyfile
write.example.com {
    reverse_proxy localhost:3000
}
```

```bash
caddy run --config /etc/caddy/Caddyfile
```

### Option 2: nginx + certbot

```nginx
server {
    listen 443 ssl;
    server_name write.example.com;

    ssl_certificate /etc/letsencrypt/live/write.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/write.example.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Obtain certificates with: `certbot certonly --nginx -d write.example.com`

### Option 3: Cloudflare Tunnel

Zero-config TLS without opening inbound ports:

```bash
cloudflared tunnel create creativewriter
cloudflared tunnel route dns creativewriter write.example.com
cloudflared tunnel run --url http://localhost:3000 creativewriter
```

### Important

After setting up TLS, update `SUPABASE_PUBLIC_URL` in `.env` to use `https://`:

```
SUPABASE_PUBLIC_URL=https://write.example.com
```

WebSocket connections (Realtime) work through all three options — the reverse proxy must forward `Upgrade` headers.

## Release Channels

| Channel | Compose File | Image Tag | Updated |
|---------|-------------|-----------|---------|
| **Stable** | `docker-compose.stable.yml` | `:stable` | On each release |
| **Latest** | `docker-compose.latest.yml` | `:latest` | On every push to `main` |

Stable is recommended for production. Replace `docker-compose.stable.yml` with `docker-compose.latest.yml` in all commands to use the latest channel.
