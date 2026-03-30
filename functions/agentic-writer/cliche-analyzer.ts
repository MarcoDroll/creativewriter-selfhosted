/**
 * Cliché Analyzer — self-contained module for building per-story cliché indexes.
 *
 * Exports:
 *   analyzeCliches()           — full analysis pipeline (text match + LLM)
 *   fetchStoryClicheIndex()    — read index for pipeline use
 *   formatClicheIndexForPrompt() — format entries for prompt injection
 */

import { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { fetchWithTimeout } from '../_shared/timeout.ts';
import { stripHtml } from './research.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClicheIndexEntry {
  phrase: string;
  category: string;
  source: string;
  occurrence_count: number;
}

interface ClichePhrase {
  phrase: string;
  category: string;
  description: string | null;
}

interface LlmDetectedEntry {
  phrase: string;
  category: string;
  description?: string;
}

interface AnalysisResult {
  success: boolean;
  count: number;
  categories: number;
}

// ---------------------------------------------------------------------------
// Standalone LLM caller (does NOT import from index.ts)
// ---------------------------------------------------------------------------

interface CallResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

async function callAnalyzerModel(
  modelSlot: string,
  systemPrompt: string,
  userContent: string,
  apiKey: string | null,
  openRouterPrefs?: Record<string, unknown>,
): Promise<CallResult> {
  const [provider, ...rest] = modelSlot.split(':');
  const modelId = rest.join(':');

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  const body: Record<string, unknown> = {
    model: modelId,
    messages,
    max_tokens: 4000,
    temperature: 0.3,
    stream: false,
  };

  let url: string;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (provider === 'openrouter') {
    url = 'https://openrouter.ai/api/v1/chat/completions';
    headers['Authorization'] = `Bearer ${apiKey}`;
    headers['HTTP-Referer'] = 'https://creativewriter.dev';
    headers['X-Title'] = 'Creative Writer';
    if (openRouterPrefs && Object.keys(openRouterPrefs).length > 0) {
      body.provider = openRouterPrefs;
    }
  } else {
    // included (DeepSeek)
    url = 'https://api.deepseek.com/v1/chat/completions';
    const deepseekKey = Deno.env.get('DEEPSEEK_API_KEY');
    if (!deepseekKey) throw new Error('DEEPSEEK_API_KEY not configured');
    headers['Authorization'] = `Bearer ${deepseekKey}`;
  }

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    timeout: 60_000,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Analyzer model error (${response.status}): ${errorText.substring(0, 200)}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };

  return {
    content: data.choices?.[0]?.message?.content || '',
    inputTokens: data.usage?.prompt_tokens || 0,
    outputTokens: data.usage?.completion_tokens || 0,
  };
}

// ---------------------------------------------------------------------------
// JSON extraction (handles markdown fences)
// ---------------------------------------------------------------------------

function extractJson(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');
  if (start >= 0 && end > start) return content.substring(start, end + 1);
  return content.trim();
}

// ---------------------------------------------------------------------------
// Text matching against global cliché phrases
// ---------------------------------------------------------------------------

function textMatchCliches(
  sceneTexts: string[],
  clichePhrases: ClichePhrase[],
): ClicheIndexEntry[] {
  if (clichePhrases.length === 0) return [];

  // Escape regex special chars in each phrase
  const escaped = clichePhrases.map(p =>
    p.phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  );
  const pattern = new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'gi');

  // Count occurrences per phrase (lowercased)
  const counts = new Map<string, { phrase: string; category: string; count: number }>();
  for (const cp of clichePhrases) {
    counts.set(cp.phrase.toLowerCase(), { phrase: cp.phrase, category: cp.category, count: 0 });
  }

  for (const text of sceneTexts) {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      const key = match[0].toLowerCase();
      const entry = counts.get(key);
      if (entry) entry.count++;
    }
  }

  return Array.from(counts.values())
    .filter(e => e.count > 0)
    .map(e => ({
      phrase: e.phrase,
      category: e.category,
      source: 'text_match',
      occurrence_count: e.count,
    }));
}

// ---------------------------------------------------------------------------
// LLM analysis
// ---------------------------------------------------------------------------

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
};

function buildAnalysisPrompt(language: string): string {
  const langName = LANGUAGE_NAMES[language];
  const langLine = langName
    ? `The text is written in ${langName}. Identify phrases in ${langName}.`
    : 'Identify clichés in whatever language the text is written in.';

  return `You are a writing quality analyst. ${langLine}

Analyze the story excerpt below for overused phrases, clichés, and repetitive language patterns.

Identify specific phrases (2-6 words) that are:
- Common writing clichés or overused metaphors
- Phrases the author repeats across passages
- Stock descriptions that could be more original

Return a JSON array: [{"phrase": "...", "category": "...", "description": "..."}]

Categories: emotion_telling, eye_descriptions, physical_reactions, environment_mood, dialogue_tags, fight_action, romance, death_grief, internal_monologue, purple_prose, repetition

Max 20 entries. Only include clear cases. Respond with the JSON array only, no other text.`;
}

async function llmAnalyzeCliches(
  sceneTexts: string[],
  language: string,
  model: string,
  apiKey: string | null,
  openRouterPrefs?: Record<string, unknown>,
): Promise<{ entries: ClicheIndexEntry[]; inputTokens: number; outputTokens: number }> {
  // Sample ~15 evenly-spaced scenes, cap at ~10k words
  const totalScenes = sceneTexts.length;
  const sampleSize = Math.min(15, totalScenes);
  const step = totalScenes / sampleSize;
  const sampled: string[] = [];
  let wordCount = 0;
  const maxWords = 10_000;

  for (let i = 0; i < sampleSize && wordCount < maxWords; i++) {
    const idx = Math.floor(i * step);
    const text = sceneTexts[idx];
    const words = text.split(/\s+/).length;
    if (wordCount + words > maxWords && sampled.length > 0) break;
    sampled.push(text);
    wordCount += words;
  }

  const excerpt = sampled.join('\n\n---\n\n');
  const systemPrompt = buildAnalysisPrompt(language);

  const result = await callAnalyzerModel(model, systemPrompt, excerpt, apiKey, openRouterPrefs);

  // Parse JSON response
  const entries: ClicheIndexEntry[] = [];
  try {
    const jsonStr = extractJson(result.content);
    const parsed = JSON.parse(jsonStr) as LlmDetectedEntry[];
    if (Array.isArray(parsed)) {
      for (const item of parsed.slice(0, 20)) {
        if (item.phrase && typeof item.phrase === 'string' && item.phrase.length <= 500) {
          entries.push({
            phrase: item.phrase,
            category: item.category || 'repetition',
            source: 'llm_detected',
            occurrence_count: 1,
          });
        }
      }
    }
  } catch (e) {
    console.warn('[ClicheAnalyzer] Failed to parse LLM response:', e);
  }

  return { entries, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
}

// ---------------------------------------------------------------------------
// Merge results
// ---------------------------------------------------------------------------

function mergeResults(
  textMatches: ClicheIndexEntry[],
  llmDetected: ClicheIndexEntry[],
): ClicheIndexEntry[] {
  const merged = new Map<string, ClicheIndexEntry>();

  // Text matches take priority
  for (const entry of textMatches) {
    merged.set(entry.phrase.toLowerCase(), entry);
  }

  // LLM entries only added if not already found by text matching
  for (const entry of llmDetected) {
    const key = entry.phrase.toLowerCase();
    if (!merged.has(key)) {
      merged.set(key, entry);
    }
  }

  return Array.from(merged.values());
}

// ---------------------------------------------------------------------------
// Main analysis function
// ---------------------------------------------------------------------------

export async function analyzeCliches(
  userClient: SupabaseClient,
  storyId: string,
  _userId: string,
  model: string,
  apiKey: string | null,
  openRouterPrefs?: Record<string, unknown>,
): Promise<AnalysisResult & { inputTokens: number; outputTokens: number }> {
  // 1. Fetch story language
  const { data: storyData } = await userClient
    .from('stories')
    .select('settings')
    .eq('id', storyId)
    .single();

  const language: string = (storyData?.settings as Record<string, unknown>)?.language as string || 'en';

  // 2. Fetch all scenes
  const { data: scenes, error: scenesError } = await userClient
    .from('scenes')
    .select('id, content')
    .eq('story_id', storyId);

  if (scenesError) {
    console.error('[ClicheAnalyzer] Failed to fetch scenes:', scenesError.message);
    throw new Error('Failed to fetch story scenes');
  }

  // Strip HTML and build plain text arrays
  const sceneTexts = (scenes || [])
    .map(s => stripHtml(s.content || ''))
    .filter(t => t.length > 0);

  // 3. Early exit if no content
  if (sceneTexts.length === 0) {
    return { success: true, count: 0, categories: 0, inputTokens: 0, outputTokens: 0 };
  }

  // 4. Fetch global clichés for this language
  let clichePhrases: ClichePhrase[] = [];
  if (language !== 'custom') {
    const { data: phrases } = await userClient
      .from('cliche_phrases')
      .select('phrase, category, description')
      .eq('language', language);
    clichePhrases = phrases || [];
  }

  // 5. Text matching
  const textMatches = textMatchCliches(sceneTexts, clichePhrases);

  // 6. LLM analysis
  const llmResult = await llmAnalyzeCliches(sceneTexts, language, model, apiKey, openRouterPrefs);

  // 7. Merge
  const allEntries = mergeResults(textMatches, llmResult.entries);

  // 8. Replace index via RPC (preserves user entries)
  const entriesJson = allEntries.map(e => ({
    phrase: e.phrase,
    category: e.category,
    source: e.source,
    occurrence_count: e.occurrence_count,
  }));

  const { error: rpcError } = await userClient.rpc('replace_story_cliche_index', {
    p_story_id: storyId,
    p_entries: entriesJson,
  });

  if (rpcError) {
    console.error('[ClicheAnalyzer] RPC error:', rpcError.message);
    throw new Error(`Failed to save cliché index: ${rpcError.message}`);
  }

  // Count unique categories
  const categories = new Set(allEntries.map(e => e.category)).size;

  return {
    success: true,
    count: allEntries.length,
    categories,
    inputTokens: llmResult.inputTokens,
    outputTokens: llmResult.outputTokens,
  };
}

// ---------------------------------------------------------------------------
// Pipeline helpers — read index + format for prompt injection
// ---------------------------------------------------------------------------

export async function fetchStoryClicheIndex(
  userClient: SupabaseClient,
  storyId: string,
): Promise<ClicheIndexEntry[]> {
  const { data, error } = await userClient
    .from('story_cliche_index')
    .select('phrase, category, source, occurrence_count')
    .eq('story_id', storyId)
    .order('category');

  if (error) {
    console.warn('[ClicheAnalyzer] Failed to fetch cliché index:', error.message);
    return [];
  }

  return data || [];
}

export function formatClicheIndexForPrompt(entries: ClicheIndexEntry[]): string {
  if (entries.length === 0) return '';

  const byCategory = new Map<string, ClicheIndexEntry[]>();
  for (const e of entries) {
    const list = byCategory.get(e.category) || [];
    list.push(e);
    byCategory.set(e.category, list);
  }

  const lines: string[] = [
    '',
    'CLICHÉ INDEX — Avoid these phrases or close variants. Do NOT replace a cliché with another phrase from the same category.',
    '',
  ];

  for (const [category, items] of byCategory) {
    const label = category.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    lines.push(`[${label}]`);
    for (const item of items) {
      lines.push(`- "${item.phrase}"`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
