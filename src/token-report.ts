import type { TranscriptTail } from './cache-status.js';

export type ToolCategory = 'maiMcp' | 'shellTest' | 'fileRead' | 'otherMcp' | 'unknown';
export type Metric = { total: number | null; evidence: 'observed' | 'unavailable'; missingRequests: number };
export interface TokenReport {
  schemaVersion: 1;
  harness: 'codex' | 'claude-code';
  source: 'codex-rollout' | 'claude-transcript';
  scope: 'complete' | 'partial';
  tail: {
    sourceBytes: number;
    readStartByte: number;
    tailBytesRead: number;
    retainedRecords: number;
    skippedRecords: number;
    droppedRecords: number;
    unseenBeforeTailRecords: number | null;
  };
  requests: {
    observed: number;
    countEvidence: 'observed';
    unknownUsageRecords: number;
    inputTokens: Metric;
    outputTokens: Metric;
    cacheReadTokens: Metric;
    cacheWriteTokens: Metric;
  };
  toolResults: {
    total: number;
    countEvidence: 'observed';
    characters: number;
    charactersEvidence: 'proxy';
    byCategory: Record<ToolCategory, { count: number; characters: number }>;
  };
}

interface RequestUsage {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value)) : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function validUsage(value: unknown, host: 'codex' | 'claude'): RequestUsage | null {
  const usage = record(value);
  if (!usage) return null;
  const uncached = count(usage.input_tokens);
  const cacheRead = count(host === 'codex' ? usage.cached_input_tokens : usage.cache_read_input_tokens);
  const cacheWrite = count(host === 'codex' ? usage.cache_write_input_tokens : usage.cache_creation_input_tokens);
  const output = count(usage.output_tokens);
  if (uncached === null && cacheRead === null && cacheWrite === null && output === null) return null;
  let input: number | null = uncached;
  if (host === 'claude') {
    input = uncached !== null && cacheRead !== null && cacheWrite !== null
      && Number.isSafeInteger(uncached + cacheRead + cacheWrite)
      ? uncached + cacheRead + cacheWrite : null;
  }
  return { input, output, cacheRead, cacheWrite };
}

function metric(rows: readonly RequestUsage[], key: keyof RequestUsage): Metric {
  let sum = 0;
  let missingRequests = 0;
  for (const row of rows) {
    const value = row[key];
    if (value === null || !Number.isSafeInteger(sum + value)) missingRequests++;
    else sum += value;
  }
  return rows.length > 0 && missingRequests === 0
    ? { total: sum, evidence: 'observed', missingRequests: 0 }
    : { total: null, evidence: 'unavailable', missingRequests };
}

function categoryForTool(name: string | undefined): ToolCategory {
  if (!name) return 'unknown';
  if (name.startsWith('mcp__mai_mcp__') || name.startsWith('mcp__mai-mcp__')) return 'maiMcp';
  if (name.startsWith('mcp__')) return 'otherMcp';
  if (name === 'exec_command' || name === 'shell' || name === 'Bash') return 'shellTest';
  if (name === 'Read' || name === 'read_file') return 'fileRead';
  return 'unknown';
}

function contentCharacters(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (!Array.isArray(value)) return 0;
  let characters = 0;
  for (const item of value) {
    const block = record(item);
    if (typeof block?.text === 'string') characters += block.text.length;
  }
  return characters;
}

export function buildTokenReport(host: 'codex' | 'claude', tail: TranscriptTail): TokenReport {
  const byCategory: TokenReport['toolResults']['byCategory'] = {
    maiMcp: { count: 0, characters: 0 },
    shellTest: { count: 0, characters: 0 },
    fileRead: { count: 0, characters: 0 },
    otherMcp: { count: 0, characters: 0 },
    unknown: { count: 0, characters: 0 },
  };
  const pending = new Map<string, string>();
  const codexUsage: RequestUsage[] = [];
  const claudeUsage = new Map<string, RequestUsage>();
  let previousCumulative: string | null = null;
  let unknownUsageRecords = 0;
  let toolCount = 0;
  let toolCharacters = 0;

  function rememberCall(id: unknown, name: unknown): void {
    if (typeof id !== 'string' || typeof name !== 'string') return;
    if (pending.size >= 2000 && !pending.has(id)) {
      const oldest = pending.keys().next().value;
      if (oldest !== undefined) pending.delete(oldest);
    }
    pending.set(id, name);
  }

  function addResult(id: unknown, content: unknown): void {
    const name = typeof id === 'string' ? pending.get(id) : undefined;
    if (typeof id === 'string') pending.delete(id);
    const category = categoryForTool(name);
    const characters = contentCharacters(content);
    byCategory[category].count++;
    byCategory[category].characters += characters;
    toolCount++;
    toolCharacters += characters;
  }

  for (const value of tail.values) {
    const row = record(value);
    if (!row) continue;
    if (host === 'codex') {
      const payload = record(row.payload);
      if (!payload) continue;
      if (row.type === 'response_item') {
        if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
          rememberCall(payload.call_id, payload.name);
        } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
          addResult(payload.call_id, payload.output);
        }
      }
      if (row.type !== 'event_msg' || payload.type !== 'token_count') continue;
      const info = record(payload.info);
      const usage = validUsage(info?.last_token_usage, 'codex');
      if (!usage) { unknownUsageRecords++; continue; }
      const cumulative = record(info?.total_token_usage);
      const cumulativeInput = count(cumulative?.input_tokens);
      const cumulativeOutput = count(cumulative?.output_tokens);
      if (cumulativeInput !== null && cumulativeOutput !== null) {
        const key = `${cumulativeInput}:${cumulativeOutput}`;
        if (key === previousCumulative) continue;
        previousCumulative = key;
      }
      codexUsage.push(usage);
      continue;
    }

    const message = record(row.message);
    if (!message) continue;
    if (row.type === 'assistant') {
      if (message.usage !== undefined) {
        const usage = validUsage(message.usage, 'claude');
        if (usage && typeof message.id === 'string' && message.id.length > 0) claudeUsage.set(message.id, usage);
        else unknownUsageRecords++;
      }
      if (!Array.isArray(message.content)) continue;
      for (const item of message.content) {
        const block = record(item);
        if (block?.type === 'tool_use') rememberCall(block.id, block.name);
      }
    } else if (row.type === 'user' && Array.isArray(message.content)) {
      for (const item of message.content) {
        const block = record(item);
        if (block?.type === 'tool_result') addResult(block.tool_use_id, block.content);
      }
    }
  }

  const usages = host === 'codex' ? codexUsage : [...claudeUsage.values()];
  return {
    schemaVersion: 1,
    harness: host === 'codex' ? 'codex' : 'claude-code',
    source: host === 'codex' ? 'codex-rollout' : 'claude-transcript',
    scope: tail.scope,
    tail: {
      sourceBytes: tail.sourceBytes, readStartByte: tail.readStartByte,
      tailBytesRead: tail.tailBytesRead, retainedRecords: tail.retainedRecords,
      skippedRecords: tail.skippedRecords, droppedRecords: tail.droppedRecords,
      unseenBeforeTailRecords: tail.unseenBeforeTailRecords,
    },
    requests: {
      observed: usages.length, countEvidence: 'observed', unknownUsageRecords,
      inputTokens: metric(usages, 'input'), outputTokens: metric(usages, 'output'),
      cacheReadTokens: metric(usages, 'cacheRead'), cacheWriteTokens: metric(usages, 'cacheWrite'),
    },
    toolResults: {
      total: toolCount, countEvidence: 'observed', characters: toolCharacters,
      charactersEvidence: 'proxy', byCategory,
    },
  };
}

export function renderTokenReport(report: TokenReport): string {
  const lines = [
    `${report.harness} session report (${report.scope} transcript tail)`,
    `Observed requests: ${report.requests.observed}; unknown usage records: ${report.requests.unknownUsageRecords}`,
  ];
  for (const [label, value] of [
    ['Input tokens', report.requests.inputTokens],
    ['Output tokens', report.requests.outputTokens],
    ['Cache-read tokens', report.requests.cacheReadTokens],
    ['Cache-write tokens', report.requests.cacheWriteTokens],
  ] as const) {
    lines.push(`${label}: ${value.total ?? 'unavailable'} (${value.evidence}; ${value.missingRequests} missing request(s))`);
  }
  lines.push(`Tool results: ${report.toolResults.total}; text characters: ${report.toolResults.characters} (proxy)`);
  for (const [category, value] of Object.entries(report.toolResults.byCategory)) {
    lines.push(`  ${category}: ${value.count} result(s), ${value.characters} character(s)`);
  }
  lines.push(`Tail: read from byte ${report.tail.readStartByte} of ${report.tail.sourceBytes}; ${report.tail.retainedRecords} retained, ${report.tail.skippedRecords} skipped, ${report.tail.droppedRecords} dropped inside read window.`);
  if (report.tail.unseenBeforeTailRecords === null) lines.push('Earlier records before this tail: unknown count.');
  lines.push('Character counts are proxies, not model tokens or demonstrated savings. Partial tails are not whole-session totals.');
  return lines.join('\n');
}
