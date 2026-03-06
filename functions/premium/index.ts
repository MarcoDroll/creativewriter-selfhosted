import { encodeBase64 } from 'https://deno.land/std@0.224.0/encoding/base64.ts';
import { corsHeaders, handleCorsPreflightIfNeeded, jsonResponse } from '../_shared/cors.ts';
import { getAdminClient } from '../_shared/supabase-admin.ts';
import {
  requireEnv,
  validateJwtAndGetSubscription,
} from '../_shared/stripe-helpers.ts';
import type {
  BudgetInfo,
  DailyUsageData,
  ErrorResponse,
  GeneratePortraitRequest,
  GeneratePortraitResponse,
  PortraitModel,
  PortraitStyle,
} from '../_shared/types.ts';

// --- AI usage tracking ---

const DEEPSEEK_PRICING = {
  inputPerMillionTokens: 0.28,
  outputPerMillionTokens: 0.42,
  dailyBudgetUsd: 0.10,
};

function getDateKey(): string {
  return new Date().toISOString().split('T')[0];
}

function getNextResetTime(): string {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return tomorrow.toISOString();
}

async function getDailyUsage(customerId: string): Promise<DailyUsageData> {
  const supabase = getAdminClient();
  const { data, error } = await supabase
    .from('ai_usage_daily')
    .select('total_cost_usd, request_count, input_tokens, output_tokens, last_updated')
    .eq('stripe_customer_id', customerId)
    .eq('usage_date', getDateKey())
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('DB error reading daily usage:', error.message);
  }

  if (!data) {
    return { totalCostUsd: 0, requestCount: 0, inputTokens: 0, outputTokens: 0, lastUpdated: 0 };
  }

  return {
    totalCostUsd: parseFloat(data.total_cost_usd),
    requestCount: data.request_count,
    inputTokens: data.input_tokens,
    outputTokens: data.output_tokens,
    lastUpdated: new Date(data.last_updated).getTime(),
  };
}

async function checkDailyBudget(customerId: string): Promise<BudgetInfo> {
  const usage = await getDailyUsage(customerId);
  const remaining = Math.max(0, DEEPSEEK_PRICING.dailyBudgetUsd - usage.totalCostUsd);
  return {
    usedUsd: usage.totalCostUsd,
    limitUsd: DEEPSEEK_PRICING.dailyBudgetUsd,
    remainingUsd: remaining,
    resetsAt: getNextResetTime(),
  };
}

/** Atomic usage increment via Postgres RPC — avoids read-modify-write race conditions */
async function logUsage(customerId: string, inputTokens: number, outputTokens: number): Promise<void> {
  const supabase = getAdminClient();
  const inputCost = (inputTokens / 1_000_000) * DEEPSEEK_PRICING.inputPerMillionTokens;
  const outputCost = (outputTokens / 1_000_000) * DEEPSEEK_PRICING.outputPerMillionTokens;

  const { error } = await supabase.rpc('increment_ai_usage', {
    p_customer_id: customerId,
    p_date: getDateKey(),
    p_input_tokens: inputTokens,
    p_output_tokens: outputTokens,
    p_cost: inputCost + outputCost,
  });

  if (error) {
    console.error('Failed to log AI usage:', error.message);
  }
}

// --- Premium handlers ---

async function handleIncludedAiChat(
  request: Request,
  headers: Record<string, string>,
): Promise<Response> {
  if (Deno.env.get('SELF_HOSTED') === 'true') {
    return jsonResponse<ErrorResponse>({ error: 'Included AI is not available on self-hosted instances' }, 403, headers);
  }

  const validation = await validateJwtAndGetSubscription(request, headers);
  if (validation instanceof Response) return validation;
  if (!validation.valid || validation.tier !== 'premium') {
    return jsonResponse<ErrorResponse>({ error: 'Premium subscription required' }, 403, headers);
  }

  const customerId = validation.customerId!;

  const budget = await checkDailyBudget(customerId);
  if (budget.remainingUsd <= 0) {
    return jsonResponse({ error: 'Daily AI budget exceeded', budget }, 429, headers);
  }

  let body: {
    messages?: { role: string; content: string }[];
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    stream?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return jsonResponse<ErrorResponse>({ error: 'Invalid request body' }, 400, headers);
  }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return jsonResponse<ErrorResponse>({ error: 'messages array is required' }, 400, headers);
  }

  const maxTokens = Math.min(body.max_tokens || 4000, 8000);
  const isStreaming = body.stream !== false;

  const deepseekRequest = {
    model: 'deepseek-chat',
    messages: body.messages,
    max_tokens: maxTokens,
    temperature: body.temperature ?? 0.7,
    top_p: body.top_p ?? 0.9,
    stream: isStreaming,
    ...(isStreaming ? { stream_options: { include_usage: true } } : {}),
  };

  const deepseekResponse = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${requireEnv('DEEPSEEK_API_KEY')}`,
    },
    body: JSON.stringify(deepseekRequest),
  });

  if (!deepseekResponse.ok) {
    const errorText = await deepseekResponse.text();
    console.error('DeepSeek API error:', deepseekResponse.status, errorText);
    return jsonResponse<ErrorResponse>(
      { error: 'AI provider error' },
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

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          try {
            await writer.write(encoder.encode(chunk));
          } catch {
            await reader.cancel();
            break;
          }

          // Parse for usage data — only attempt JSON.parse when usage is present
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
                  }
                } catch { /* Ignore parse errors */ }
              }
            }
          }
        }
      } catch (err) {
        console.error('Stream processing error:', err);
      } finally {
        if (totalInputTokens > 0 || totalOutputTokens > 0) {
          await logUsage(customerId, totalInputTokens, totalOutputTokens);
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
        responseData.usage.prompt_tokens || 0,
        responseData.usage.completion_tokens || 0,
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
    return jsonResponse<ErrorResponse>({ error: 'Included AI is not available on self-hosted instances' }, 403, headers);
  }

  const validation = await validateJwtAndGetSubscription(request, headers);
  if (validation instanceof Response) return validation;
  if (!validation.valid || validation.tier !== 'premium') {
    return jsonResponse<ErrorResponse>({ error: 'Premium subscription required' }, 403, headers);
  }

  const budget = await checkDailyBudget(validation.customerId!);
  return jsonResponse(budget, 200, headers);
}

async function handlePremiumCharacterChat(
  request: Request,
  headers: Record<string, string>,
): Promise<Response> {
  const validation = await validateJwtAndGetSubscription(request, headers);
  if (validation instanceof Response) return validation;
  if (!validation.valid || validation.tier !== 'premium') {
    return jsonResponse<ErrorResponse>({ error: 'Premium subscription required' }, 403, headers);
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
    return jsonResponse<ErrorResponse>({ error: 'Premium subscription required' }, 403, headers);
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
      return 'photorealistic portrait photograph, lifelike skin textures, natural lighting, shallow depth of field, DSLR photography';
    case 'digital-illustration':
      return 'realistic digital illustration, detailed face, cinematic lighting, polished digital art, subtle stylization';
    case 'anime':
      return 'anime-style portrait, expressive eyes, clean lines, vibrant colors, anime/manga aesthetic';
    case 'oil-painting':
      return 'oil painting portrait, classical artistic style, rich textures, dramatic lighting, visible brushstrokes';
    case 'watercolor':
      return 'watercolor portrait, soft washes, delicate details, flowing colors, artistic watercolor style';
    case 'comic-book':
      return 'comic book style portrait, bold outlines, dynamic shading, graphic novel aesthetic';
    default:
      return 'high-quality portrait, detailed face, professional lighting, artistic, painterly';
  }
}

function buildCharacterContext(body: GeneratePortraitRequest): string {
  let context = `Character Name: ${body.characterName}\n`;
  if (body.description) context += `Description: ${body.description}\n`;
  if (body.physicalAppearance) context += `Physical Appearance: ${body.physicalAppearance}\n`;
  if (body.backstory) context += `Backstory: ${body.backstory}\n`;
  if (body.personality) context += `Personality: ${body.personality}\n`;
  return context;
}

async function generateImagePrompt(apiKey: string, characterContext: string, model: PortraitModel = 'flux', style?: PortraitStyle): Promise<string> {
  const modelDisplayName = model === 'seedream' ? 'Seedream 4.5' : 'Flux';
  const styleFragment = getStylePromptFragment(style);

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://creativewriter.app',
      'X-Title': 'Creative Writer',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v3.2',
      messages: [
        {
          role: 'system',
          content: `You are an expert at writing prompts for AI image generation.
Given character information, create a detailed portrait prompt for the ${modelDisplayName} image model.
Focus on: face, expression, lighting, style, mood, colors, artistic style.
Output ONLY the image prompt, nothing else. Keep it under 150 words.
Style should be: ${styleFragment}.
Do NOT include any negative prompts or technical parameters.`,
        },
        {
          role: 'user',
          content: `Create a portrait image prompt for this character:\n\n${characterContext}`,
        },
      ],
      max_tokens: 300,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`DeepSeek API error: ${response.status} - ${errorBody}`);
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
  const imgResponse = await fetch(url);
  const imgBuffer = await imgResponse.arrayBuffer();
  return encodeBase64(new Uint8Array(imgBuffer));
}

async function generateImage(apiKey: string, prompt: string, model: PortraitModel = 'flux'): Promise<string> {
  const modelId = getPortraitModelId(model);
  const modelDisplayName = model === 'seedream' ? 'Seedream 4.5' : 'Flux';

  console.log(`Calling ${modelDisplayName} API (${modelId}) with prompt length:`, prompt.length);

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://creativewriter.app',
      'X-Title': 'Creative Writer',
    },
    body: JSON.stringify({
      model: modelId,
      modalities: ['image'],
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  console.log(`${modelDisplayName} API response status:`, response.status);

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`${modelDisplayName} API error response:`, errorBody);

    try {
      const errorJson = JSON.parse(errorBody);

      if (errorJson?.error?.metadata?.raw) {
        const rawMetadata = JSON.parse(errorJson.error.metadata.raw);
        if (rawMetadata?.status === 'Request Moderated') {
          throw new Error('The portrait prompt was flagged by content moderation. Try adjusting the character description to be less suggestive or explicit.');
        }
      }

      if (errorJson?.error?.code === 429) {
        throw new Error('API rate limit exceeded. Please wait a moment and try again.');
      }

      if (errorJson?.error?.message) {
        throw new Error(`Portrait generation failed: ${errorJson.error.message}`);
      }
    } catch (parseError) {
      if (parseError instanceof Error && !parseError.message.includes('JSON')) {
        throw parseError;
      }
    }

    throw new Error(`Image generation failed (${response.status}): ${errorBody.substring(0, 500)}`);
  }

  // deno-lint-ignore no-explicit-any
  const data: any = await response.json();
  console.log(`${modelDisplayName} API response structure:`, JSON.stringify(data, null, 2).substring(0, 1000));

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

  console.error('Could not find image in response. Full response:', JSON.stringify(data));
  throw new Error(`No image data returned from ${modelDisplayName} model. Check logs for response structure.`);
}

async function handleGeneratePortrait(
  request: Request,
  headers: Record<string, string>,
): Promise<Response> {
  const validation = await validateJwtAndGetSubscription(request, headers);
  if (validation instanceof Response) return validation;
  if (!validation.valid || validation.tier !== 'premium') {
    return jsonResponse<ErrorResponse>({ error: 'Premium subscription required' }, 403, headers);
  }

  try {
    const body: GeneratePortraitRequest = await request.json();

    if (!body.openRouterApiKey) {
      return jsonResponse<ErrorResponse>(
        { error: 'OpenRouter API key is required for portrait generation.' },
        400,
        headers,
      );
    }

    if (!body.characterName) {
      return jsonResponse<ErrorResponse>(
        { error: 'Character name is required.' },
        400,
        headers,
      );
    }

    const model: PortraitModel = body.model || 'flux';
    const style: PortraitStyle | undefined = body.style;
    const modelDisplayName = model === 'seedream' ? 'Seedream 4.5' : 'Flux';

    const characterContext = buildCharacterContext(body);

    const MAX_CONTEXT_LENGTH = 5000;
    if (characterContext.length > MAX_CONTEXT_LENGTH) {
      return jsonResponse<ErrorResponse>(
        { error: 'Character description is too long. Please reduce the total character information to under 5000 characters.' },
        400,
        headers,
      );
    }

    console.log(`Generating image prompt for: ${body.characterName} (model: ${modelDisplayName}, style: ${style || 'default'})`);
    const imagePrompt = await generateImagePrompt(body.openRouterApiKey, characterContext, model, style);
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
    return jsonResponse<ErrorResponse>(
      { error: error instanceof Error ? error.message : 'Portrait generation failed' },
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
