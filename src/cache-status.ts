import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

export type CacheHarness = 'claude-code' | 'codex';
export type CacheState = 'warm' | 'expiring' | 'cold' | 'unknown';
export interface CacheSnapshot {
  schemaVersion: 1;
  harness: CacheHarness;
  source: 'claude-statusline' | 'claude-transcript' | 'codex-rollout';
  sessionId: string | null;
  model: string | null;
  observedAt: string | null;
  contextUsedPercent: number | null;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
  };
  cache: { state: CacheState; expiresAt: string | null; requestHitRatio: number | null; sessionHitRatio: number | null };
  apiEquivalentUsd: number | null;
  warmer: 'off';
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value)) : null;
}
function string(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function finiteRange(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
}
function totalInput(uncached: number | null, read: number | null, write: number | null): number | null {
  if (uncached === null || read === null || write === null) return null;
  const total = uncached + read + write;
  return Number.isSafeInteger(total) ? total : null;
}
function requestHitRatio(read: number | null, total: number | null): number | null {
  return read !== null && total !== null && total > 0 && read <= total ? read / total : null;
}
function stamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function empty(harness: CacheHarness, source: CacheSnapshot['source']): CacheSnapshot {
  return {
    schemaVersion: 1, harness, source, sessionId: null, model: null, observedAt: null,
    contextUsedPercent: null,
    usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null },
    cache: { state: 'unknown', expiresAt: null, requestHitRatio: null, sessionHitRatio: null },
    apiEquivalentUsd: null, warmer: 'off',
  };
}

export function parseClaudeStatusline(value: unknown, nowMs = Date.now()): CacheSnapshot {
  const root = record(value);
  if (!root) throw new Error('Claude statusline input must be a JSON object');
  const result = empty('claude-code', 'claude-statusline');
  result.sessionId = string(root.session_id);
  result.model = string(record(root.model)?.display_name) ?? string(record(root.model)?.id);
  result.observedAt = new Date(nowMs).toISOString();
  const context = record(root.context_window);
  result.contextUsedPercent = finiteRange(context?.used_percentage, 0, 100);
  const usage = record(context?.current_usage);
  const read = count(usage?.cache_read_input_tokens);
  const write = count(usage?.cache_creation_input_tokens);
  const total = totalInput(count(usage?.input_tokens), read, write);
  result.usage = {
    inputTokens: total, outputTokens: count(usage?.output_tokens),
    cacheReadTokens: read, cacheWriteTokens: write,
  };
  result.cache.requestHitRatio = requestHitRatio(read, total);
  const cache = record(root.prompt_cache);
  const expiresSeconds = finiteRange(cache?.expires_at, 0, 8_640_000_000);
  const expiresMs = expiresSeconds === null ? null : expiresSeconds * 1000;
  result.cache.expiresAt = expiresMs === null ? null : new Date(expiresMs).toISOString();
  result.cache.sessionHitRatio = finiteRange(cache?.hit_ratio, 0, 1);
  if (cache?.warm === false) result.cache.state = 'cold';
  else if (cache?.warm === true) {
    if (expiresMs !== null && expiresMs <= nowMs) result.cache.state = 'cold';
    else result.cache.state = expiresMs !== null && expiresMs - nowMs <= 300_000 ? 'expiring' : 'warm';
  }
  const price = record(root.cost)?.total_cost_usd;
  result.apiEquivalentUsd = finiteRange(price, 0, Number.MAX_VALUE);
  return result;
}

export function parseCodexEvents(values: readonly unknown[]): CacheSnapshot {
  const result = empty('codex', 'codex-rollout');
  let currentModel: string | null = null;
  for (const value of values) {
    const row = record(value);
    const payload = record(row?.payload);
    if (!row || !payload) continue;
    if (row.type === 'session_meta' && payload.type === 'session_meta') result.sessionId = string(payload.id) ?? result.sessionId;
    if (row.type === 'turn_context') currentModel = string(payload.model) ?? currentModel;
    if (row.type !== 'event_msg' || payload.type !== 'token_count') continue;
    const usage = record(record(payload.info)?.last_token_usage);
    if (!usage) continue;
    const total = count(usage.input_tokens);
    const read = count(usage.cached_input_tokens);
    const output = count(usage.output_tokens);
    const write = count(usage.cache_write_input_tokens);
    if (total === null && read === null && output === null && write === null) continue;
    result.model = currentModel;
    result.usage = {
      inputTokens: total, outputTokens: output,
      cacheReadTokens: read, cacheWriteTokens: write,
    };
    result.cache.requestHitRatio = requestHitRatio(read, total);
    result.observedAt = stamp(row.timestamp);
  }
  return result;
}

export function parseClaudeTranscriptEvents(values: readonly unknown[]): CacheSnapshot {
  const result = empty('claude-code', 'claude-transcript');
  for (const value of values) {
    const row = record(value);
    const message = record(row?.message);
    if (!row || row.type !== 'assistant' || !message) continue;
    const usage = record(message.usage);
    if (!usage) continue;
    const uncached = count(usage.input_tokens);
    const read = count(usage.cache_read_input_tokens);
    const write = count(usage.cache_creation_input_tokens);
    const output = count(usage.output_tokens);
    if (uncached === null && read === null && write === null && output === null) continue;
    result.sessionId = string(row.sessionId) ?? result.sessionId;
    result.model = string(message.model) ?? result.model;
    const total = totalInput(uncached, read, write);
    result.usage = {
      inputTokens: total, outputTokens: output,
      cacheReadTokens: read, cacheWriteTokens: write,
    };
    result.cache.requestHitRatio = requestHitRatio(read, total);
    result.observedAt = stamp(row.timestamp);
  }
  return result;
}

export interface TranscriptTail {
  values: unknown[];
  scope: 'complete' | 'partial';
  sourceBytes: number;
  readStartByte: number;
  tailBytesRead: number;
  retainedRecords: number;
  skippedRecords: number;
  /** Known complete lines omitted inside the read window by the 2,000-line cap. */
  droppedRecords: number;
  /** Null when the byte cap hides an unknown number of prior records. */
  unseenBeforeTailRecords: number | null;
}

export async function readTranscriptTailDetailed(file: string): Promise<TranscriptTail> {
  const before = await lstat(file);
  if (!before.isFile()) throw new Error('transcript must be a regular file');
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('transcript must be a regular file');
    const cap = 8 * 1024 * 1024;
    const start = Math.max(0, stat.size - cap);
    const size = Math.min(stat.size, cap);
    const buffer = Buffer.alloc(size);
    let bytesRead = 0;
    while (bytesRead < size) {
      const part = await handle.read(buffer, bytesRead, size - bytesRead, start + bytesRead);
      if (part.bytesRead === 0) break;
      bytesRead += part.bytesRead;
    }
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline < 0 ? '' : text.slice(firstNewline + 1);
    }
    const lastNewline = text.lastIndexOf('\n');
    const complete = lastNewline < 0 ? [] : text.slice(0, lastNewline).split('\n');
    const droppedRecords = Math.max(0, complete.length - 2000);
    const lines = complete.slice(-2000);
    const values: unknown[] = [];
    let skippedRecords = 0;
    for (const line of lines) {
      if (line.length > 1_000_000) { skippedRecords++; continue; }
      try { values.push(JSON.parse(line)); } catch { skippedRecords++; }
    }
    return {
      values,
      scope: start > 0 || droppedRecords > 0 || skippedRecords > 0 || lastNewline !== text.length - 1
        ? 'partial' : 'complete',
      sourceBytes: stat.size, readStartByte: start, tailBytesRead: bytesRead,
      retainedRecords: values.length, skippedRecords, droppedRecords,
      unseenBeforeTailRecords: start > 0 ? null : 0,
    };
  } finally {
    await handle.close();
  }
}

export async function readTranscriptTail(file: string): Promise<unknown[]> {
  return (await readTranscriptTailDetailed(file)).values;
}

export function renderCacheLine(snapshot: CacheSnapshot, nowMs = Date.now()): string {
  const parts: string[] = [];
  if (snapshot.model) parts.push(snapshot.model);
  if (snapshot.contextUsedPercent !== null) parts.push(`${Math.round(snapshot.contextUsedPercent)}% context`);
  let cache = `cache ${snapshot.cache.state}`;
  if ((snapshot.cache.state === 'warm' || snapshot.cache.state === 'expiring') && snapshot.cache.expiresAt) {
    const minutes = Math.max(0, Math.ceil((Date.parse(snapshot.cache.expiresAt) - nowMs) / 60_000));
    cache += ` ${minutes}m`;
  }
  parts.push(cache, 'warmer off');
  return parts.join(' · ');
}
