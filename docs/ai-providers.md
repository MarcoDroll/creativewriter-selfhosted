# AI Provider Configuration

CreativeWriter supports multiple AI providers. You configure them in **Settings** within the app. Each provider requires an API key and has its own set of parameters.

## Providers

### OpenRouter

Aggregated access to hundreds of AI models from multiple providers.

| Field | Type | Default |
|-------|------|---------|
| `apiKey` | string | — |
| `model` | string | — |
| `temperature` | number | `0.7` |
| `topP` | number | `1.0` |
| `enabled` | boolean | `false` |
| `zeroDataRetention` | boolean | `true` |
| `denyDataCollection` | boolean | `true` |
| `ignoredProviders` | string[] | `[]` |

Privacy controls (`zeroDataRetention`, `denyDataCollection`, `ignoredProviders`) filter which upstream providers handle your requests.

**One-click connection (hosted only):** On the hosted version, you can click "Connect with OpenRouter" to authenticate via OAuth PKCE and receive an API key automatically — no manual copy-paste needed. This option is hidden on self-hosted deployments (which typically lack the HTTPS on port 443/3000 that OpenRouter requires for callbacks).

API requests include `X-Title: Creative Writer` and `X-OpenRouter-Categories: creative-writing` headers for app attribution.

### Google Gemini

Direct access to Google's Gemini models.

| Field | Type | Default |
|-------|------|---------|
| `apiKey` | string | — |
| `model` | string | `gemini-2.5-flash` |
| `temperature` | number | `0.7` |
| `topP` | number | `1.0` |
| `enabled` | boolean | `false` |
| `contentFilter` | object | All categories set to `BLOCK_NONE` |

Content filter categories: `harassment`, `hateSpeech`, `sexuallyExplicit`, `dangerousContent`, `civicIntegrity`. Each accepts: `BLOCK_NONE`, `BLOCK_ONLY_HIGH`, `BLOCK_MEDIUM_AND_ABOVE`, `BLOCK_LOW_AND_ABOVE`.

### Claude (Anthropic)

Direct access to Anthropic's Claude models.

| Field | Type | Default |
|-------|------|---------|
| `apiKey` | string | — |
| `model` | string | `claude-3-5-sonnet-20241022` |
| `temperature` | number | `0.7` |
| `topP` | number | `1.0` |
| `topK` | number | `0` |
| `enabled` | boolean | `false` |

### Ollama

Local AI models via Ollama.

| Field | Type | Default |
|-------|------|---------|
| `baseUrl` | string | `http://localhost:11434` |
| `model` | string | — |
| `temperature` | number | `0.7` |
| `topP` | number | `1.0` |
| `maxTokens` | number | `2000` |
| `enabled` | boolean | `false` |

### OpenAI-Compatible

Any OpenAI-compatible API endpoint (LM Studio, vLLM, text-generation-webui, etc.).

| Field | Type | Default |
|-------|------|---------|
| `baseUrl` | string | `http://localhost:1234` |
| `apiKey` | string | — |
| `model` | string | — |
| `temperature` | number | `0.7` |
| `topP` | number | `1.0` |
| `maxTokens` | number | `2000` |
| `enabled` | boolean | `false` |

### Replicate

Cloud-hosted AI models via Replicate (primarily used for image generation).

| Field | Type | Default |
|-------|------|---------|
| `apiKey` | string | — |
| `model` | string | — |
| `version` | string | — |
| `enabled` | boolean | `false` |

### fal.ai

Cloud-hosted image generation models via fal.ai.

| Field | Type | Default |
|-------|------|---------|
| `apiKey` | string | — |
| `enabled` | boolean | `false` |

## Feature-Specific Model Selection

Several features allow you to select a specific model override independent of the global selection:

- **Scene Title Generation** — `selectedModel` field
- **Scene Summary Generation** — `selectedModel` field
- **Staging Notes Generation** — `selectedModel` field
- **Scene Generation from Outline** — `selectedModel` field
- **Agentic Writer (Deep Writer)** — separate `writingModel`, `researchModel`, and `refinerModel` fields. The writing model is the orchestrator (plans research + writes). Research agents use the research model. The refiner model is used for thorough mode refinement. The Deep Writer model option appears in beat generation for all subscribers; if the writing model is not configured, an alert prompts the user to configure it in Settings > Deep Writer. Deep Writer is only available in beat generation — it is filtered out from scene chat and rewrite/polish model lists.

## Image Generation Providers

Image generation supports three providers:

| Provider | Use Case |
|----------|----------|
| OpenRouter | Text-to-image via OpenRouter's image models |
| fal.ai | Direct fal.ai image generation |
| Replicate | Direct Replicate image generation |

Configure your preferred provider in Settings > Image Generation. The `preferredProvider` default is `openrouter`.
