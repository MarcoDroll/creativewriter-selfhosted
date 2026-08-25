/**
 * Deno tests for the Deep Writer slot provider gate (model-calling.ts).
 *
 * Run locally with:
 *   deno test --node-modules-dir=none --allow-env --allow-net \
 *     supabase/functions/_shared/_tests_/model-calling-provider-gate.test.ts
 *
 * Run in CI via the "Test (Edge Functions / Deno)" step in ci.yml's lint-and-test job.
 *
 * These live in `_shared` rather than next to the endpoint because `index.ts` has a
 * module-level `Deno.serve` and so cannot be imported by a test.
 *
 * FOOTGUN: the whole suite runs in ONE process and
 * `stripe/_tests_/self-hosted-lockdown.test.ts` sets `SELF_HOSTED=true` at module
 * scope. Every test sets it explicitly with a `finally` restore, which works only
 * because `allowedSlotProviders` reads env at CALL time.
 */

import { assert, assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { allowedSlotProviders, checkSlotProviders, slotProvider } from '../model-calling.ts';

function withSelfHosted(value: string | undefined, fn: () => void): void {
  const saved = Deno.env.get('SELF_HOSTED');
  if (value === undefined) Deno.env.delete('SELF_HOSTED');
  else Deno.env.set('SELF_HOSTED', value);
  try {
    fn();
  } finally {
    if (saved === undefined) Deno.env.delete('SELF_HOSTED');
    else Deno.env.set('SELF_HOSTED', saved);
  }
}

const FOUR_SLOTS = {
  writing: 'openrouter:anthropic/claude-3.5-sonnet',
  research: 'included:deepseek-chat',
  refiner: 'openrouter:x/y',
  analyzer: 'included:deepseek-chat',
};

Deno.test('allowedSlotProviders: hosted is openrouter + included only', () => {
  withSelfHosted(undefined, () => {
    assertEquals([...allowedSlotProviders()].sort(), ['included', 'openrouter']);
  });
  withSelfHosted('false', () => {
    assertEquals([...allowedSlotProviders()].sort(), ['included', 'openrouter']);
  });
});

Deno.test('allowedSlotProviders: self-hosted adds the two local providers, and KEEPS included', () => {
  withSelfHosted('true', () => {
    assertEquals([...allowedSlotProviders()].sort(), ['included', 'ollama', 'openaicompatible', 'openrouter']);
  });
  // `included` stays so that setupBudgetContext's precise 403 ("Included AI is not
  // available on self-hosted instances") remains the error a stale included: slot
  // gets, instead of a vague 400 from this gate.
});

Deno.test('checkSlotProviders: hosted accepts the hosted pair', () => {
  withSelfHosted(undefined, () => {
    assertEquals(checkSlotProviders(FOUR_SLOTS), null);
  });
});

Deno.test('checkSlotProviders: hosted rejects ollama, openaiCompatible and bogus', () => {
  withSelfHosted(undefined, () => {
    for (const slot of ['ollama:llama3', 'openaiCompatible:m', 'bogus:x']) {
      const message = checkSlotProviders({ ...FOUR_SLOTS, writing: slot });
      assert(message !== null, `expected ${slot} to be rejected on hosted`);
      assertStringIncludes(message, 'not available on this instance');
      assertStringIncludes(message, 'writing');
    }
  });
});

Deno.test('checkSlotProviders: self-hosted accepts all four allowed providers', () => {
  withSelfHosted('true', () => {
    assertEquals(
      checkSlotProviders({
        writing: 'ollama:qwen2.5:14b',
        research: 'openaiCompatible:local-model',
        refiner: 'openrouter:x/y',
        analyzer: 'included:deepseek-chat',
      }),
      null,
    );
  });
});

Deno.test('checkSlotProviders: self-hosted still rejects the non-Deep-Writer providers', () => {
  withSelfHosted('true', () => {
    for (const slot of ['gemini:gemini-2.0-flash', 'claude:opus', 'replicate:some/model', 'agentic:pipeline']) {
      const message = checkSlotProviders({ ...FOUR_SLOTS, writing: slot });
      assert(message !== null, `expected ${slot} to be rejected on self-hosted`);
    }
  });
});

Deno.test('checkSlotProviders: rejection fires on ANY of the four fields', () => {
  withSelfHosted(undefined, () => {
    for (const field of ['writing', 'research', 'refiner', 'analyzer'] as const) {
      const message = checkSlotProviders({ ...FOUR_SLOTS, [field]: 'ollama:llama3' });
      assert(message !== null, `expected models.${field} to be checked`);
      assertStringIncludes(message, field);
    }
  });
});

Deno.test('checkSlotProviders: casing does not smuggle a provider past the gate', () => {
  withSelfHosted(undefined, () => {
    for (const slot of ['Ollama:llama3', 'OLLAMA:llama3', 'openaiCompatible:m', 'OpenAICompatible:m']) {
      assert(checkSlotProviders({ writing: slot }) !== null, `expected ${slot} to be rejected`);
    }
  });
  withSelfHosted('true', () => {
    // …and the same spellings are accepted where they are allowed.
    for (const slot of ['Ollama:llama3', 'openaiCompatible:m', 'OpenAICompatible:m']) {
      assertEquals(checkSlotProviders({ writing: slot }), null, `expected ${slot} to be accepted`);
    }
  });
});

Deno.test('checkSlotProviders: the single-model /analyze-cliches shape', () => {
  withSelfHosted(undefined, () => {
    assertEquals(checkSlotProviders({ model: 'included:deepseek-chat' }), null);
    assertEquals(checkSlotProviders({ model: 'openrouter:x/y' }), null);
    const message = checkSlotProviders({ model: 'ollama:llama3' });
    assert(message !== null);
    assertStringIncludes(message, 'model');
  });
  withSelfHosted('true', () => {
    assertEquals(checkSlotProviders({ model: 'ollama:llama3' }), null);
  });
});

Deno.test('slotProvider: lowercases, so a budget or credential guard cannot be walked around by casing', () => {
  // `slot.startsWith('included:')` — the shape this replaced — answers false here
  // while `resolveUpstream` serves the slot, which would have skipped the AI-budget
  // guard entirely.
  assertEquals(slotProvider('Included:deepseek-chat'), 'included');
  assertEquals(slotProvider('INCLUDED:deepseek-chat'), 'included');
  assertEquals(slotProvider('OpenRouter:x/y'), 'openrouter');
  assertEquals(slotProvider('openaiCompatible:m'), 'openaicompatible');
  // A model id containing a colon (Ollama tags do) belongs to the id, not the provider.
  assertEquals(slotProvider('ollama:qwen2.5:14b'), 'ollama');
  assertEquals(slotProvider('llama3'), 'llama3');
});

Deno.test('checkSlotProviders: a slot with no colon has no provider and is rejected', () => {
  withSelfHosted('true', () => {
    assert(checkSlotProviders({ writing: 'llama3' }) !== null);
  });
});
