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

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `baseUrl` | string | `http://localhost:11434` | |
| `model` | string | — | |
| `temperature` | number | `0.7` | |
| `topP` | number | `1.0` | |
| `maxTokens` | number | `2000` | Ollama `num_predict`. Applies to codex/research/summary calls only — **beat generation computes its own** from the beat's word count and never reads this. |
| `contextWindow` | number | `0` | Ollama `num_ctx`. **0 = omit the parameter**, so the server's default applies. See the warning below. |
| `requestTimeoutSeconds` | number | `300` | Deadline for the non-streaming calls that have one (codex state tracking, scene summaries/titles, codex assist, illustration prompts). **0 = no limit.** Beat generation is never timed out. |
| `enabled` | boolean | `false` | |

**`contextWindow` is the setting to reach for when local beats come back empty.**
Ollama's default context window is **4096 tokens and it silently truncates the prompt to fit**
([docs](https://docs.ollama.com/context-length)). Beat generation reserves at least 3000 tokens for
output, which leaves roughly a thousand for the story context, glossary and current scene — so the
model receives a prompt with most of the story cut out of it, and often answers with nothing.

Raise it here (16384 is a reasonable starting point), and — **for Deep Writer, required** — on the
server with `OLLAMA_CONTEXT_LENGTH=16384` / a Modelfile `PARAMETER num_ctx`. The two are not
interchangeable: the Deep Writer pipeline runs server-side against Ollama's OpenAI-compatible `/v1`
endpoint, which has no `options.num_ctx`, so the field above never reaches it. See
[Local AI Providers for Deep Writer](configuration.md#local-ai-providers-for-deep-writer-self-hosted).
Do not simply set it to the model's
advertised maximum: a 128k window either fails to allocate on consumer hardware or spills to system
RAM and runs an order of magnitude slower. The app deliberately does not auto-derive it for that
reason.

**Strict-JSON requests.**
Seven features need the model to answer with a JSON object rather than prose: codex state
tracking, codex AI-generate, character flesh-out, reference-document import, story-codex bootstrap,
story planning, and the illustration prompt distiller. For those calls — and only those — the app
adds Ollama's top-level [`format: "json"`](https://docs.ollama.com/capabilities/structured-outputs)
to the request, which grammar-constrains decoding so the output can only be a well-formed JSON
object. This is what makes a reasoning model usable for them: a `<think>` preamble or a ``` fence
becomes impossible rather than merely discouraged, so the `Model did not return valid JSON` failure
goes away.

It is **not configurable**, and it is never sent for prose calls (beat generation, scene titles and
summaries, codex Field-Fill, scene chat, AI rewrite) — constraining those would turn a paragraph
into a JSON object. Confirm which calls carried it in the AI log: the request details show
`jsonMode`.

If a model behaves worse under the constraint (a weak model that ignores the "respond in JSON"
instruction can emit whitespace until it hits Max Tokens; the app reports that as a JSON-mode
failure rather than telling you to raise the limit), the escape hatch is the **OpenAI-Compatible**
provider, which sends no such field — point its `baseUrl` at `http://localhost:11434` and pick the
same model. Do this **together with a server-side context window** (`OLLAMA_CONTEXT_LENGTH=16384`,
or a Modelfile `PARAMETER num_ctx`): that provider has no `contextWindow` field, so switching to it
otherwise drops you back to Ollama's silently-truncating 4096-token default described above.

**Reaching Ollama from the browser:**

- **Self-hosted Docker (HTTP):** `http://localhost:11434` or `http://<LAN-IP>:11434` works directly. The Docker nginx build allows plain `http:` in `connect-src`, so the browser will not block the request.
- **Hosted SaaS (creativewriter.dev) or self-hosted behind an HTTPS reverse proxy:**
  - `http://localhost:11434` / `http://127.0.0.1:11434` **works** — loopback is a potentially-trustworthy origin, so mixed-content rules permit it, and `public/_headers` allows those two sources in `connect-src`. Ollama must run on the same machine as the browser.
  - `http://<LAN-IP>:11434` is **blocked and cannot be unblocked from our side**: mixed-content rules refuse plain HTTP from an HTTPS page regardless of CSP. Expose Ollama over HTTPS via a tunnel (Cloudflare Tunnel, ngrok) or an nginx reverse proxy with a TLS cert, then enter the `https://` URL. The app names this case specifically rather than reporting a generic connection failure — the request never leaves the browser, so the server is not where to look. Four surfaces say it, in the order an author meets them: an inline hint under the Base URL field once typing settles (`settings.api.insecureEndpointHint`), the connection test (`settings.api.insecureEndpointBlocked`), the model dropdown itself, and a failed generation (`providerError.insecure-endpoint`). The first two are suppressed against each other, so only one of them is ever on screen. The dropdown's line covers every screen that loads its own model list — scene chat, story research, AI rewrite, the story wizard — where an empty list would otherwise be the only symptom; it is **text only** (no button), because most of those selectors live inside modal overlays where navigating to Settings would mean dismissing first. It appears only when the list is empty *and* a provider load failed, and it replaces the "No AI provider configured" hint, which is untrue in that case. That line is **not specific to this failure** — see *Why a model list is empty* below.
  - **Nothing is requested from such an address.** Test Connection is disabled while either field holds one (Ollama and OpenAI-Compatible alike), with the same text as its tooltip; the gate closes on the same debounce as the hint, so a click in the moment right after pasting a URL still runs and reports the failure, and correcting a bad URL leaves the button disabled until that debounce settles. `ModelService.loadOllamaModels()` / `loadOpenAICompatibleModels()` return an empty list without fetching, which covers the auto-load-on-type and the **Load Models** button — those swallow failures into an empty list, so an ungated request there fails silently. That check reads the live URL rather than the debounced flag.
  - **This is a prediction, and it can be wrong.** A browser told to allow insecure content for the origin (Chrome's site permission, or `--unsafely-treat-insecure-origin-as-secure`) *can* reach a plain-HTTP LAN server. Such a setup is blocked in Settings by the above, while generation is not pre-gated and would still work. If that combination ever needs supporting, the fix is an explicit "I know what I'm doing" escape rather than loosening the classification, which is correct for every default browser.
- On the Ollama side (any case), set `OLLAMA_HOST=0.0.0.0:11434` so it binds to all interfaces and `OLLAMA_ORIGINS=*` so it accepts cross-origin requests from the app.

### OpenAI-Compatible

Any OpenAI-compatible API endpoint (LM Studio, vLLM, text-generation-webui, etc.).

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `baseUrl` | string | `http://localhost:1234` | |
| `apiKey` | string | — | |
| `model` | string | — | |
| `temperature` | number | `0.7` | |
| `topP` | number | `1.0` | |
| `maxTokens` | number | `2000` | |
| `requestTimeoutSeconds` | number | `300` | As for Ollama above. **0 = no limit.** Beat generation is never timed out. |
| `enabled` | boolean | `false` | |

There is no `contextWindow` here: the context length of an OpenAI-compatible server is set on the
server (LM Studio's model load settings, vLLM's `--max-model-len`), not per request. That applies to
Deep Writer too, where it is the **only** control — and where the `apiKey` above does not apply
either: the pipeline runs server-side and authenticates with the operator's
`OPENAI_COMPATIBLE_API_KEY`, never with a browser-side credential. See
[Local AI Providers for Deep Writer](configuration.md#local-ai-providers-for-deep-writer-self-hosted).

**Reaching the server from the browser** works exactly as described for Ollama above, and is
enforced by the same code: loopback over plain HTTP is fine from the hosted app, a plain-HTTP LAN
address is not, and all four surfaces listed above say so specifically.

## Why a model list is empty

Every model-list loader in `ModelService` swallows its failure into an empty array. That is
deliberate — one dead provider must not empty the dropdown for the others — but it means the
emission alone cannot distinguish "the server is down", "the key was rejected", "the browser
refused to send it" and "this provider genuinely has no models".

So the loaders record the outcome on a side channel, `ModelService.modelLoadStatus$` (with the
synchronous `getModelLoadStatuses()` for a consumer already inside a render pass). Per provider:
`loading` | `loaded` (with a count) | `failed` — and a failure carries a `ProviderErrorCode`, so
display sites translate it via `providerError.<code>` instead of showing English. What the loaders
*emit* is unchanged; nothing rejects.

Two surfaces read it, both through the same pure `explainEmptyModelList()`, and **both only when
the list they are explaining is empty**. A partial list is not an error state: naming one dead
provider next to a working 300-model dropdown replaces a true statement with an alarming one.

- the shared **model selector**, for the one-line hint above an empty dropdown, and
- **Settings → AI Models**, whose "Load models" error line used to be one hardcoded English
  sentence about API keys regardless of what actually went wrong.

`insecure-endpoint` outranks any other failure when several providers are broken at once: it is
the only one whose remedy is unambiguous and entirely in the author's hands, and the only one
where nothing was ever sent. Only providers that could have contributed are considered —
Replicate is an image provider, so a broken Replicate key is never the reason a *text* list is
empty — and a status is dropped once its provider is no longer configured, so a stale failure
cannot be reported as the reason for a list it no longer belongs to.

**A superseded load never wins.** Editing a key or a base URL while a fetch is in flight starts a
second, independent fetch (they are deduped by `provider:credential`, so the new one is not folded
into the old), and nothing orders their completions — the browser may settle the *older* one last.
Each load therefore claims a generation, and a settled response writes its models and its status
only while it still holds the current one; disabling a provider or skipping an unreachable
endpoint claims a generation too, since both mean "what is in flight is no longer what was asked
for". A superseded failure is still logged (marked `(superseded)`) — it did happen — it just does
not overwrite the newer outcome. The caller that asked for a load still receives what came back;
the guard is about what the service *stores*.

The one thing deliberately **not** generation-gated is `loading$`, because it is a single boolean
describing every load at once: a superseded response still ends a real request, so it must still
count down. That flag is now a *count* rather than a flip — it used to go false as soon as the
first of several providers settled — and the decrement lives in `finalize`, so a response that
completes without emitting, or a caller that unsubscribes, cannot strand the spinner on.

**What it does not cover:** a provider whose *list* loads but whose *generation* then fails (a
Gemini key is never validated by a list fetch — the list is a constant), and a `0`-status failure,
which cannot distinguish a stopped server from a missing CORS header. Both report
`provider-unavailable`, which is honest rather than precise.

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

  **Codex-state injection** is controlled by `agenticWriter.useCodexState` (default `false`). When enabled, the `/research` phase reads tracked codex state (`codex_entry_current_state`) and injects a CURRENT CODEX STATE block into `/draft` + `/refine`. Off by default because stale tracking degrades generation quality; enable it via the Settings > Deep Writer toggle once tracked state is current.

## Image Generation Providers

Image generation supports three providers:

| Provider | Use Case |
|----------|----------|
| OpenRouter | Text-to-image via OpenRouter's image models |
| fal.ai | Direct fal.ai image generation |
| Replicate | Direct Replicate image generation |

Configure your preferred provider in Settings > Image Generation. The `preferredProvider` default is `openrouter`.
