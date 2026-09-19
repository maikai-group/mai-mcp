// LLM provider abstraction — the internal summarizer/decision-extractor runs on
// any of five provider families. Mirrors the env-gated pattern in embeddings.ts.
//
// Env gates:
//   MAI_LLM_SUMMARY=1                                   master switch
//   MAI_LLM_PROVIDER=anthropic|openai|openai-compatible|claude-code|codex-cli
//                                                       (default: anthropic)
//   MAI_LLM_FALLBACK_PROVIDER=claude-code|codex-cli      optional subscription fallback
//   ANTHROPIC_API_KEY / OPENAI_API_KEY                  provider key (subscription providers need none)
//   MAI_LLM_BASE_URL                                    required for openai-compatible
//   MAI_SUMMARY_MODEL                                   per-provider model override
//                                                       (required for openai-compatible;
//                                                        optional for claude-code / codex-cli — unset
//                                                        means the user's own CLI default)
//   MAI_CLAUDE_CODE_MODEL / MAI_CODEX_CLI_MODEL          subscription-provider-specific overrides
//   MAI_CODEX_CLI_REASONING                              low|medium|high|xhigh|max
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { ClaudeCodeProvider, claudeBinaryAvailable } from './claude-code.js';
import { CodexCliProvider, codexBinaryAvailable } from './codex-cli.js';

/**
 * JSON Schema for structured output. Shaped so it is directly assignable to
 * Anthropic's Tool.InputSchema and OpenAI's json_schema.schema — no casts.
 */
export interface JSONSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [k: string]: unknown;
}

export interface LLMProvider {
  readonly name: string;
  /**
   * Complete a single-prompt request whose output must conform to `schema`.
   * Returns parsed JSON as `unknown` (the caller validates at its boundary) or
   * null if the call failed / produced unparseable output (graceful degrade).
   */
  completeJSON(args: {
    prompt: string;
    schema: JSONSchema;
    schemaName: string;
    maxTokens: number;
  }): Promise<unknown | null>;
}

export type LLMProviderId = 'anthropic' | 'openai' | 'openai-compatible' | 'claude-code' | 'codex-cli';
export type SubscriptionProviderId = 'claude-code' | 'codex-cli';

const DEFAULT_MODEL: Record<LLMProviderId, string | null> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-5.6-luna',
  'openai-compatible': null, // no sensible default — MAI_SUMMARY_MODEL required
  'claude-code': null, // no default — unset means the user's Claude Code default model
  'codex-cli': null, // no default — unset means the user's own Codex default model
};

function isLLMProviderId(value: string | undefined): value is LLMProviderId {
  return value === 'anthropic' || value === 'openai' || value === 'openai-compatible' ||
    value === 'claude-code' || value === 'codex-cli';
}

function isSubscriptionProviderId(value: string | undefined): value is SubscriptionProviderId {
  return value === 'claude-code' || value === 'codex-cli';
}

function providerAvailable(id: LLMProviderId, fallback = false): boolean {
  switch (id) {
    case 'anthropic':
      return Boolean(process.env.ANTHROPIC_API_KEY);
    case 'openai':
      return Boolean(process.env.OPENAI_API_KEY);
    case 'openai-compatible':
      return Boolean(process.env.MAI_LLM_BASE_URL && process.env.MAI_SUMMARY_MODEL);
    case 'claude-code':
      return claudeBinaryAvailable();
    case 'codex-cli':
      return codexBinaryAvailable();
  }
}

function primaryProviderId(): LLMProviderId | null {
  const raw = process.env.MAI_LLM_PROVIDER;
  if (raw === undefined) return 'anthropic';
  return isLLMProviderId(raw) ? raw : null;
}

function fallbackProviderId(primary: LLMProviderId | null): SubscriptionProviderId | null {
  const raw = process.env.MAI_LLM_FALLBACK_PROVIDER;
  if (!isSubscriptionProviderId(raw) || raw === primary) return null;
  return raw;
}

/** Every ready configured provider in execution order. Callers that reason
 * about possible subscription use must inspect the whole chain, not only the
 * first effective provider. */
export function detectLLMProviderIds(): LLMProviderId[] {
  if (process.env.MAI_LLM_SUMMARY !== '1') return [];
  const primary = primaryProviderId();
  const fallback = fallbackProviderId(primary);
  const ids: LLMProviderId[] = [];
  if (primary && providerAvailable(primary)) ids.push(primary);
  if (fallback && providerAvailable(fallback, true)) ids.push(fallback);
  return ids;
}

/** The first provider that would execute. Use detectLLMProviderIds() when a
 * caller must reason about possible fallback use. */
export function detectLLMProviderId(): LLMProviderId | null {
  return detectLLMProviderIds()[0] ?? null;
}

/** Model for a resolved provider. MAI_SUMMARY_MODEL overrides the per-provider default. */
export function summaryModel(id: LLMProviderId): string {
  const providerOverride = id === 'claude-code'
    ? process.env.MAI_CLAUDE_CODE_MODEL
    : id === 'codex-cli'
      ? process.env.MAI_CODEX_CLI_MODEL
      : undefined;
  const override = providerOverride || process.env.MAI_SUMMARY_MODEL;
  if (override) return override;
  return defaultModel(id);
}

/** Fallbacks never inherit MAI_SUMMARY_MODEL: it belongs to the primary and may
 * name a model from a different vendor. Provider-specific overrides are safe. */
function fallbackSummaryModel(id: LLMProviderId): string {
  const override = id === 'claude-code'
    ? process.env.MAI_CLAUDE_CODE_MODEL
    : id === 'codex-cli'
      ? process.env.MAI_CODEX_CLI_MODEL
      : undefined;
  if (override) return override;
  return defaultModel(id);
}

function defaultModel(id: LLMProviderId): string {
  const def = DEFAULT_MODEL[id];
  if (!def) {
    if (id === 'claude-code' || id === 'codex-cli') return ''; // '' = no model flag; display handled in status
    throw new Error(
      `MAI_SUMMARY_MODEL is required when MAI_LLM_PROVIDER=${id} (no default model).`
    );
  }
  return def;
}

export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export function codexReasoningEffort(): CodexReasoningEffort | undefined {
  const raw = process.env.MAI_CODEX_CLI_REASONING;
  if (raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'xhigh' || raw === 'max') return raw;
  return undefined;
}

function unavailableReason(id: LLMProviderId | null): string {
  if (id === 'claude-code') return 'claude binary not found on PATH';
  if (id === 'codex-cli') return 'codex binary not found on PATH or not logged in';
  return 'missing key/base_url/model';
}

function providerDescription(id: LLMProviderId, model: string): string {
  if (id === 'claude-code') {
    return `claude-code (subscription), model: ${model || 'Claude Code default'}`;
  }
  if (id === 'codex-cli') {
    const reasoning = codexReasoningEffort();
    return `codex-cli (subscription), model: ${model || 'Codex default'}${reasoning ? `, reasoning: ${reasoning}` : ''}`;
  }
  return `${id}, model: ${model}`;
}

export function llmProviderStatus(): string {
  if (process.env.MAI_LLM_SUMMARY !== '1') {
    return 'disabled — set MAI_LLM_SUMMARY=1 to enable.';
  }
  const primary = primaryProviderId();
  const fallback = fallbackProviderId(primary);
  const primaryReady = primary !== null && providerAvailable(primary);
  const fallbackReady = fallback !== null && providerAvailable(fallback, true);
  if (!primaryReady && !fallbackReady) {
    const p = process.env.MAI_LLM_PROVIDER ?? 'anthropic';
    const fallbackText = fallback ? `; fallback '${fallback}' is also unavailable (${unavailableReason(fallback)})` : '';
    return `enabled flag set but provider '${p}' is not configured (${unavailableReason(primary)})${fallbackText}.`;
  }
  if (!fallback) {
    if (!primary) return `enabled flag set but provider '${process.env.MAI_LLM_PROVIDER}' is not configured (${unavailableReason(primary)}).`;
    return `enabled — provider: ${providerDescription(primary, summaryModel(primary))}`;
  }
  if (!primaryReady) {
    return `enabled — primary '${primary ?? process.env.MAI_LLM_PROVIDER}' unavailable (${unavailableReason(primary)}); ` +
      `using fallback: ${providerDescription(fallback, fallbackSummaryModel(fallback))}`;
  }
  const fallbackStatus = fallbackReady
    ? providerDescription(fallback, fallbackSummaryModel(fallback))
    : `'${fallback}' unavailable (${unavailableReason(fallback)})`;
  return `enabled — primary: ${providerDescription(primary, summaryModel(primary))}; fallback: ${fallbackStatus}`;
}

function createProvider(id: LLMProviderId, model: string): LLMProvider | null {
  switch (id) {
    case 'anthropic':
      return new AnthropicProvider(model);
    case 'openai':
      return new OpenAIProvider({ model });
    case 'openai-compatible': {
      const baseURL = process.env.MAI_LLM_BASE_URL;
      if (!baseURL) return null; // unreachable per detection; keeps types honest
      return new OpenAIProvider({ model, baseURL });
    }
    case 'claude-code':
      return new ClaudeCodeProvider(model || undefined);
    case 'codex-cli':
      return new CodexCliProvider(model || undefined, codexReasoningEffort());
  }
}

/** Ordered provider that retries the same structured-output request once on
 * the configured fallback. A valid empty payload is success; only null fails. */
export class FallbackLLMProvider implements LLMProvider {
  readonly name: string;
  constructor(
    private readonly primary: LLMProvider,
    private readonly fallback: LLMProvider
  ) {
    this.name = `${primary.name} -> ${fallback.name}`;
  }

  async completeJSON(args: {
    prompt: string;
    schema: JSONSchema;
    schemaName: string;
    maxTokens: number;
  }): Promise<unknown | null> {
    let result: unknown | null = null;
    try {
      result = await this.primary.completeJSON(args);
    } catch (error) {
      console.warn(`[mai-llm] ${this.primary.name} threw: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (result !== null) return result;
    console.warn(`[mai-llm] ${this.primary.name} failed; falling back to ${this.fallback.name}`);
    try {
      return await this.fallback.completeJSON(args);
    } catch (error) {
      console.warn(`[mai-llm] ${this.fallback.name} threw: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}

/** Resolve the configured provider chain, or null if neither provider is ready. */
export function getLLMProvider(): LLMProvider | null {
  if (process.env.MAI_LLM_SUMMARY !== '1') return null;
  const primaryId = primaryProviderId();
  const fallbackId = fallbackProviderId(primaryId);
  const primary = primaryId && providerAvailable(primaryId)
    ? createProvider(primaryId, summaryModel(primaryId))
    : null;
  const fallback = fallbackId && providerAvailable(fallbackId, true)
    ? createProvider(fallbackId, fallbackSummaryModel(fallbackId))
    : null;
  if (primary && fallback) return new FallbackLLMProvider(primary, fallback);
  return primary ?? fallback;
}
