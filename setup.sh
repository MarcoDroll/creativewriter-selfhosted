#!/bin/sh
# ──────────────────────────────────────────────────────────────
# CreativeWriter Self-Hosted — Production Setup Script
#
# Generates fresh secrets and writes a .env file.
# Requires: openssl
#
# Usage:
#   ./setup.sh            # Generate .env from .env.example
#   ./setup.sh --force    # Overwrite existing .env
# ──────────────────────────────────────────────────────────────
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_EXAMPLE="$SCRIPT_DIR/.env.example"
ENV_FILE="$SCRIPT_DIR/.env"

# ── Pre-flight checks ────────────────────────────────────────

if ! command -v openssl >/dev/null 2>&1; then
  echo "Error: openssl is required but not installed." >&2
  exit 1
fi

if [ ! -f "$ENV_EXAMPLE" ]; then
  echo "Error: $ENV_EXAMPLE not found." >&2
  exit 1
fi

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help)
      echo "Usage: $0 [--force]"
      echo ""
      echo "Generates fresh secrets and writes .env from .env.example."
      echo "Refuses to overwrite an existing .env unless --force is given."
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

if [ -f "$ENV_FILE" ] && [ "$FORCE" -eq 0 ]; then
  echo "Error: $ENV_FILE already exists. Use --force to overwrite." >&2
  exit 1
fi

# ── Generate secrets ─────────────────────────────────────────

POSTGRES_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET=$(openssl rand -base64 40 | tr -d '\n')

# ── Generate JWTs (HS256) ────────────────────────────────────

base64url_encode() {
  openssl base64 -A | tr '+/' '-_' | tr -d '='
}

sign_jwt() {
  role="$1"
  header=$(printf '{"alg":"HS256","typ":"JWT"}' | base64url_encode)
  payload=$(printf '{"role":"%s","iss":"supabase","iat":1700000000,"exp":2200000000}' "$role" | base64url_encode)
  signature=$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | base64url_encode)
  printf '%s.%s.%s' "$header" "$payload" "$signature"
}

ANON_KEY=$(sign_jwt "anon")
SERVICE_ROLE_KEY=$(sign_jwt "service_role")

# Generate optional security keys
SECRET_KEY_BASE=$(openssl rand -base64 48 | tr -d '\n')
# Realtime uses AES-128-ECB, which requires a 16-byte key.
# `openssl rand -hex 8` emits 16 ASCII chars = 16 bytes.
DB_ENC_KEY=$(openssl rand -hex 8)

# ── Self-test: verify JWT header decodes correctly ────────────

verify_jwt() {
  token="$1"
  label="$2"
  header_part=$(echo "$token" | cut -d. -f1)
  # Re-pad base64url to base64
  padded=$(echo "$header_part" | tr '_-' '/+')
  mod=$((${#padded} % 4))
  if [ "$mod" -eq 2 ]; then padded="${padded}=="; elif [ "$mod" -eq 3 ]; then padded="${padded}="; fi
  decoded=$(echo "$padded" | openssl base64 -d -A 2>/dev/null || true)
  if echo "$decoded" | grep -q '"alg"'; then
    echo "  $label: OK"
  else
    echo "  $label: FAILED — JWT header did not decode correctly" >&2
    exit 1
  fi
}

# ── Write .env ────────────────────────────────────────────────

cp "$ENV_EXAMPLE" "$ENV_FILE"

# Replace secrets using sed (pipe delimiter avoids base64 slash conflicts)
# Uses temp file for BSD/macOS portability (sed -i differs across platforms)
sed \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$POSTGRES_PASSWORD|" \
  -e "s|^JWT_SECRET=.*|JWT_SECRET=$JWT_SECRET|" \
  -e "s|^ANON_KEY=.*|ANON_KEY=$ANON_KEY|" \
  -e "s|^SERVICE_ROLE_KEY=.*|SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY|" \
  -e "s|^# SECRET_KEY_BASE=.*|SECRET_KEY_BASE=$SECRET_KEY_BASE|" \
  -e "s|^# DB_ENC_KEY=.*|DB_ENC_KEY=$DB_ENC_KEY|" \
  "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"

# ── Verify ────────────────────────────────────────────────────

echo ""
echo "Generated .env with fresh secrets:"
echo ""
verify_jwt "$ANON_KEY" "ANON_KEY"
verify_jwt "$SERVICE_ROLE_KEY" "SERVICE_ROLE_KEY"
echo ""
echo "Secrets written to: $ENV_FILE"

# ── Next steps ────────────────────────────────────────────────

COMPOSE_FILE=""
for f in docker-compose.stable.yml docker-compose.latest.yml docker-compose.yml; do
  if [ -f "$SCRIPT_DIR/$f" ]; then
    COMPOSE_FILE="$f"
    break
  fi
done

echo ""
echo "Next steps:"
if [ -n "$COMPOSE_FILE" ]; then
  echo "  docker compose -f $COMPOSE_FILE up -d"
else
  echo "  docker compose up -d"
fi
echo ""
echo "Then open http://localhost:3000"
echo ""
echo "─── Production Checklist ───────────────────────────────────"
echo ""
echo "If deploying on a server (not just localhost), also configure:"
echo ""
echo "  1. SUPABASE_PUBLIC_URL  → set to your actual domain (e.g. https://write.example.com)"
echo "  2. SMTP settings        → required for password reset and email confirmation"
echo "     Set MAILER_AUTOCONFIRM=false and configure SMTP_HOST, SMTP_USER, etc."
echo "  3. DISABLE_SIGNUP       → set to true after creating your accounts"
echo "  4. TLS / HTTPS          → use a reverse proxy (nginx, Caddy, Cloudflare Tunnel)"
echo ""
echo "⚠  Without SMTP, password reset will not work even with MAILER_AUTOCONFIRM=true."
echo "   Users who forget their password will have no recovery path."
echo ""
echo "See docs/deployment.md for full production guidance."
