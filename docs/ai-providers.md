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
summaries, codex Field-Fill, scene chat, Selection Rewrite) — constraining those would turn a paragraph
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

### RunPod (experimental)

The author's own RunPod Serverless endpoints running the imagegen worker — an **Own Endpoint**
(`CONTEXT.md`). Shown only when the top-level `experimentalProviders` switch is on; that switch is
per device, never synced and never exported.

| Field | Type | Default |
|-------|------|---------|
| `apiKey` | string | — |
| `enabled` | boolean | `false` |
| `kleinEndpointId` | string | `''` — FLUX.2 klein's endpoint; empty means that model is not offered |
| `qwenEndpointId` | string | `''` — Qwen Image 2.1's endpoint |
| `videoEndpointId` | string | `''` — the Sulphur 2 clip endpoint (Clips); empty means no Sulphur 2 row |
| `wanEndpointId` | string | `''` — the Wan 2.2 Remix clip endpoint (`wan22-remix-v3-i2v`); empty means no Wan row |
| `dasiwaEndpointId` | string | `''` — the DaSiWa H3 Hybrid clip endpoint (`dasiwa-h3-hybrid-v1-i2v`); empty means no DaSiWa row |
| `videoConsent` | boolean | `false` — the author's attestation that anyone shown in a start frame is an adult who consents, or is not a real person. The worker refuses every clip without it. **Never exported, never imported**: an attestation is made on the device it was made on |

Like every provider block it stays on the device: not synced, and its key leaves an export only on
opt-in. Use a RunPod key **restricted** to your endpoints with Read/Write access — measured to be
enough to run jobs. An endpoint must be a queue endpoint serving the imagegen API, schema v1, one
model each; the public requirements page is linked from Settings. Licences: FLUX.2 klein is FLUX
Non-Commercial; Qwen Image 2.1 is the Qwen Research License ("Built with Qwen", shown where the
model is chosen and configured).

## Feature-Specific Model Selection

Several features allow you to select a specific model override independent of the global selection:

- **Scene Title Generation** — `selectedModel` field
- **Scene Summary Generation** — `selectedModel` field
- **Staging Notes Generation** — `selectedModel` field
- **Scene Generation from Outline** — `selectedModel` field
- **Agentic Writer (Deep Writer)** — separate `writingModel`, `researchModel`, and `refinerModel` fields. The writing model is the orchestrator (plans research + writes). Research agents use the research model. The refiner model is used for thorough mode refinement. The Deep Writer model option appears in beat generation for all subscribers; if the writing model is not configured, an alert prompts the user to configure it in Settings > Deep Writer. Deep Writer is only available in beat generation — it is filtered out from scene chat and rewrite/polish model lists.

  **Codex-state injection** is controlled by `agenticWriter.useCodexState` (default `false`). When enabled, the `/research` phase reads tracked codex state (`codex_entry_current_state`) and injects a CURRENT CODEX STATE block into `/draft` + `/refine`. Off by default because stale tracking degrades generation quality; enable it via the Settings > Deep Writer toggle once tracked state is current.

## Image Generation Providers

Image generation supports four providers, and a fifth behind the Experimental providers switch:

| Provider | Use Case |
|----------|----------|
| OpenRouter | Text-to-image and image-to-image via OpenRouter's image models |
| fal.ai | Direct fal.ai image generation |
| Replicate | Direct Replicate image generation |
| Venice | Direct Venice image generation, including its `/image/multi-edit` endpoints |
| RunPod (experimental) | The author's own imagegen endpoints: FLUX.2 klein and Qwen Image 2.1 — text to image, edit with ordered guides, inpaint. Called from the browser; no Supabase in the path |

**Image-to-image** is available in the standalone Image Generation tool for any model that takes
reference images: an OpenRouter row that publishes `input_references`, or one of the curated
endpoints in `reference-endpoint.catalog.ts` (fal, Replicate, Venice). Reference bytes are kept
per job in IndexedDB so a render can be repeated after a reload — see
`docs/adr/0005-reference-bytes-live-in-indexeddb.md`.

Configure your preferred provider in Settings > Image Generation. The `preferredProvider` default is `openrouter`.

### Video (Clips)

The same tool renders short videos — **Clips** — from a prompt and, usually, a start frame (guide 1;
guide 2 is the end frame where the model takes one). Switch the `Stills | Video` segment above the
model picker. A Clip is made with **your own provider key** and bills you at the provider; nothing is
spent unless you tap the Generate button twice (the second tap says the price).

| Provider | Called from | Result | Cancel | Price shown |
|----------|-------------|--------|--------|-------------|
| OpenRouter | the browser, directly | downloaded with your key | none — "Stop watching", the provider may still charge | listed price per model |
| Venice | the browser, directly | the file itself (a share link for "private" models) | none | exact quote before you confirm |
| fal.ai | `proxy-fal` (your key rides in a header) | fal's CDN, downloaded straight from the browser | yes | listed price for per-second and per-clip models, otherwise "price unknown" |
| Replicate | `proxy-replicate` | Replicate's CDN, downloaded **at once** (the link lasts about an hour) | yes | none published — "price unknown" |

Clips are stored **on the device you made them on** (a separate, capped store — 50 MB per clip, 250 MB
in all), never in Supabase. The provider list is loaded only when the Video segment is opened.

Measured behaviour these depend on (probed 2026-09-29, one cheapest clip each): both providers allow
browser access (CORS) to submit, poll and download; OpenRouter's download needs the `Authorization`
header; Venice's completed job can be fetched again, so a reload does not lose a paid clip; Venice's
`/video/complete` answers 400 "Request ID is invalid" and the app never calls it. The probes are in
`scripts/probes/video-*.mjs` (a dry run unless `--yes`; keys come from a `--keys` file kept outside the
repository).

**fal.ai and Replicate go through the Edge Function proxies**, so they cost Supabase invocations and egress
the browser-direct providers do not: about 33 invocations for a five-minute clip (10 for a one-minute one),
plus the start frame (up to about 1.3 MB) riding the submit. The first status look is at 5 s, then every 10 s,
and polls have their own rate-limit bucket in both proxies. To keep egress down, fal's per-model options are
read **only when you choose the model** (one small request, cached for a week) rather than for all ~200, and
Replicate's model list (about 390 KB) is cached for a week.

**Safety.** Where a model documents a safety setting — fal's `enable_safety_checker` or `safety_tolerance`,
Replicate's `disable_safety_checker` or `disable_safety_filter` (an inverted flag) — a Clip **starts at the
loosest** value the model's schema offers, and a *Safety filter* row lets you set it back to the provider's
own default. This is the one setting sent without being picked. A provider can still refuse a prompt, and a
refusal is a refusal: there is no automatic retry.

**RunPod (your own Sulphur 2 endpoint).** One fixed row, *Sulphur 2* (MiniMax H3 until 2026-10-01), offered when the Experimental switch is on and the
RunPod block is enabled and has a key and a clip endpoint id. It is called straight from the browser like the still endpoints — no
proxy, no Supabase — and the clip comes back inside the job's result (`output.videos[0].b64`, about 1 MB for 5 s at 768 px)
and is kept on the device. What was measured (2026-09-30, RTX 5090): `POST /run` answers at once; a 5 s Animate job took
68 s and came back as H.264 with a stereo AAC track. The worker takes a start frame (**required**), a last frame (guide 2, optional), a length of 2–10 s
(it snaps to its 24 fps 8n+1 frame grid: 5 s renders 5.04 s), and a seed. It **refuses** `negative_prompt` and
`output.format` (and `turbo`), so the row offers none. Sound is always on. The start frame decides the shape; there is no size to pick.

**Two more clip models, each on its own endpoint** (one endpoint ID setting each; a row appears only while its ID is set):

- *Wan 2.2 Remix* (`wan22-remix-v3-i2v`): start frame, optional last frame, 2–7.5 s at **16 fps** (3 / 5 / 7.5 offered).
  It **requires a description of the clip's sound** (`sound_prompt`, made by a separate sound pass), so the composer shows
  a *Sound* field and holds Generate until it has text. No turbo, negative prompt, CFG or LoRAs. The canvas follows the
  start frame (short edge 480, at most 1280×720).
- *DaSiWa H3 Hybrid* (`dasiwa-h3-hybrid-v1-i2v`): the MiniMax H3 request without turbo — one start frame, 5–10 s at
  24 fps, native sound with speech. **Slow:** it renders about 2–3 minutes per 5 s of clip once running; the composer
  says so. (The cold start no longer downloads the 21 GB checkpoint — the worker runs from its own slim repo since
  imagegen-serverless `4cd80ca`.) **References:** up to 9 pictures of people or things that appear
  (`reference_images`), named in the prompt as `<Picture 1>` … in their order; with one, the start frame is optional.
  Each adds to the work budget. **Resolution:** 480p, 576p or 704p (in the start
  frame's shape), or Auto — the worker's 768 canvas, which fits at most 8 s (5 s when continuing) in its work budget;
  a longer clip asks for a lower resolution.

The request is the imagegen schema v1 (`imagegen-serverless/docs/api-schema.json`), whose `request.oneOf` holds **one
JSON Schema per model** — each model refuses every field it does not take, so `sound_prompt` goes to Wan only. The frame
goes as `images: [{ b64 }]`, with `consent_attestation: true`. **Continue** a finished Clip from its ⋮ menu
(*Continue this clip*): it becomes the Lead Clip of the next one, sent as `lead_clip` instead of the start frame, and only
the new part comes back. Sulphur 2 and DaSiWa take a 24 fps lead of up to 12 s, Wan any frame rate up to 30 s (it adds
at most 4.75 s). The lead is sent inline, so it must be under about 6.5 MB to fit RunPod's request limit. A clip made by
Continue cannot itself be continued, since it holds only the added part. The clip's frame rate is read from
the result (`videos[0].fps`). RunPod's `/status` sometimes answers HTTP 500 for a job that is fine, so a 5xx there is
treated as "still running". **The consent is a Settings toggle, not a default**: without it
the app refuses before any request, so nothing is spent. The worker also has a content baseline against minors
(`content_policy`, shown as a refusal). Check the Sulphur 2 (LTX-2 Community) licence for where and how you may use it.

Two things differ from the other providers. **Cancel stops the watch, not necessarily the render:** RunPod marks the
job cancelled, but the worker was seen still running afterwards, so the remainder may still be billed. And **the cost is
unknown**: RunPod bills GPU seconds at your own rate, which the app cannot see. A finished result is deleted by RunPod
after 30 minutes, so a job collected later is reported as expired. A `bucket` delivery (a presigned link) is accepted if a
worker returns one; the app asks for inline base64.
