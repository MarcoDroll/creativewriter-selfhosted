# Getting Started

The self-hosted version gives you full control over your data. Your stories, characters, media, and all associated content are stored entirely on your own server — nothing is sent to external services unless you explicitly configure an AI provider. This is intended for personal use to maintain data sovereignty, not for redistribution.

## Requirements

- Docker Engine 20.10+ and Docker Compose v2
- 2 GB RAM minimum (4 GB recommended)
- 10 GB disk space

## Quick Start

1. **Clone the repository**

   ```bash
   # Stable (recommended)
   git clone --branch main https://github.com/MarcoDroll/creativewriter-selfhosted.git
   cd creativewriter-selfhosted

   # Or latest (bleeding edge)
   git clone --branch develop https://github.com/MarcoDroll/creativewriter-selfhosted.git
   cd creativewriter-selfhosted
   ```

2. **Start services**

   ```bash
   # Stable
   docker compose -f docker-compose.stable.yml up -d

   # Or latest
   docker compose -f docker-compose.latest.yml up -d
   ```

3. **Open the app** at `http://localhost:3000`

   Storage buckets are initialized automatically on first boot.

The included `.env` has working default secrets and email auto-confirm enabled — no manual configuration needed for local use.

## Release Channels

| Channel | Branch | Compose File | Image Tag | Updated |
|---------|--------|-------------|-----------|---------|
| **Stable** | `main` | `docker-compose.stable.yml` | `:stable` | On each release |
| **Latest** | `develop` | `docker-compose.latest.yml` | `:latest` | On every push to `main` |

Stable is recommended for most users. Latest tracks the development branch and may contain untested changes.

## Next Steps

- [Configuration](configuration.md) — customize environment variables
- [Deployment](deployment.md) — set up for production
- [AI Providers](ai-providers.md) — connect your AI models
