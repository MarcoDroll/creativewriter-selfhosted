/**
 * Deno tests for `resolveUpstream` / `toChatCompletionsUrl` (model-calling.ts).
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/_shared/_tests_/model-calling-upstream.test.ts
 *
 * Run in CI via the "Test (Edge Functions / Deno)" step in ci.yml's lint-and-test
 * job (which globs `supabase/functions/`).
 *
 * Context: the four Deep Writer dispatch sites used to be hand-copied
 * `if (openrouter) {…} else { DeepSeek }` branches. The `else` was an unguarded
 * fallthrough, so an `ollama:llama3` slot was POSTed to api.deepseek.com as
 * `model: "llama3"` with the platform key. `resolveUpstream` replaces all four with
 * one exhaustive switch that throws on anything unknown — the `bogus:x` case below
 * is the guard on that deletion.
 *
 * FOOTGUN: `deno test … supabase/functions/` runs every test in ONE process, and
 * `stripe/_tests_/self-hosted-lockdown.test.ts` sets `SELF_HOSTED=true` at module
 * scope. So every test here sets the env it depends on explicitly and restores it in
 * a `finally`. This works only because the resolver reads `Deno.env` at CALL time —
 * keep it that way.
 */

import { assert, assertEquals, assertStringIncludes, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  maxTokensForSlot,
  ModelProviderConfigError,
  resolveUpstream,
  toChatCompletionsUrl,
} from '../model-calling.ts';

const ENV_KEYS = [
  'SELF_HOSTED',
  'DEEPSEEK_API_KEY',
  'OLLAMA_BASE_URL',
  'OLLAMA_API_KEY',
  'OPENAI_COMPATIBLE_BASE_URL',
  'OPENAI_COMPATIBLE_API_KEY',
] as const;

/** Run `fn` with exactly `env` set (every other key above deleted), then restore. */
function withEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    saved.set(key, Deno.env.get(key));
    const value = env[key];
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

const SELF_HOSTED_OLLAMA = { SELF_HOSTED: 'true', OLLAMA_BASE_URL: 'http://host.docker.internal:11434' };

// ---------------------------------------------------------------------------
// OpenRouter
// ---------------------------------------------------------------------------

Deno.test('resolveUpstream: openrouter carries the key, referer and title', () => {
  withEnv({}, () => {
    const target = resolveUpstream('openrouter:anthropic/claude-3.5-sonnet', { apiKey: 'sk-or-test' });
    assertEquals(target.url, 'https://openrouter.ai/api/v1/chat/completions');
    assertEquals(target.headers['Authorization'], 'Bearer sk-or-test');
    assertEquals(target.headers['HTTP-Referer'], 'https://creativewriter.dev');
    assertEquals(target.headers['X-Title'], 'Creative Writer');
    assertEquals(target.bodyExtras, {});
  });
});

Deno.test('resolveUpstream: openrouter prefs ride in bodyExtras, and only when non-empty', () => {
  withEnv({}, () => {
    const withPrefs = resolveUpstream('openrouter:x/y', {
      apiKey: 'k',
      openRouterPrefs: { order: ['Anthropic'] },
    });
    assertEquals(withPrefs.bodyExtras, { provider: { order: ['Anthropic'] } });

    const emptyPrefs = resolveUpstream('openrouter:x/y', { apiKey: 'k', openRouterPrefs: {} });
    assertEquals(emptyPrefs.bodyExtras, {});
  });
});

// ---------------------------------------------------------------------------
// included: (DeepSeek)
// ---------------------------------------------------------------------------

Deno.test('resolveUpstream: included maps the slot id to the wire model + thinking flag', () => {
  withEnv({ DEEPSEEK_API_KEY: 'ds-key' }, () => {
    const chat = resolveUpstream('included:deepseek-chat', { apiKey: null });
    assertEquals(chat.url, 'https://api.deepseek.com/v1/chat/completions');
    assertEquals(chat.headers['Authorization'], 'Bearer ds-key');
    // The slot id is INTERNAL — bodyExtras overwrites body.model with the wire name.
    assertEquals(chat.bodyExtras, { model: 'deepseek-v4-flash', thinking: { type: 'disabled' } });

    const reasoner = resolveUpstream('included:deepseek-reasoner', { apiKey: null });
    assertEquals(reasoner.bodyExtras, { model: 'deepseek-v4-flash', thinking: { type: 'enabled' } });
  });
});

Deno.test('resolveUpstream: deepseekSlotOverride pins the analyzer to non-reasoning', () => {
  withEnv({ DEEPSEEK_API_KEY: 'ds-key' }, () => {
    const target = resolveUpstream('included:deepseek-reasoner', {
      apiKey: null,
      deepseekSlotOverride: 'deepseek-chat',
    });
    assertEquals(target.bodyExtras, { model: 'deepseek-v4-flash', thinking: { type: 'disabled' } });
  });
});

Deno.test('resolveUpstream: included without DEEPSEEK_API_KEY is a config error, not a raw throw', () => {
  withEnv({}, () => {
    const err = assertThrows(
      () => resolveUpstream('included:deepseek-chat', { apiKey: null }),
      ModelProviderConfigError,
    );
    assertStringIncludes(err.message, 'DEEPSEEK_API_KEY');
  });
});

Deno.test('resolveUpstream: on self-hosted, an included slot resolves rather than throwing', () => {
  // Self-hosted deliberately never forwards DEEPSEEK_API_KEY (docker-compose.yml
  // says so). `requireEnv` returns '' there instead of throwing, which is what keeps
  // the eager resolve in validateCommonBody from pre-empting setupBudgetContext's
  // precise 403 ("Included AI is not available on self-hosted instances") with a
  // vague 400. If this ever starts throwing, that 403 becomes unreachable.
  withEnv({ SELF_HOSTED: 'true' }, () => {
    const target = resolveUpstream('included:deepseek-chat', { apiKey: null });
    assertEquals(target.url, 'https://api.deepseek.com/v1/chat/completions');
    assertEquals(target.headers['Authorization'], 'Bearer ');
  });
});

// ---------------------------------------------------------------------------
// The deleted fallthrough
// ---------------------------------------------------------------------------

Deno.test('resolveUpstream: venice carries the forwarded key, and no body extras', () => {
  // The author's own key, exactly as OpenRouter's is. `bodyExtras` stays empty on purpose:
  // the browser-side VeniceApiService sends no `venice_parameters` either, and the same
  // model must not answer differently depending on which surface called it.
  const target = resolveUpstream('venice:venice-uncensored', { apiKey: 'vk-test' });
  assertEquals(target.url, 'https://api.venice.ai/api/v1/chat/completions');
  assertEquals(target.headers['Authorization'], 'Bearer vk-test');
  assertEquals(Object.keys(target.bodyExtras).length, 0);
});

Deno.test('resolveUpstream: venice honours slot casing like the other hosted providers', () => {
  assertEquals(
    resolveUpstream('Venice:venice-uncensored', { apiKey: 'vk' }).url,
    'https://api.venice.ai/api/v1/chat/completions',
  );
});

Deno.test('maxTokensForSlot: only venice is padded, and only upward', () => {
  // Venice spends hidden <think> tokens from the SAME budget as the visible completion, so a
  // 600-token analyzer budget can be consumed entirely by thinking. Every other provider
  // either has no such sharing or exposes reasoning separately, and must be left alone —
  // padding OpenRouter here would silently triple what an author is billed for.
  for (const slot of ['openrouter:x/y', 'included:deepseek-chat', 'ollama:llama3', 'openaiCompatible:m']) {
    assertEquals(maxTokensForSlot(slot, 600), 600, `${slot} should not be padded`);
  }
  assert(maxTokensForSlot('venice:venice-uncensored', 600) > 600);
});

Deno.test('maxTokensForSlot: the padding matches the browser path exactly', () => {
  // Same arithmetic as `withReasoningHeadroom` in venice-api.service.ts:
  // maxTokens + clamp(maxTokens, 1024, 32000). The two copies must agree, or the same model
  // gets a different budget depending on which surface called it.
  assertEquals(maxTokensForSlot('venice:m', 600), 600 + 1024);    // floor applies
  assertEquals(maxTokensForSlot('venice:m', 800), 800 + 1024);    // floor still applies
  assertEquals(maxTokensForSlot('venice:m', 3000), 3000 + 3000);  // 1:1 above the floor
  assertEquals(maxTokensForSlot('venice:m', 40_000), 40_000 + 32_000); // ceiling applies
});

Deno.test('maxTokensForSlot: casing is honoured, like every other slot read', () => {
  assertEquals(maxTokensForSlot('Venice:m', 600), 600 + 1024);
});

Deno.test('resolveUpstream: an unknown provider throws instead of reaching DeepSeek', () => {
  withEnv({ SELF_HOSTED: 'true', DEEPSEEK_API_KEY: 'ds-key' }, () => {
    for (const slot of ['bogus:x', 'gemini:gemini-2.0-flash', 'claude:opus', 'replicate:some/model']) {
      const err = assertThrows(
        () => resolveUpstream(slot, { apiKey: null }),
        ModelProviderConfigError,
        undefined,
        `expected ${slot} to be rejected`,
      );
      assertStringIncludes(err.message, 'Unsupported model provider');
    }
  });
});

// ---------------------------------------------------------------------------
// Local providers
// ---------------------------------------------------------------------------

Deno.test('resolveUpstream: ollama points at the operator base URL', () => {
  withEnv(SELF_HOSTED_OLLAMA, () => {
    const target = resolveUpstream('ollama:qwen2.5:14b', { apiKey: null });
    assertEquals(target.url, 'http://host.docker.internal:11434/v1/chat/completions');
    assertEquals(target.headers['Content-Type'], 'application/json');
    assertEquals(target.bodyExtras, {});
  });
});

Deno.test('resolveUpstream: an OpenRouter key never reaches a local target', () => {
  withEnv({ ...SELF_HOSTED_OLLAMA, OPENAI_COMPATIBLE_BASE_URL: 'http://lmstudio:1234' }, () => {
    for (const slot of ['ollama:llama3', 'openaiCompatible:local-model']) {
      const target = resolveUpstream(slot, { apiKey: 'sk-or-secret' });
      const serialized = JSON.stringify(target.headers);
      assert(
        !serialized.includes('sk-or-secret'),
        `${slot} leaked the OpenRouter key into headers: ${serialized}`,
      );
      assertEquals(target.headers['Authorization'], undefined);
      assertEquals(target.headers['HTTP-Referer'], undefined);
    }
  });
});

Deno.test('resolveUpstream: the local API key comes from the operator env', () => {
  withEnv({
    SELF_HOSTED: 'true',
    OPENAI_COMPATIBLE_BASE_URL: 'http://vllm:8000/v1',
    OPENAI_COMPATIBLE_API_KEY: 'vllm-token',
  }, () => {
    const target = resolveUpstream('openaiCompatible:mistral', { apiKey: 'sk-or-secret' });
    assertEquals(target.headers['Authorization'], 'Bearer vllm-token');
  });
});

Deno.test('resolveUpstream: unset base URL names the env var and never falls back', () => {
  withEnv({ SELF_HOSTED: 'true' }, () => {
    const ollamaErr = assertThrows(
      () => resolveUpstream('ollama:llama3', { apiKey: null }),
      ModelProviderConfigError,
    );
    assertStringIncludes(ollamaErr.message, 'OLLAMA_BASE_URL');
    assertStringIncludes(ollamaErr.message, 'Ollama is not configured on this server');

    const compatErr = assertThrows(
      () => resolveUpstream('openaiCompatible:m', { apiKey: null }),
      ModelProviderConfigError,
    );
    assertStringIncludes(compatErr.message, 'OPENAI_COMPATIBLE_BASE_URL');
  });
});

Deno.test('resolveUpstream: a whitespace-only base URL counts as unset', () => {
  withEnv({ SELF_HOSTED: 'true', OLLAMA_BASE_URL: '   ' }, () => {
    const err = assertThrows(() => resolveUpstream('ollama:llama3', { apiKey: null }), ModelProviderConfigError);
    assertStringIncludes(err.message, 'not configured');
  });
});

Deno.test('resolveUpstream: a local slot on a hosted instance throws', () => {
  // Configured base URL, SELF_HOSTED unset — still refused.
  withEnv({ OLLAMA_BASE_URL: 'http://localhost:11434' }, () => {
    const err = assertThrows(() => resolveUpstream('ollama:llama3', { apiKey: null }), ModelProviderConfigError);
    assertStringIncludes(err.message, 'self-hosted');
  });
  withEnv({ SELF_HOSTED: 'false', OPENAI_COMPATIBLE_BASE_URL: 'http://localhost:1234' }, () => {
    assertThrows(() => resolveUpstream('openaiCompatible:m', { apiKey: null }), ModelProviderConfigError);
  });
});

// ---------------------------------------------------------------------------
// Casing — `ModelService` mints `openaiCompatible:` with a capital C
// ---------------------------------------------------------------------------

Deno.test('resolveUpstream: every casing of openaiCompatible resolves identically', () => {
  withEnv({ SELF_HOSTED: 'true', OPENAI_COMPATIBLE_BASE_URL: 'http://lmstudio:1234' }, () => {
    const expected = 'http://lmstudio:1234/v1/chat/completions';
    for (const prefix of ['openaiCompatible', 'openaicompatible', 'OpenAICompatible', 'OPENAICOMPATIBLE']) {
      assertEquals(resolveUpstream(`${prefix}:m`, { apiKey: null }).url, expected, `${prefix} did not resolve`);
    }
  });
});

Deno.test('resolveUpstream: casing is honoured for the hosted providers too', () => {
  withEnv({ DEEPSEEK_API_KEY: 'ds-key' }, () => {
    assertEquals(
      resolveUpstream('OpenRouter:x/y', { apiKey: 'k' }).url,
      'https://openrouter.ai/api/v1/chat/completions',
    );
    assertEquals(
      resolveUpstream('Included:deepseek-chat', { apiKey: null }).url,
      'https://api.deepseek.com/v1/chat/completions',
    );
  });
});

// ---------------------------------------------------------------------------
// URL normalisation
// ---------------------------------------------------------------------------

Deno.test('toChatCompletionsUrl: the five spellings operators actually write', () => {
  const expected = 'http://host.docker.internal:11434/v1/chat/completions';
  for (
    const base of [
      'http://host.docker.internal:11434',
      'http://host.docker.internal:11434/',
      'http://host.docker.internal:11434/v1',
      'http://host.docker.internal:11434/v1/',
      'http://host.docker.internal:11434/v1/chat/completions',
    ]
  ) {
    assertEquals(toChatCompletionsUrl(base), expected, `failed for ${base}`);
  }
});

Deno.test('toChatCompletionsUrl: surrounding whitespace, https, LAN IPs and sub-paths', () => {
  assertEquals(toChatCompletionsUrl('  http://192.168.1.50:11434  '), 'http://192.168.1.50:11434/v1/chat/completions');
  assertEquals(toChatCompletionsUrl('https://llm.example.com'), 'https://llm.example.com/v1/chat/completions');
  assertEquals(toChatCompletionsUrl('https://gw.example.com/ollama'), 'https://gw.example.com/ollama/v1/chat/completions');
  assertEquals(toChatCompletionsUrl('http://h:11434///'), 'http://h:11434/v1/chat/completions');
});

Deno.test('toChatCompletionsUrl: the suffix match is case-insensitive', () => {
  // A case-SENSITIVE endsWith('/v1') appended a second one — `/V1` became
  // `/V1/v1/chat/completions`, a 404 with a baffling message. The operator's own
  // casing is preserved in what we send; the upstream server decides on it.
  assertEquals(toChatCompletionsUrl('http://h:11434/V1'), 'http://h:11434/V1/chat/completions');
  assertEquals(toChatCompletionsUrl('http://h:11434/V1/'), 'http://h:11434/V1/chat/completions');
  assertEquals(toChatCompletionsUrl('http://h:11434/v1/Chat/Completions'), 'http://h:11434/v1/Chat/Completions');
  // The scheme and host are lowercased by the URL parser itself, which is correct —
  // they are case-insensitive by spec, unlike the path.
  assertEquals(toChatCompletionsUrl('HTTP://H:11434'), 'http://h:11434/v1/chat/completions');
});

Deno.test('toChatCompletionsUrl: query and fragment are stripped, host forms survive', () => {
  // A stray `?x=1` on a pasted URL must not ride along on every model request.
  assertEquals(toChatCompletionsUrl('http://h:11434?x=1'), 'http://h:11434/v1/chat/completions');
  assertEquals(toChatCompletionsUrl('http://h:11434/#frag'), 'http://h:11434/v1/chat/completions');
  // Basic-auth userinfo is a legitimate way for an operator to reach a proxied server.
  assertEquals(toChatCompletionsUrl('http://user:pw@h:11434'), 'http://user:pw@h:11434/v1/chat/completions');
  assertEquals(toChatCompletionsUrl('http://[::1]:11434'), 'http://[::1]:11434/v1/chat/completions');
  assertEquals(toChatCompletionsUrl('http://h'), 'http://h/v1/chat/completions');
});

Deno.test('toChatCompletionsUrl: a bare /chat/completions outside /v1 is left alone', () => {
  // Some shims serve it at the root. Appending /v1/chat/completions to a URL that
  // already ends in the endpoint would be the same doubling bug in another spelling.
  assertEquals(toChatCompletionsUrl('http://h:11434/chat/completions'), 'http://h:11434/chat/completions');
});

Deno.test('toChatCompletionsUrl: rejects every scheme but http/https, and non-URLs', () => {
  for (const bad of ['ftp://x/', 'file:///etc/passwd', 'gopher://h', 'not a url', 'localhost:11434', '']) {
    assertThrows(() => toChatCompletionsUrl(bad), ModelProviderConfigError, undefined, `expected ${bad} to be rejected`);
  }
});

Deno.test('resolveUpstream: an invalid base URL names the env var it came from', () => {
  withEnv({ SELF_HOSTED: 'true', OLLAMA_BASE_URL: 'ftp://evil/' }, () => {
    const err = assertThrows(() => resolveUpstream('ollama:llama3', { apiKey: null }), ModelProviderConfigError);
    assertStringIncludes(err.message, 'OLLAMA_BASE_URL is invalid');
    assertStringIncludes(err.message, 'http://');
  });
});

Deno.test('resolveUpstream: the model id never reaches the URL path', () => {
  withEnv(SELF_HOSTED_OLLAMA, () => {
    const target = resolveUpstream('ollama:../../admin/secret', { apiKey: null });
    assertEquals(target.url, 'http://host.docker.internal:11434/v1/chat/completions');
  });
});
