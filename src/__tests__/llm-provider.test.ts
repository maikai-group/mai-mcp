/**
 * LLM-provider detection + model defaults. Hermetic: env-driven, so every case
 * saves/restores the env keys it touches. No network, no DB.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const KEYS = [
  'MAI_LLM_SUMMARY',
  'MAI_LLM_PROVIDER',
  'MAI_LLM_FALLBACK_PROVIDER',
  'MAI_LLM_BASE_URL',
  'MAI_SUMMARY_MODEL',
  'MAI_CLAUDE_CODE_MODEL',
  'MAI_CODEX_CLI_MODEL',
  'MAI_CODEX_CLI_REASONING',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
] as const;

const saved: Record<string, string | undefined> = {};
const originalReasoning = process.env.MAI_CODEX_CLI_REASONING;
let envCaptured = false;
function setEnv(env: Partial<Record<(typeof KEYS)[number], string>>): void {
  if (!envCaptured) {
    for (const k of KEYS) saved[k] = process.env[k];
    envCaptured = true;
  }
  for (const k of KEYS) {
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
}
afterEach(() => {
  vi.restoreAllMocks();
  if (envCaptured) {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    envCaptured = false;
  }
});

describe('detectLLMProviderId', () => {
  it('returns null when MAI_LLM_SUMMARY is not 1', async () => {
    setEnv({ ANTHROPIC_API_KEY: 'x' });
    const { detectLLMProviderId } = await import('../llm/provider.js');
    expect(detectLLMProviderId()).toBeNull();
  });

  it('defaults to anthropic when a key is present and no provider set', async () => {
    setEnv({ MAI_LLM_SUMMARY: '1', ANTHROPIC_API_KEY: 'x' });
    const { detectLLMProviderId } = await import('../llm/provider.js');
    expect(detectLLMProviderId()).toBe('anthropic');
  });

  it('returns null for anthropic default with no key', async () => {
    setEnv({ MAI_LLM_SUMMARY: '1' });
    const { detectLLMProviderId } = await import('../llm/provider.js');
    expect(detectLLMProviderId()).toBeNull();
  });

  it('selects openai when provider=openai and key present', async () => {
    setEnv({ MAI_LLM_SUMMARY: '1', MAI_LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'x' });
    const { detectLLMProviderId } = await import('../llm/provider.js');
    expect(detectLLMProviderId()).toBe('openai');
  });

  it('selects openai-compatible only with BOTH base_url and model', async () => {
    setEnv({
      MAI_LLM_SUMMARY: '1',
      MAI_LLM_PROVIDER: 'openai-compatible',
      MAI_LLM_BASE_URL: 'http://localhost:11434/v1',
      MAI_SUMMARY_MODEL: 'llama3.1',
    });
    const { detectLLMProviderId } = await import('../llm/provider.js');
    expect(detectLLMProviderId()).toBe('openai-compatible');
  });

  it('returns null for openai-compatible missing the model', async () => {
    setEnv({
      MAI_LLM_SUMMARY: '1',
      MAI_LLM_PROVIDER: 'openai-compatible',
      MAI_LLM_BASE_URL: 'http://localhost:11434/v1',
    });
    const { detectLLMProviderId } = await import('../llm/provider.js');
    expect(detectLLMProviderId()).toBeNull();
  });
});

describe('summaryModel', () => {
  it('uses the per-provider default', async () => {
    setEnv({});
    const { summaryModel } = await import('../llm/provider.js');
    expect(summaryModel('anthropic')).toBe('claude-sonnet-4-6');
    expect(summaryModel('openai')).toBe('gpt-5.6-luna');
  });

  it('MAI_SUMMARY_MODEL overrides the default', async () => {
    setEnv({ MAI_SUMMARY_MODEL: 'claude-haiku-4-5' });
    const { summaryModel } = await import('../llm/provider.js');
    expect(summaryModel('anthropic')).toBe('claude-haiku-4-5');
  });

  it('provider-specific subscription models outrank the legacy primary override', async () => {
    setEnv({
      MAI_SUMMARY_MODEL: 'claude-sonnet-4-6',
      MAI_CLAUDE_CODE_MODEL: 'claude-opus-4-6',
      MAI_CODEX_CLI_MODEL: 'gpt-5.6-terra',
    });
    const { summaryModel } = await import('../llm/provider.js');
    expect(summaryModel('claude-code')).toBe('claude-opus-4-6');
    expect(summaryModel('codex-cli')).toBe('gpt-5.6-terra');
  });

  it('accepts only supported Codex reasoning efforts', async () => {
    const { codexReasoningEffort } = await import('../llm/provider.js');
    setEnv({ MAI_CODEX_CLI_REASONING: 'medium' });
    expect(codexReasoningEffort()).toBe('medium');
    setEnv({ MAI_CODEX_CLI_REASONING: 'turbo' });
    expect(codexReasoningEffort()).toBeUndefined();
  });

  it('restores the original reasoning environment after a multi-step case', () => {
    expect(process.env.MAI_CODEX_CLI_REASONING).toBe(originalReasoning);
  });
});

describe('FallbackLLMProvider', () => {
  const args: Parameters<LLMProvider['completeJSON']>[0] = {
    prompt: 'p',
    schema: { type: 'object', properties: {} },
    schemaName: 'test',
    maxTokens: 100,
  };

  it('returns primary success without calling the fallback', async () => {
    const { FallbackLLMProvider } = await import('../llm/provider.js');
    let fallbackCalls = 0;
    const provider = new FallbackLLMProvider(
      { name: 'primary', completeJSON: async () => ({ source: 'primary' }) },
      { name: 'fallback', completeJSON: async () => { fallbackCalls += 1; return { source: 'fallback' }; } }
    );
    expect(await provider.completeJSON(args)).toEqual({ source: 'primary' });
    expect(fallbackCalls).toBe(0);
  });

  it('calls the fallback exactly once when the primary returns null', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { FallbackLLMProvider } = await import('../llm/provider.js');
    let fallbackCalls = 0;
    const provider = new FallbackLLMProvider(
      { name: 'openai', completeJSON: async () => null },
      { name: 'codex-cli', completeJSON: async () => { fallbackCalls += 1; return { source: 'fallback' }; } }
    );
    expect(await provider.completeJSON(args)).toEqual({ source: 'fallback' });
    expect(fallbackCalls).toBe(1);
  });

  it('falls back on an unexpected primary throw and degrades if both throw', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { FallbackLLMProvider } = await import('../llm/provider.js');
    const primary = { name: 'primary', completeJSON: async (): Promise<unknown> => { throw new Error('boom'); } };
    const success = new FallbackLLMProvider(primary, {
      name: 'fallback', completeJSON: async () => ({ source: 'fallback' }),
    });
    expect(await success.completeJSON(args)).toEqual({ source: 'fallback' });

    const failure = new FallbackLLMProvider(primary, {
      name: 'fallback', completeJSON: async (): Promise<unknown> => { throw new Error('also boom'); },
    });
    expect(await failure.completeJSON(args)).toBeNull();
  });
});

import type { LLMProvider } from '../llm/provider.js';
import type { ParsedSession } from '../ingest.js';

function fakeProvider(result: unknown): LLMProvider {
  return { name: 'fake', completeJSON: async () => result };
}

function minimalParsed(overrides: Partial<ParsedSession> = {}): ParsedSession {
  const base: ParsedSession = {
    sessionId: 'test-session',
    firstTs: undefined,
    lastTs: undefined,
    model: undefined,
    messageCount: 3,
    toolCalls: 2,
    filesRead: 0,
    filesWritten: 0,
    filesEdited: 0,
    thinkingBlocks: [{ text: 'We chose Postgres over SQLite for concurrent writes.', timestamp: undefined }],
    fileEvents: [],
    bashEvents: [],
    commits: [],
    testRuns: [],
  };
  return { ...base, ...overrides };
}

describe('summarizeSession (injected provider)', () => {
  it('maps a well-formed provider result into a SessionSummary', async () => {
    const { summarizeSession } = await import('../summarize.js');
    const provider = fakeProvider({
      summary: 'Did the thing.',
      objectives: ['a', 'b'],
      outcomes: ['x'],
    });
    const out = await summarizeSession({ parsed: minimalParsed(), provider });
    expect(out).toEqual({ summary: 'Did the thing.', objectives: ['a', 'b'], outcomes: ['x'] });
  });

  it('returns null when the provider yields null', async () => {
    const { summarizeSession } = await import('../summarize.js');
    const out = await summarizeSession({ parsed: minimalParsed(), provider: fakeProvider(null) });
    expect(out).toBeNull();
  });

  it('returns null when no provider is configured', async () => {
    const prev = process.env.MAI_LLM_SUMMARY;
    delete process.env.MAI_LLM_SUMMARY;
    try {
      const { summarizeSession } = await import('../summarize.js');
      expect(await summarizeSession({ parsed: minimalParsed() })).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.MAI_LLM_SUMMARY;
      else process.env.MAI_LLM_SUMMARY = prev;
    }
  });
});

describe('extractDecisions (injected provider)', () => {
  it('unwraps the { decisions: [...] } object and maps items', async () => {
    const { extractDecisions } = await import('../summarize.js');
    const provider = fakeProvider({
      decisions: [
        {
          description: 'Chose Postgres.',
          reasoning: 'Concurrent writes.',
          type: 'architecture',
          keywords: ['postgres', 'db'],
          confidence: 0.9,
          files_affected: ['src/db.ts'],
        },
      ],
    });
    const out = await extractDecisions({ parsed: minimalParsed(), provider });
    expect(out).toHaveLength(1);
    expect(out[0].description).toBe('Chose Postgres.');
    expect(out[0].keywords).toEqual(['postgres', 'db']);
  });

  it('also accepts a bare array (prompt-JSON fallback shape)', async () => {
    const { extractDecisions } = await import('../summarize.js');
    const provider = fakeProvider([
      { description: 'X.', reasoning: 'Y.', type: 'scope', keywords: ['k'], confidence: 0.8 },
    ]);
    const out = await extractDecisions({ parsed: minimalParsed(), provider });
    expect(out).toHaveLength(1);
  });

  it('returns [] when there are no thinking blocks', async () => {
    const { extractDecisions } = await import('../summarize.js');
    const provider = fakeProvider({ decisions: [{ description: 'x', reasoning: 'y' }] });
    const out = await extractDecisions({ parsed: minimalParsed({ thinkingBlocks: [] }), provider });
    expect(out).toEqual([]);
  });
});

describe('extractJSON (shared)', () => {
  it('parses fenced, bare, wrapped, and array JSON; null on garbage', async () => {
    const { extractJSON } = await import('../llm/json.js');
    expect(extractJSON('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJSON('{"a":1}')).toEqual({ a: 1 });
    expect(extractJSON('prefix {"a":1} suffix')).toEqual({ a: 1 });
    expect(extractJSON('here: [1,2,3] done')).toEqual([1, 2, 3]);
    expect(extractJSON('not json')).toBeNull();
  });
});
