import { encodeBase64 } from 'https://deno.land/std@0.224.0/encoding/base64.ts';
import { corsHeaders, handleCorsPreflightIfNeeded, jsonResponse } from '../_shared/cors.ts';
import { fetchWithTimeout, isTimeoutError } from '../_shared/timeout.ts';
import { UpstreamError, upstreamErrorResponse } from '../_shared/api-errors.ts';
import {
  classifyOpenRouterFailure,
  classifyOpenRouterPayloadError,
  PROMPT_LABELS,
} from './portrait-upstream.ts';
import { rateLimitResponse } from '../_shared/rate-limit.ts';
import {
  requireEnv,
  validateJwtAndGetSubscription,
  getOrCreateCustomer,
  getStripe,
} from '../_shared/stripe-helpers.ts';
import { checkMonthlyBudget, getCycleMonth, logImageUsage, logUsage, resolveIncludedAiTier } from '../_shared/ai-usage.ts';
import { deepseekRequestFields } from '../_shared/deepseek-model.ts';
import { parseModelSlot, resolveUpstream } from '../_shared/model-calling.ts';
import type {
  EntryKind,
  ErrorResponse,
  GeneratePortraitRequest,
  GeneratePortraitResponse,
  IncludedImageRequest,
  IncludedImageSize,
  PortraitModel,
  PortraitStyle,
} from '../_shared/types.ts';

// --- Premium handlers ---

async function handleIncludedAiChat(
  request: Request,
  headers: Record<string, string>,
): Promise<Response> {
  if (Deno.env.get('SELF_HOSTED') === 'true') {
    return jsonResponse<ErrorResponse>({ error: 'Included AI is not available on self-hosted instances', code: 'self-hosted-unavailable' }, 403, headers);
  }

  const validation = await validateJwtAndGetSubscription(request, headers);
  if (validation instanceof Response) return validation;
  const budgetTier = resolveIncludedAiTier(validation);
  if (!budgetTier) {
    return jsonResponse<ErrorResponse>({ error: 'Subscription required', code: 'subscription-required' }, 403, headers);
  }

  let customerId = validation.customerId;
  if (!customerId) {
    customerId = await getOrCreateCustomer(getStripe()!, validation.email!, validation.userId!);
  }
  const cycleMonth = getCycleMonth();

  const budget = await checkMonthlyBudget(customerId, budgetTier);
  if (budget.remainingUsd <= 0) {
    return jsonResponse({ error: 'Monthly AI budget exceeded', code: 'budget-exhausted', budget: { usagePercent: budget.usagePercent } }, 429, headers);
  }

  let body: {
    model?: string;
    messages?: { role: string; content: string | null }[];
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    stream?: boolean;
    tools?: unknown[];
    reasoning_effort?: string;
  };
  try {
    body = await request.json();
  } catch {
    return jsonResponse<ErrorResponse>({ error: 'Invalid request body' }, 400, headers);
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse<ErrorResponse>({ error: 'Request body must be a JSON object' }, 400, headers);
  }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonResponse<ErrorResponse>({ error: 'messages array is required' }, 400, headers);
  }
  if (body.messages.length > 200) {
    return jsonResponse<ErrorResponse>({ error: 'messages array exceeds maximum of 200 items' }, 400, headers);
  }
  for (const msg of body.messages) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return jsonResponse<ErrorResponse>({ error: 'Each message must be an object' }, 400, headers);
    }
    if (typeof msg.role !== 'string') {
      return jsonResponse<ErrorResponse>({ error: 'Each message must have a string role' }, 400, headers);
    }
    if (msg.content !== null && msg.content !== undefined && typeof msg.content !== 'string') {
      return jsonResponse<ErrorResponse>({ error: 'Message content must be a string or null' }, 400, headers);
    }
  }

  if (body.max_tokens !== undefined) {
    if (typeof body.max_tokens !== 'number' || !Number.isFinite(body.max_tokens)) {
      return jsonResponse<ErrorResponse>({ error: 'max_tokens must be a finite number' }, 400, headers);
    }
    if (body.max_tokens <= 0) {
      return jsonResponse<ErrorResponse>({ error: 'max_tokens must be positive' }, 400, headers);
    }
  }

  if (body.temperature !== undefined) {
    if (typeof body.temperature !== 'number' || !Number.isFinite(body.temperature)) {
      return jsonResponse<ErrorResponse>({ error: 'temperature must be a finite number' }, 400, headers);
    }
    if (body.temperature < 0 || body.temperature > 2) {
      return jsonResponse<ErrorResponse>({ error: 'temperature must be between 0 and 2' }, 400, headers);
    }
  }

  if (body.top_p !== undefined) {
    if (typeof body.top_p !== 'number' || !Number.isFinite(body.top_p)) {
      return jsonResponse<ErrorResponse>({ error: 'top_p must be a finite number' }, 400, headers);
    }
    if (body.top_p < 0 || body.top_p > 1) {
      return jsonResponse<ErrorResponse>({ error: 'top_p must be between 0 and 1' }, 400, headers);
    }
  }

  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) {
      return jsonResponse<ErrorResponse>({ error: 'tools must be an array' }, 400, headers);
    }
    if (body.tools.length > 50) {
      return jsonResponse<ErrorResponse>({ error: 'tools array exceeds maximum of 50 items' }, 400, headers);
    }
  }

  const allowedModels = ['deepseek-chat', 'deepseek-reasoner'];
  if (body.model !== undefined && (typeof body.model !== 'string' || !allowedModels.includes(body.model))) {
    return jsonResponse<ErrorResponse>({ error: `model must be one of: ${allowedModels.join(', ')}` }, 400, headers);
  }

  const maxTokens = Math.min(body.max_tokens || 4000, 8000);
  const isStreaming = body.stream !== false;
  const resolvedModel = body.model || 'deepseek-chat';

  const deepseekRequest = {
    ...deepseekRequestFields(resolvedModel),
    messages: body.messages,
    max_tokens: maxTokens,
    temperature: body.temperature ?? 0.7,
    top_p: body.top_p ?? 0.9,
    stream: isStreaming,
    ...(isStreaming ? { stream_options: { include_usage: true } } : {}),
    ...(body.tools?.length ? { tools: body.tools } : {}),
    // Forwarded for compatibility, but currently a no-op: V4 Flash ignores
    // reasoning_effort — reasoning is driven by the `thinking` flag that
    // deepseekRequestFields() emits above.
    ...(resolvedModel === 'deepseek-reasoner' && body.reasoning_effort
      ? { reasoning_effort: body.reasoning_effort }
      : {}),
  };

  let deepseekResponse: Response;
  try {
    deepseekResponse = await fetchWithTimeout('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${requireEnv('DEEPSEEK_API_KEY')}`,
      },
      body: JSON.stringify(deepseekRequest),
      timeout: 120_000,
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      console.error('DeepSeek API timeout');
      return jsonResponse<ErrorResponse>({ error: 'AI provider timed out', code: 'provider-timeout' }, 504, headers);
    }
    console.error('DeepSeek API error:', err);
    return jsonResponse<ErrorResponse>({ error: 'AI provider unavailable', code: 'provider-unavailable' }, 502, headers);
  }

  if (!deepseekResponse.ok) {
    const errorText = await deepseekResponse.text();
    console.error('DeepSeek API error:', deepseekResponse.status, errorText);
    return jsonResponse<ErrorResponse>(
      { error: 'AI provider error', code: 'provider-unavailable' },
      deepseekResponse.status >= 500 ? 502 : deepseekResponse.status,
      headers,
    );
  }

  if (isStreaming) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const reader = deepseekResponse.body!.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    (async () => {
      let buffer = '';
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let clientDisconnected = false;
      let disconnectTime = 0;
      let hasUsageData = false;
      const DRAIN_TIMEOUT_MS = 30_000;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });

          // Forward to client unless disconnected
          if (!clientDisconnected) {
            try {
              await writer.write(encoder.encode(chunk));
            } catch { /* client disconnected */
              clientDisconnected = true;
              disconnectTime = Date.now();
            }
          }

          // Always parse for usage data
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
              const data = line.slice(6);
              if (data.includes('"usage"')) {
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.usage) {
                    totalInputTokens = parsed.usage.prompt_tokens || 0;
                    totalOutputTokens = parsed.usage.completion_tokens || 0;
                    hasUsageData = true;
                  }
                } catch { /* Ignore parse errors */ }
              }
            }
          }

          // Once we have usage and client is gone, no need to keep reading
          if (clientDisconnected && hasUsageData) {
            try { await reader.cancel(); } catch { /* already closed */ }
            break;
          }

          // Timeout: stop draining if usage hasn't arrived within 30s of disconnect
          if (clientDisconnected && (Date.now() - disconnectTime) > DRAIN_TIMEOUT_MS) {
            console.warn('Timeout waiting for usage data after client disconnect');
            try { await reader.cancel(); } catch { /* already closed */ }
            break;
          }
        }
      } catch (err) {
        console.error('Stream processing error:', err);
      } finally {
        if (hasUsageData) {
          await logUsage(customerId, cycleMonth, totalInputTokens, totalOutputTokens, resolvedModel);
        }
        try { await writer.close(); } catch { /* already closed */ }
      }
    })();

    return new Response(readable, {
      status: 200,
      headers: {
        ...headers,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } else {
    const responseData = await deepseekResponse.json() as {
      usage?: { prompt_tokens: number; completion_tokens: number };
      [key: string]: unknown;
    };

    if (responseData.usage) {
      await logUsage(
        customerId,
        cycleMonth,
        responseData.usage.prompt_tokens || 0,
        responseData.usage.completion_tokens || 0,
        resolvedModel,
      );
    }

    return jsonResponse(responseData, 200, headers);
  }
}

async function handleIncludedAiBudget(
  request: Request,
  headers: Record<string, string>,
): Promise<Response> {
  if (Deno.env.get('SELF_HOSTED') === 'true') {
    return jsonResponse<ErrorResponse>({ error: 'Included AI is not available on self-hosted instances', code: 'self-hosted-unavailable' }, 403, headers);
  }

  const validation = await validateJwtAndGetSubscription(request, headers);
  if (validation instanceof Response) return validation;
  const budgetTier = resolveIncludedAiTier(validation);
  if (!budgetTier) {
    return jsonResponse<ErrorResponse>({ error: 'Subscription required', code: 'subscription-required' }, 403, headers);
  }

  let customerId = validation.customerId;
  if (!customerId) {
    customerId = await getOrCreateCustomer(getStripe()!, validation.email!, validation.userId!);
  }

  const budget = await checkMonthlyBudget(customerId, budgetTier);
  return jsonResponse({ usagePercent: budget.usagePercent }, 200, headers);
}

// --- Included (subsidised) image generation: fal-ai/flux/schnell ---

const ALLOWED_IMAGE_SIZES: IncludedImageSize[] = [
  'square_hd', 'square', 'portrait_4_3', 'portrait_16_9', 'landscape_4_3', 'landscape_16_9',
];

/**
 * Build an image prompt from a codex entry via the included DeepSeek text model
 * (server-held DEEPSEEK_API_KEY). This is the included counterpart to
 * generateImagePrompt(), which authenticates with the user's OpenRouter key —
 * the included path has none, so it must use DeepSeek directly. The small text
 * cost is metered against the same monthly budget.
 */
async function generateIncludedImagePrompt(
  entryContext: string,
  customerId: string,
  cycleMonth: string,
  style: PortraitStyle | undefined,
  entryKind: EntryKind,
): Promise<string> {
  const styleFragment = getStylePromptFragment(style);
  const framing = getEntryFraming(entryKind);

  // A literal slot, so only the resolver's `included:` arm is reachable. No
  // deepseekSlotOverride: that exists for cliche-analyzer, where the slot is
  // user-selected and can diverge from the pinned analysis model. Here
  // `deepseekSlotOverride ?? modelId` resolves to 'deepseek-chat' either way, so
  // passing it would be a no-op that invites copying a pattern with no effect.
  //
  // DELIBERATE DEVIATION, do not "fix" it: a ModelProviderConfigError thrown here is
  // NOT mapped to 400. It propagates to the caller's catch, which answers 502
  // `provider-unavailable` — identical to what the old requireEnv throw did. This is
  // the only caller in the repo that does not honour the 400 its JSDoc advertises,
  // and that is right: a missing DEEPSEEK_API_KEY is a server misconfiguration, not
  // a client-chosen provider, and 502 says so. Changing it to 400 changes the status
  // the client infers from when it does not recognise the code.
  const target = resolveUpstream('included:deepseek-chat', { apiKey: null });

  const body: Record<string, unknown> = {
    messages: [
      {
        role: 'system',
        content: `You are an expert at writing prompts for AI image generation.
Given the information below, create ${framing.subject} for the FLUX image model.
Focus on: ${framing.focus}.
Output ONLY the image prompt, nothing else. Keep it under 150 words.
Style should be: ${styleFragment}.
Do NOT include any negative prompts or technical parameters.`,
      },
      {
        role: 'user',
        content: `${framing.userLead}\n\n${entryContext}`,
      },
    ],
    max_tokens: 300,
    temperature: 0.7,
    stream: false,
  };
  // AFTER the body literal — this is what supplies `model` (the wire name, never the
  // internal slot id) and the `thinking` flag. Merged first, the call sends the wrong
  // model id. See UpstreamTarget.bodyExtras.
  Object.assign(body, target.bodyExtras);

  const response = await fetchWithTimeout(target.url, {
    method: 'POST',
    headers: target.headers,
    body: JSON.stringify(body),
    timeout: 120_000,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Image prompt generation failed: ${response.status} - ${errorText.substring(0, 300)}`);
  }

  const data = await response.json() as {
    usage?: { prompt_tokens: number; completion_tokens: number };
    choices?: Array<{ message?: { content?: string } }>;
  };

  const promptText = data.choices?.[0]?.message?.content?.trim() || '';

  // Meter the small text cost only when we got a usable prompt back. An empty
  // completion (rare) makes the caller return 502 with no image — don't charge
  // the user for a degenerate prompt-build; absorb the negligible DeepSeek cost.
  if (data.usage && promptText) {
    await logUsage(customerId, cycleMonth, data.usage.prompt_tokens || 0, data.usage.completion_tokens || 0, 'deepseek-chat');
  } else if (!promptText) {
    console.warn('Included image prompt build returned empty content; skipping DeepSeek metering.');
  }

  return promptText;
}

async function handleIncludedAiImage(
  request: Request,
  headers: Record<string, string>,
): Promise<Response> {
  if (Deno.env.get('SELF_HOSTED') === 'true') {
    return jsonResponse<ErrorResponse>({ error: 'Included AI is not available on self-hosted instances', code: 'self-hosted-unavailable' }, 403, headers);
  }

  const validation = await validateJwtAndGetSubscription(request, headers);
  if (validation instanceof Response) return validation;
  const budgetTier = resolveIncludedAiTier(validation);
  if (!budgetTier) {
    return jsonResponse<ErrorResponse>({ error: 'Subscription required', code: 'subscription-required' }, 403, headers);
  }

  let customerId = validation.customerId;
  if (!customerId) {
    customerId = await getOrCreateCustomer(getStripe()!, validation.email!, validation.userId!);
  }
  const cycleMonth = getCycleMonth();

  // Soft budget check (check-then-act). Image generation widens the TOCTOU
  // window, so the real bound is the atomic increment_ai_usage upsert plus the
  // low per-image cost — worst-case overage is ~one image.
  const budget = await checkMonthlyBudget(customerId, budgetTier);
  if (budget.remainingUsd <= 0) {
    return jsonResponse({ error: 'Monthly AI budget exceeded', code: 'budget-exhausted', budget: { usagePercent: budget.usagePercent } }, 429, headers);
  }

  let body: IncludedImageRequest;
  try {
    body = await request.json();
  } catch {
    return jsonResponse<ErrorResponse>({ error: 'Invalid request body' }, 400, headers);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponse<ErrorResponse>({ error: 'Request body must be a JSON object' }, 400, headers);
  }

  if (body.image_size !== undefined && !ALLOWED_IMAGE_SIZES.includes(body.image_size)) {
    return jsonResponse<ErrorResponse>({ error: `image_size must be one of: ${ALLOWED_IMAGE_SIZES.join(', ')}` }, 400, headers);
  }
  const imageSize: IncludedImageSize = body.image_size || 'portrait_4_3';

  // Resolve the final image prompt: a ready-made prompt (cover path) is used
  // verbatim; otherwise build one from structured fields via DeepSeek (portrait path).
  let imagePrompt: string;
  try {
    if (typeof body.prompt === 'string' && body.prompt.trim().length > 0) {
      if (body.prompt.length > 2000) {
        return jsonResponse<ErrorResponse>({ error: 'prompt exceeds maximum length of 2000' }, 400, headers);
      }
      imagePrompt = body.prompt.trim();
    } else {
      if (typeof body.characterName !== 'string' || !body.characterName.trim()) {
        return jsonResponse<ErrorResponse>({ error: 'Either prompt or characterName is required' }, 400, headers);
      }
      if (body.characterName.length > 200) {
        return jsonResponse<ErrorResponse>({ error: 'characterName exceeds maximum length of 200' }, 400, headers);
      }
      const validStyles: PortraitStyle[] = ['photorealistic', 'digital-illustration', 'anime', 'oil-painting', 'watercolor', 'comic-book'];
      if (body.style && !validStyles.includes(body.style)) {
        return jsonResponse<ErrorResponse>({ error: `style must be one of: ${validStyles.join(', ')}` }, 400, headers);
      }
      const validKinds: EntryKind[] = ['character', 'location', 'object', 'generic'];
      if (body.entryKind !== undefined && !validKinds.includes(body.entryKind)) {
        return jsonResponse<ErrorResponse>({ error: `entryKind must be one of: ${validKinds.join(', ')}` }, 400, headers);
      }
      const descFields: (keyof IncludedImageRequest)[] = ['description', 'physicalAppearance', 'backstory', 'personality'];
      for (const field of descFields) {
        const val = body[field];
        if (val !== undefined && (typeof val !== 'string' || (val as string).length > 2000)) {
          return jsonResponse<ErrorResponse>({ error: `${field} must be a string of at most 2000 characters` }, 400, headers);
        }
      }
      if (body.extraFields !== undefined) {
        if (typeof body.extraFields !== 'object' || body.extraFields === null || Array.isArray(body.extraFields)) {
          return jsonResponse<ErrorResponse>({ error: 'extraFields must be a string map' }, 400, headers);
        }
        const extraKeys = Object.keys(body.extraFields);
        if (extraKeys.length > 30) {
          return jsonResponse<ErrorResponse>({ error: 'extraFields may not exceed 30 keys' }, 400, headers);
        }
        const reservedKeys = new Set(['__proto__', 'constructor', 'prototype']);
        for (const [k, v] of Object.entries(body.extraFields)) {
          if (typeof k !== 'string' || k.length === 0 || k.length > 100 || reservedKeys.has(k)) {
            return jsonResponse<ErrorResponse>({ error: 'extraFields keys must be non-empty strings of at most 100 characters and not a reserved name' }, 400, headers);
          }
          if (typeof v !== 'string' || v.length > 2000) {
            return jsonResponse<ErrorResponse>({ error: 'extraFields values must be strings of at most 2000 characters' }, 400, headers);
          }
        }
      }

      const entryKind: EntryKind = body.entryKind ?? 'character';
      const entryContext = buildEntryContext({
        characterName: body.characterName,
        description: body.description,
        physicalAppearance: body.physicalAppearance,
        backstory: body.backstory,
        personality: body.personality,
        entryKind,
        extraFields: body.extraFields,
      });

      const MAX_CONTEXT_LENGTH = 5000;
      if (entryContext.length > MAX_CONTEXT_LENGTH) {
        return jsonResponse<ErrorResponse>(
          { error: 'Entry description is too long. Please reduce the total entry information to under 5000 characters.' },
          400,
          headers,
        );
      }

      imagePrompt = await generateIncludedImagePrompt(entryContext, customerId, cycleMonth, body.style, entryKind);
      if (!imagePrompt) {
        return jsonResponse<ErrorResponse>({ error: 'Failed to build an image prompt.', code: 'provider-unavailable' }, 502, headers);
      }
    }
  } catch (err) {
    if (isTimeoutError(err)) {
      return jsonResponse<ErrorResponse>({ error: 'AI provider timed out. Please try again.', code: 'provider-timeout' }, 504, headers);
    }
    console.error('Included image prompt build error:', err);
    return jsonResponse<ErrorResponse>({ error: 'Failed to build an image prompt.', code: 'provider-unavailable' }, 502, headers);
  }

  // --- fal-ai/flux/schnell (synchronous via fal.run, no queue/polling) ---
  let falResponse: Response;
  try {
    falResponse = await fetchWithTimeout('https://fal.run/fal-ai/flux/schnell', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Key ${requireEnv('FAL_KEY')}`,
      },
      body: JSON.stringify({
        prompt: imagePrompt,
        image_size: imageSize,
        num_images: 1,
        num_inference_steps: 4,
        enable_safety_checker: true,
        output_format: 'jpeg',
      }),
      timeout: 120_000,
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      console.error('fal.ai image timeout');
      return jsonResponse<ErrorResponse>({ error: 'Image provider timed out. Please try again.', code: 'provider-timeout' }, 504, headers);
    }
    console.error('fal.ai image error:', err);
    return jsonResponse<ErrorResponse>({ error: 'Image provider unavailable', code: 'provider-unavailable' }, 502, headers);
  }

  if (!falResponse.ok) {
    const errorText = await falResponse.text();
    console.error('fal.ai image error:', falResponse.status, errorText.substring(0, 500));
    if (falResponse.status === 429) {
      return jsonResponse<ErrorResponse>({ error: 'Image provider rate limit reached. Please wait a moment and try again.', code: 'rate-limited' }, 429, headers);
    }
    if (falResponse.status === 400 || falResponse.status === 422) {
      return jsonResponse<ErrorResponse>({ error: 'The image prompt was rejected. Try adjusting the description.', code: 'moderation' }, 400, headers);
    }
    return jsonResponse<ErrorResponse>({ error: 'Image provider error', code: 'provider-unavailable' }, falResponse.status >= 500 ? 502 : falResponse.status, headers);
  }

  // fal-ai/flux/schnell returns a FLAT JSON shape — distinct from the OpenRouter
  // chat parser in generateImage(). Read images[0].url directly.
  const falData = await falResponse.json() as {
    images?: Array<{ url?: string; content_type?: string }>;
    has_nsfw_concepts?: boolean[];
    seed?: number;
  };

  // NSFW gate — block BEFORE fetching the CDN URL or metering.
  if (falData.has_nsfw_concepts?.[0] === true) {
    return jsonResponse<ErrorResponse>(
      { error: 'The image was flagged by content moderation. Try adjusting the description to be less suggestive or explicit.', code: 'moderation' },
      400,
      headers,
    );
  }

  const imageUrl = falData.images?.[0]?.url;
  if (!imageUrl || typeof imageUrl !== 'string') {
    console.error('fal.ai returned no image URL:', JSON.stringify(falData).substring(0, 500));
    return jsonResponse<ErrorResponse>({ error: 'No image data returned from the image provider.', code: 'provider-unavailable' }, 502, headers);
  }

  // Meter on fal's successful generation, BEFORE the CDN download. fal bills on
  // generation, not download, so a failed fetch is still correctly metered as one image.
  await logImageUsage(customerId, cycleMonth);

  let imageBase64: string;
  try {
    imageBase64 = await fetchImageAsBase64(imageUrl);
  } catch (err) {
    if (isTimeoutError(err)) {
      return jsonResponse<ErrorResponse>({ error: 'Timed out downloading the generated image. Please try again.', code: 'provider-timeout' }, 504, headers);
    }
    console.error('Failed to fetch generated image:', err);
    return jsonResponse<ErrorResponse>({ error: 'Failed to download the generated image.', code: 'provider-unavailable' }, 502, headers);
  }

  if (!imageBase64) {
    return jsonResponse<ErrorResponse>({ error: 'Failed to generate image.', code: 'provider-unavailable' }, 502, headers);
  }

  return jsonResponse<GeneratePortraitResponse>(
    { imageBase64, generatedPrompt: imagePrompt, success: true },
    200,
    headers,
  );
}

async function handlePremiumCharacterChat(
  request: Request,
  headers: Record<string, string>,
): Promise<Response> {
  const validation = await validateJwtAndGetSubscription(request, headers);
  if (validation instanceof Response) return validation;
  if (!validation.valid || validation.tier !== 'premium') {
    return jsonResponse<ErrorResponse>({ error: 'Premium subscription required', code: 'subscription-required' }, 403, headers);
  }

  return new Response(getCharacterChatModule(), {
    status: 200,
    headers: {
      ...headers,
      'Content-Type': 'application/javascript',
      'Cache-Control': 'no-store',
    },
  });
}

async function handlePremiumBeatRewrite(
  request: Request,
  headers: Record<string, string>,
): Promise<Response> {
  const validation = await validateJwtAndGetSubscription(request, headers);
  if (validation instanceof Response) return validation;
  if (!validation.valid || validation.tier !== 'premium') {
    return jsonResponse<ErrorResponse>({ error: 'Premium subscription required', code: 'subscription-required' }, 403, headers);
  }

  return new Response(getBeatRewriteModule(), {
    status: 200,
    headers: {
      ...headers,
      'Content-Type': 'application/javascript',
      'Cache-Control': 'no-store',
    },
  });
}

// --- Portrait generation ---

function getStylePromptFragment(style?: PortraitStyle): string {
  switch (style) {
    case 'photorealistic':
      return 'photorealistic image with lifelike textures, natural lighting, shallow depth of field, DSLR-style photography';
    case 'digital-illustration':
      return 'realistic digital illustration, finely detailed, cinematic lighting, polished digital art';
    case 'anime':
      return 'anime-style illustration, clean lines, expressive composition, vibrant colors, anime/manga aesthetic';
    case 'oil-painting':
      return 'oil painting, classical artistic style, rich textures, dramatic lighting, visible brushstrokes';
    case 'watercolor':
      return 'watercolor painting, soft washes, delicate details, flowing colors, artistic watercolor style';
    case 'comic-book':
      return 'comic book style illustration, bold outlines, dynamic shading, graphic novel aesthetic';
    default:
      return 'high-quality detailed illustration, professional lighting, painterly, artistic';
  }
}

type EntryContextInput = Pick<
  GeneratePortraitRequest,
  'characterName' | 'description' | 'physicalAppearance' | 'backstory' | 'personality' | 'entryKind' | 'extraFields'
>;

function buildEntryContext(body: EntryContextInput): string {
  const kind: EntryKind = body.entryKind ?? 'character';
  const titleLabel = kind === 'character' ? 'Character Name' : 'Title';
  let context = `${titleLabel}: ${body.characterName}\n`;
  if (body.description) context += `Description: ${body.description}\n`;
  if (body.physicalAppearance) context += `Physical Appearance: ${body.physicalAppearance}\n`;
  if (body.backstory) context += `Backstory: ${body.backstory}\n`;
  if (body.personality) context += `Personality: ${body.personality}\n`;
  if (body.extraFields) {
    for (const [k, v] of Object.entries(body.extraFields)) {
      if (typeof v === 'string' && v.length > 0) context += `${k}: ${v}\n`;
    }
  }
  return context;
}

interface EntryFraming {
  subject: string;
  focus: string;
  userLead: string;
}

function getEntryFraming(entryKind: EntryKind): EntryFraming {
  switch (entryKind) {
    case 'location':
      return {
        subject: 'a detailed landscape or scene illustration of this location',
        focus: 'environment, atmosphere, lighting, composition, mood, colors, sense of place',
        userLead: 'Create a landscape/scene image prompt for this location:',
      };
    case 'object':
      return {
        subject: 'a detailed illustration of this object',
        focus: 'form, materials, surface details, lighting, composition, mood',
        userLead: 'Create an image prompt for this object:',
      };
    case 'generic':
      return {
        subject: 'an evocative illustration that captures the essence of the following subject',
        focus: 'composition, lighting, mood, colors, artistic style',
        userLead: 'Create an image prompt for this subject:',
      };
    case 'character':
    default:
      return {
        subject: 'a detailed character portrait',
        focus: 'face, expression, lighting, mood, colors, artistic style',
        userLead: 'Create a portrait image prompt for this character:',
      };
  }
}

/** The model that writes the image prompt. Pinned — no user slot exists for it. */
const PROMPT_MODEL_SLOT = 'openrouter:deepseek/deepseek-v4-flash';

async function generateImagePrompt(
  apiKey: string,
  entryContext: string,
  model: PortraitModel = 'flux',
  style?: PortraitStyle,
  entryKind: EntryKind = 'character',
): Promise<string> {
  const modelDisplayName = model === 'seedream' ? 'Seedream 4.5' : 'Flux';
  const styleFragment = getStylePromptFragment(style);
  const framing = getEntryFraming(entryKind);

  // Pinned, never user-chosen — so only the resolver's `openrouter` arm is reachable
  // and it cannot throw ModelProviderConfigError (the key is validated non-empty by
  // handleGeneratePortrait before we get here).
  const target = resolveUpstream(PROMPT_MODEL_SLOT, { apiKey });

  const body: Record<string, unknown> = {
    model: parseModelSlot(PROMPT_MODEL_SLOT).modelId,
    messages: [
      {
        role: 'system',
        content: `You are an expert at writing prompts for AI image generation.
Given the information below, create ${framing.subject} for the ${modelDisplayName} image model.
Focus on: ${framing.focus}.
Output ONLY the image prompt, nothing else. Keep it under 150 words.
Style should be: ${styleFragment}.
Do NOT include any negative prompts or technical parameters.`,
      },
      {
        role: 'user',
        content: `${framing.userLead}\n\n${entryContext}`,
      },
    ],
    max_tokens: 300,
    temperature: 0.7,
  };
  // AFTER the body literal — see UpstreamTarget.bodyExtras. A no-op for `openrouter`
  // without provider prefs, but the ordering is the contract, not the current value.
  Object.assign(body, target.bodyExtras);

  const response = await fetchWithTimeout(target.url, {
    method: 'POST',
    headers: target.headers,
    timeout: 120_000,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    // This label used to read `DeepSeek API error:` — on a call to OPENROUTER. The name
    // was wrong AND load-bearing: the catch below matched that exact prefix, so simply
    // correcting the wording dropped this failure into the generic 500 arm.
    throw classifyOpenRouterFailure(response.status, await response.text(), PROMPT_LABELS);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content || '';
}

function getPortraitModelId(model: PortraitModel): string {
  switch (model) {
    case 'seedream':
      return 'bytedance-seed/seedream-4.5';
    case 'flux':
    default:
      return 'black-forest-labs/flux.2-flex';
  }
}

/** Convert an image URL to base64 safely (no stack overflow) */
async function fetchImageAsBase64(url: string): Promise<string> {
  const imgResponse = await fetchWithTimeout(url, { timeout: 120_000 });
  const imgBuffer = await imgResponse.arrayBuffer();
  return encodeBase64(new Uint8Array(imgBuffer));
}

async function generateImage(apiKey: string, prompt: string, model: PortraitModel = 'flux'): Promise<string> {
  const modelId = getPortraitModelId(model);
  const modelDisplayName = model === 'seedream' ? 'Seedream 4.5' : 'Flux';

  console.log(`Calling ${modelDisplayName} API (${modelId}) with prompt length:`, prompt.length);

  // The resolver is used for URL + headers ONLY. This is an *image* call
  // (`modalities: ['image']`) that happens to go over OpenRouter's chat/completions
  // endpoint — same URL, same four headers — so the whole four-shape response parser
  // below stays here rather than moving into a shared caller.
  //
  // The slot is minted from getPortraitModelId, never from user input (the request
  // carries 'flux' | 'seedream', validated against an allowlist), so only the
  // `openrouter` arm is reachable and it cannot throw ModelProviderConfigError.
  const target = resolveUpstream(`openrouter:${modelId}`, { apiKey });

  const body: Record<string, unknown> = {
    model: modelId,
    modalities: ['image'],
    messages: [{ role: 'user', content: prompt }],
  };
  // AFTER the body literal — see UpstreamTarget.bodyExtras.
  Object.assign(body, target.bodyExtras);

  const response = await fetchWithTimeout(target.url, {
    method: 'POST',
    headers: target.headers,
    timeout: 120_000,
    body: JSON.stringify(body),
  });

  console.log(`${modelDisplayName} API response status:`, response.status);

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`${modelDisplayName} API error response:`, errorBody);
    throw classifyOpenRouterFailure(response.status, errorBody);
  }

  // deno-lint-ignore no-explicit-any
  const data: any = await response.json();
  console.log(`${modelDisplayName} API response structure:`, JSON.stringify(data, null, 2).substring(0, 1000));

  // OpenRouter occasionally returns HTTP 200 with an error body when an upstream
  // provider (BFL, ByteDance) fails or content moderation triggers post-dispatch —
  // and reports a content filter via finish_reason rather than an error at all.
  const payloadError = classifyOpenRouterPayloadError(data);
  if (payloadError) throw payloadError;

  // Kept for the diagnostic summary below; the filter check itself is the classifier's.
  const finishReason: string = data?.choices?.[0]?.finish_reason
    || data?.choices?.[0]?.native_finish_reason
    || '';

  // Format 1: OpenAI-style images/generations response
  if (data.data && Array.isArray(data.data)) {
    const imageData = data.data[0];
    if (imageData?.b64_json) return imageData.b64_json;
    if (imageData?.url?.startsWith('data:')) return imageData.url.split(',')[1] || '';
  }

  // Format 2: Images array in message
  const message = data.choices?.[0]?.message;
  if (message?.images && Array.isArray(message.images)) {
    for (const img of message.images) {
      if (img.type === 'image_url' && img.image_url?.url) {
        const url = img.image_url.url;
        if (url.startsWith('data:')) return url.split(',')[1] || '';
        return await fetchImageAsBase64(url);
      }
      // Permissive: some providers omit `type` or use `image_url` as a string
      const altUrl = typeof img.image_url === 'string' ? img.image_url : img.url;
      if (typeof altUrl === 'string' && altUrl.length > 0) {
        if (altUrl.startsWith('data:')) return altUrl.split(',')[1] || '';
        if (altUrl.startsWith('http')) return await fetchImageAsBase64(altUrl);
      }
      if (typeof img.b64_json === 'string') return img.b64_json;
    }
  }

  // Format 3: Chat completion with content array
  const content = message?.content;

  if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === 'image_url' && part.image_url?.url) {
        const url = part.image_url.url;
        if (url.startsWith('data:')) return url.split(',')[1] || '';
        return await fetchImageAsBase64(url);
      }
      if (part.type === 'image' && part.data) return part.data;
    }
  }

  // Format 4: String content that is a data URL
  if (typeof content === 'string') {
    if (content.startsWith('data:image')) return content.split(',')[1] || '';
    if (content.length > 1000 && /^[A-Za-z0-9+/=]+$/.test(content.substring(0, 100))) return content;
  }

  // Diagnostic summary for the toast: brief, no binary payload.
  const summary = {
    keys: Object.keys(data || {}),
    choices: Array.isArray(data?.choices) ? data.choices.length : null,
    messageKeys: data?.choices?.[0]?.message ? Object.keys(data.choices[0].message) : null,
    contentType: Array.isArray(content) ? 'array' : typeof content,
    imagesLen: Array.isArray(message?.images) ? message.images.length : 'missing',
    finishReason: finishReason || null,
  };
  console.error('Could not find image in response. Full response:', JSON.stringify(data).substring(0, 2000));
  throw new UpstreamError(
    'provider-message',
    `No image data returned from ${modelDisplayName} model. Shape: ${JSON.stringify(summary)}`,
    502,
  );
}

async function handleGeneratePortrait(
  request: Request,
  headers: Record<string, string>,
): Promise<Response> {
  const validation = await validateJwtAndGetSubscription(request, headers);
  if (validation instanceof Response) return validation;
  if (!validation.valid || validation.tier !== 'premium') {
    return jsonResponse<ErrorResponse>({ error: 'Premium subscription required', code: 'subscription-required' }, 403, headers);
  }

  let body: GeneratePortraitRequest;
  try {
    body = await request.json();
  } catch {
    return jsonResponse<ErrorResponse>({ error: 'Invalid request body' }, 400, headers);
  }

  try {
    if (!body.openRouterApiKey || typeof body.openRouterApiKey !== 'string') {
      return jsonResponse<ErrorResponse>(
        { error: 'OpenRouter API key is required for portrait generation.' },
        400,
        headers,
      );
    }

    if (!body.characterName || typeof body.characterName !== 'string') {
      return jsonResponse<ErrorResponse>(
        { error: 'Character name is required.' },
        400,
        headers,
      );
    }
    if (body.characterName.length > 200) {
      return jsonResponse<ErrorResponse>({ error: 'characterName exceeds maximum length of 200' }, 400, headers);
    }

    // Validate enums
    const validModels: PortraitModel[] = ['flux', 'seedream'];
    if (body.model && !validModels.includes(body.model)) {
      return jsonResponse<ErrorResponse>({ error: 'model must be "flux" or "seedream"' }, 400, headers);
    }
    const validStyles: PortraitStyle[] = ['photorealistic', 'digital-illustration', 'anime', 'oil-painting', 'watercolor', 'comic-book'];
    if (body.style && !validStyles.includes(body.style)) {
      return jsonResponse<ErrorResponse>({ error: `style must be one of: ${validStyles.join(', ')}` }, 400, headers);
    }
    const validKinds: EntryKind[] = ['character', 'location', 'object', 'generic'];
    if (body.entryKind !== undefined && !validKinds.includes(body.entryKind)) {
      return jsonResponse<ErrorResponse>({ error: `entryKind must be one of: ${validKinds.join(', ')}` }, 400, headers);
    }
    const entryKind: EntryKind = body.entryKind ?? 'character';

    // Validate description field lengths
    const descFields: (keyof GeneratePortraitRequest)[] = ['description', 'physicalAppearance', 'backstory', 'personality'];
    for (const field of descFields) {
      const val = body[field];
      if (val !== undefined && (typeof val !== 'string' || (val as string).length > 2000)) {
        return jsonResponse<ErrorResponse>({ error: `${field} must be a string of at most 2000 characters` }, 400, headers);
      }
    }

    // Validate extraFields shape and per-entry size limits
    if (body.extraFields !== undefined) {
      if (typeof body.extraFields !== 'object' || body.extraFields === null || Array.isArray(body.extraFields)) {
        return jsonResponse<ErrorResponse>({ error: 'extraFields must be a string map' }, 400, headers);
      }
      const extraKeys = Object.keys(body.extraFields);
      if (extraKeys.length > 30) {
        return jsonResponse<ErrorResponse>({ error: 'extraFields may not exceed 30 keys' }, 400, headers);
      }
      const reservedKeys = new Set(['__proto__', 'constructor', 'prototype']);
      for (const [k, v] of Object.entries(body.extraFields)) {
        if (typeof k !== 'string' || k.length === 0 || k.length > 100 || reservedKeys.has(k)) {
          return jsonResponse<ErrorResponse>({ error: 'extraFields keys must be non-empty strings of at most 100 characters and not a reserved name' }, 400, headers);
        }
        if (typeof v !== 'string' || v.length > 2000) {
          return jsonResponse<ErrorResponse>({ error: 'extraFields values must be strings of at most 2000 characters' }, 400, headers);
        }
      }
    }

    const model: PortraitModel = body.model || 'flux';
    const style: PortraitStyle | undefined = body.style;
    const modelDisplayName = model === 'seedream' ? 'Seedream 4.5' : 'Flux';

    const entryContext = buildEntryContext(body);

    const MAX_CONTEXT_LENGTH = 5000;
    if (entryContext.length > MAX_CONTEXT_LENGTH) {
      return jsonResponse<ErrorResponse>(
        { error: 'Entry description is too long. Please reduce the total entry information to under 5000 characters.' },
        400,
        headers,
      );
    }

    console.log(`Generating image prompt for: ${body.characterName} (kind: ${entryKind}, model: ${modelDisplayName}, style: ${style || 'default'})`);
    const imagePrompt = await generateImagePrompt(body.openRouterApiKey, entryContext, model, style, entryKind);
    console.log('Generated prompt:', imagePrompt.substring(0, 100) + '...');

    console.log(`Generating image with ${modelDisplayName}...`);
    const imageBase64 = await generateImage(body.openRouterApiKey, imagePrompt, model);

    if (!imageBase64) {
      return jsonResponse<ErrorResponse>(
        { error: 'Failed to generate portrait image.' },
        500,
        headers,
      );
    }

    console.log('Portrait generated successfully, size:', Math.round(imageBase64.length * 0.75 / 1024), 'KB');

    return jsonResponse<GeneratePortraitResponse>(
      { imageBase64, generatedPrompt: imagePrompt, success: true },
      200,
      headers,
    );
  } catch (error) {
    console.error('Portrait generation error:', error);

    // FIRST, and it must stay first: fetchWithTimeout aborts with a raw DOMException
    // (see _shared/timeout.ts), which is never wrapped in an UpstreamError.
    if (isTimeoutError(error)) {
      return jsonResponse<ErrorResponse>(
        { error: 'Image provider timed out. Please try again.', code: 'provider-timeout' },
        504,
        headers,
      );
    }

    // Already classified, where the status and parsed body were still in scope. This
    // replaces a ladder of message.startsWith(...) tests over our own thrown sentences
    // — one of which named the wrong provider outright (`DeepSeek API error:` for an
    // OpenRouter call), and could not be corrected without silently changing which
    // status the failure answered with.
    if (error instanceof UpstreamError) {
      return upstreamErrorResponse(error, headers);
    }

    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse<ErrorResponse>(
      { error: `Portrait error: ${message.slice(0, 500)}`, code: 'provider-unavailable' },
      500,
      headers,
    );
  }
}

// --- Premium module code (inline) ---

function getCharacterChatModule(): string {
  return `
// Character Chat Premium Module
// This code is only served to verified premium subscribers

export class CharacterChatService {
  constructor(aiService) {
    this.aiService = aiService;
  }

  buildSystemPrompt(character, storyContext, knowledgeCutoff) {
    const characterInfo = this.formatCharacterInfo(character);
    const contextInfo = knowledgeCutoff
      ? this.buildContextWithCutoff(storyContext, knowledgeCutoff)
      : this.buildFullContext(storyContext);

    return \`You are roleplaying as \${character.name} from a story. Stay completely in character.

CHARACTER PROFILE:
\${characterInfo}

STORY CONTEXT (what your character knows):
\${contextInfo}

IMPORTANT RULES:
- Respond as \${character.name} would, based on their personality, background, and knowledge
- Only reference events and information your character would know about
- Stay consistent with the character's voice, mannerisms, and speech patterns
- If asked about something your character wouldn't know, respond as the character would to unknown information
- Never break character or acknowledge you are an AI
- Keep responses conversational and natural\`;
  }

  formatCharacterInfo(character) {
    let info = \`Name: \${character.name}\\n\`;
    if (character.description) info += \`Description: \${character.description}\\n\`;
    if (character.personality) info += \`Personality: \${character.personality}\\n\`;
    if (character.background) info += \`Background: \${character.background}\\n\`;
    if (character.goals) info += \`Goals: \${character.goals}\\n\`;
    if (character.relationships) info += \`Relationships: \${character.relationships}\\n\`;
    if (character.notes) info += \`Additional Notes: \${character.notes}\\n\`;
    return info;
  }

  buildFullContext(storyContext) {
    if (storyContext.summary) return storyContext.summary;
    if (!storyContext.chapters || storyContext.chapters.length === 0) return '';
    return storyContext.chapters
      .sort((a, b) => a.order - b.order)
      .map(ch => {
        const sceneSummaries = ch.scenes
          ?.sort((a, b) => a.order - b.order)
          .filter(s => s.summary)
          .map(s => \`  - \${s.title}: \${s.summary}\`)
          .join('\\n') || '';
        return \`Chapter: \${ch.title}\\n\${sceneSummaries || '  (no scene summaries available)'}\`;
      })
      .join('\\n\\n');
  }

  buildContextWithCutoff(storyContext, cutoff) {
    if (!cutoff || !storyContext.chapters) return this.buildFullContext(storyContext);
    const relevantChapters = storyContext.chapters
      .filter(ch => ch.order <= cutoff.chapterOrder)
      .sort((a, b) => a.order - b.order)
      .map(ch => {
        let scenes = ch.scenes || [];
        if (cutoff.sceneOrder && ch.order === cutoff.chapterOrder) {
          scenes = scenes.filter(s => s.order <= cutoff.sceneOrder);
        }
        const sceneSummaries = scenes
          .sort((a, b) => a.order - b.order)
          .filter(s => s.summary)
          .map(s => \`  - \${s.title}: \${s.summary}\`)
          .join('\\n');
        return \`Chapter: \${ch.title}\\n\${sceneSummaries || '  (no scene summaries available)'}\`;
      })
      .join('\\n\\n');
    return relevantChapters;
  }

  async chat(character, message, conversationHistory, storyContext, knowledgeCutoff, modelId) {
    const systemPrompt = this.buildSystemPrompt(character, storyContext, knowledgeCutoff);
    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory,
      { role: 'user', content: message }
    ];
    const response = await this.aiService.generateChatResponse(messages, modelId);
    return response;
  }

  getSuggestedStarters(character, language = 'en') {
    const templates = {
      en: {
        intro: \`Tell me about yourself, \${character.name}.\`,
        mind: "What's on your mind lately?",
        situation: "How do you feel about the current situation?",
        goals: "What are you hoping to achieve?",
        relationships: "Tell me about the people in your life.",
        background: "What was your life like before all this?"
      },
      de: {
        intro: \`Erzähl mir von dir, \${character.name}.\`,
        mind: "Was beschäftigt dich in letzter Zeit?",
        situation: "Wie fühlst du dich bei der aktuellen Situation?",
        goals: "Was erhoffst du dir zu erreichen?",
        relationships: "Erzähl mir von den Menschen in deinem Leben.",
        background: "Wie war dein Leben vor all dem?"
      },
      fr: {
        intro: \`Parle-moi de toi, \${character.name}.\`,
        mind: "Qu'est-ce qui te préoccupe ces derniers temps?",
        situation: "Comment te sens-tu par rapport à la situation actuelle?",
        goals: "Qu'espères-tu accomplir?",
        relationships: "Parle-moi des gens dans ta vie.",
        background: "Comment était ta vie avant tout ça?"
      },
      es: {
        intro: \`Cuéntame sobre ti, \${character.name}.\`,
        mind: "¿Qué tienes en mente últimamente?",
        situation: "¿Cómo te sientes sobre la situación actual?",
        goals: "¿Qué esperas lograr?",
        relationships: "Cuéntame sobre las personas en tu vida.",
        background: "¿Cómo era tu vida antes de todo esto?"
      }
    };
    const t = templates[language] || templates.en;
    const starters = [t.intro, t.mind, t.situation];
    if (character.goals) starters.push(t.goals);
    if (character.relationships) starters.push(t.relationships);
    if (character.background) starters.push(t.background);
    return starters;
  }
}

export default CharacterChatService;
`;
}

function getBeatRewriteModule(): string {
  return `
// Beat Rewrite Premium Module
// This code is only served to verified premium subscribers

export class BeatRewriteService {
  constructor(aiService) {
    this.aiService = aiService;
  }

  buildRewritePrompt(originalText, instruction, context = {}) {
    let prompt = '';
    if (context.storyOutline) prompt += '<story-context>\\n' + context.storyOutline + '\\n</story-context>\\n\\n';
    if (context.sceneContext) prompt += '<scene-context>\\n' + context.sceneContext + '\\n</scene-context>\\n\\n';
    if (context.codexEntries) prompt += '<world-info>\\n' + context.codexEntries + '\\n</world-info>\\n\\n';
    prompt += '<original-text>\\n' + originalText + '\\n</original-text>\\n\\n';
    prompt += '<rewrite-instruction>\\n' + instruction + '\\n</rewrite-instruction>\\n\\n';
    prompt += 'Please rewrite the original text according to the instruction. ';
    prompt += 'Maintain consistency with any provided story context and world information. ';
    prompt += 'Preserve the narrative voice and style of the original. ';
    prompt += 'Return ONLY the rewritten text, nothing else - no explanations, no markdown formatting, just the rewritten prose.';
    return prompt;
  }

  async rewrite(originalText, instruction, context, modelId) {
    const prompt = this.buildRewritePrompt(originalText, instruction, context);
    const messages = [{ role: 'user', content: prompt }];
    return await this.aiService.generateChatResponse(messages, modelId);
  }

  getSuggestedPrompts(text, language = 'en') {
    const prompts = {
      en: ['Make it more dramatic','Write it more emotionally','Shorten it','Expand with more details','Make it more formal','Make it more casual','Improve the pacing','Add more sensory details','Make the dialogue more natural','Increase the tension'],
      de: ['Dramatischer gestalten','Emotionaler schreiben','Kürzer fassen','Mit mehr Details erweitern','Formeller formulieren','Lockerer formulieren','Tempo verbessern','Mehr sensorische Details hinzufügen','Dialog natürlicher gestalten','Spannung erhöhen'],
      fr: ['Rendre plus dramatique','Écrire plus émotionnellement','Raccourcir','Développer avec plus de détails','Rendre plus formel','Rendre plus décontracté','Améliorer le rythme','Ajouter plus de détails sensoriels','Rendre le dialogue plus naturel','Augmenter la tension'],
      es: ['Hacerlo más dramático','Escribirlo más emocionalmente','Acortarlo','Expandir con más detalles','Hacerlo más formal','Hacerlo más casual','Mejorar el ritmo','Añadir más detalles sensoriales','Hacer el diálogo más natural','Aumentar la tensión']
    };
    return prompts[language] || prompts.en;
  }

  analyzeForSuggestions(text) {
    const suggestions = [];
    const wordCount = text.split(/\\s+/).length;
    if (wordCount > 200) suggestions.push('Consider shortening for better pacing');
    else if (wordCount < 50) suggestions.push('Could expand with more details');
    if (text.includes('"') || text.includes("'")) suggestions.push('Polish the dialogue');
    if (/\\b(ran|jumped|fought|grabbed|threw)\\b/i.test(text)) suggestions.push('Enhance the action sequence');
    return suggestions;
  }
}

export default BeatRewriteService;
`;
}

// --- Main entry point ---

Deno.serve(async (request: Request) => {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin') || '';
  const headers = corsHeaders(origin);

  const preflight = handleCorsPreflightIfNeeded(request, headers);
  if (preflight) return preflight;

  const path = url.pathname.replace(/^\/premium/, '') || '/';

  // Per-route rate limiting
  if (path === '/ai/chat') {
    const rl = rateLimitResponse(request, headers, 30, 60_000, 'premium:ai-chat');
    if (rl) return rl;
  } else if (path === '/ai/image') {
    const rl = rateLimitResponse(request, headers, 10, 60_000, 'premium:ai-image');
    if (rl) return rl;
  } else if (path === '/generate-portrait') {
    const rl = rateLimitResponse(request, headers, 10, 60_000, 'premium:portrait');
    if (rl) return rl;
  }

  try {
    switch (path) {
      case '/character-chat':
        if (request.method !== 'GET') {
          return jsonResponse<ErrorResponse>({ error: 'Method not allowed' }, 405, headers);
        }
        return handlePremiumCharacterChat(request, headers);

      case '/beat-rewrite':
        if (request.method !== 'GET') {
          return jsonResponse<ErrorResponse>({ error: 'Method not allowed' }, 405, headers);
        }
        return handlePremiumBeatRewrite(request, headers);

      case '/generate-portrait':
        if (request.method !== 'POST') {
          return jsonResponse<ErrorResponse>({ error: 'Method not allowed' }, 405, headers);
        }
        return handleGeneratePortrait(request, headers);

      case '/ai/chat':
        if (request.method !== 'POST') {
          return jsonResponse<ErrorResponse>({ error: 'Method not allowed' }, 405, headers);
        }
        return handleIncludedAiChat(request, headers);

      case '/ai/image':
        if (request.method !== 'POST') {
          return jsonResponse<ErrorResponse>({ error: 'Method not allowed' }, 405, headers);
        }
        return handleIncludedAiImage(request, headers);

      case '/ai/budget':
        if (request.method !== 'GET') {
          return jsonResponse<ErrorResponse>({ error: 'Method not allowed' }, 405, headers);
        }
        return handleIncludedAiBudget(request, headers);

      default:
        return jsonResponse<ErrorResponse>({ error: 'Not found' }, 404, headers);
    }
  } catch (error) {
    console.error('Premium function error:', error);
    return jsonResponse<ErrorResponse>(
      { error: 'Internal server error' },
      500,
      headers,
    );
  }
});
