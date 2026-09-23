import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTranscriptTailDetailed, type TranscriptTail } from '../cache-status.js';
import { buildTokenReport, renderTokenReport } from '../token-report.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tail(values: unknown[]): TranscriptTail {
  return {
    values, scope: 'complete', sourceBytes: 100, readStartByte: 0, tailBytesRead: 100,
    retainedRecords: values.length, skippedRecords: 0, droppedRecords: 0, unseenBeforeTailRecords: 0,
  };
}

describe('session token report', () => {
  it('deduplicates Codex cumulative usage and attributes direct tool outputs', () => {
    const usage = { input_tokens: 100, output_tokens: 10, cached_input_tokens: 70, cache_write_input_tokens: 2 };
    const values = [
      { type: 'response_item', payload: { type: 'function_call', call_id: 'm1', name: 'mcp__mai_mcp__mai_search', arguments: 'private command' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'm1', output: 'MAI!' } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 's1', name: 'exec_command' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 's1', output: 'ok!' } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'e1', name: 'functions.exec' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'e1', output: 'outer' } },
      { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: { input_tokens: 100, output_tokens: 10 } } } },
      { type: 'token_usage_record', payload: { usage } },
      { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: usage, total_token_usage: { input_tokens: 100, output_tokens: 10 } } } },
      { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { ...usage, input_tokens: 20 }, total_token_usage: { input_tokens: 120, output_tokens: 20 } } } },
    ];
    const report = buildTokenReport('codex', tail(values));
    expect(report.schemaVersion).toBe(1);
    expect(report.requests.observed).toBe(2);
    expect(report.requests.inputTokens).toEqual({ total: 120, evidence: 'observed', missingRequests: 0 });
    expect(report.requests.cacheReadTokens.total).toBe(140);
    expect(report.toolResults.total).toBe(3);
    expect(report.toolResults.characters).toBe(12);
    expect(report.toolResults.charactersEvidence).toBe('proxy');
    expect(report.toolResults.byCategory.maiMcp.count).toBe(1);
    expect(report.toolResults.byCategory.shellTest.count).toBe(1);
    expect(report.toolResults.byCategory.unknown.count).toBe(1);
    expect(Object.values(report.toolResults.byCategory).reduce((sum, category) => sum + category.count, 0)).toBe(report.toolResults.total);
    expect(JSON.stringify(report)).not.toContain('private command');
    expect(JSON.stringify(report)).not.toContain('MAI!');
  });

  it('does not let invalid Codex usage consume a cumulative request key', () => {
    const report = buildTokenReport('codex', tail([
      { type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens: 10, output_tokens: 1, cached_input_tokens: 4, cache_write_input_tokens: 0 },
        total_token_usage: { input_tokens: 10, output_tokens: 1 },
      } } },
      { type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: {}, total_token_usage: { input_tokens: 20, output_tokens: 2 },
      } } },
      { type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens: 10, output_tokens: 1, cached_input_tokens: 4, cache_write_input_tokens: 0 },
        total_token_usage: { input_tokens: 20, output_tokens: 2 },
      } } },
    ]));
    expect(report.requests.observed).toBe(2);
    expect(report.requests.unknownUsageRecords).toBe(1);
    expect(report.requests.inputTokens).toEqual({ total: 20, evidence: 'observed', missingRequests: 0 });
    expect(report.requests.outputTokens).toEqual({ total: 2, evidence: 'observed', missingRequests: 0 });
  });

  it('deduplicates Claude assistant rows and keeps unmatched results unknown', () => {
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 30, cache_creation_input_tokens: 2 };
    const values = [
      { type: 'assistant', sessionId: 'private-session-id', message: { id: 'msg1', usage, content: [{ type: 'tool_use', id: 't1', name: 'mcp__mai_mcp__mai_prime' }] } },
      { type: 'assistant', message: { id: 'msg1', usage, content: [{ type: 'text', text: 'private prompt' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'memory' }] }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'abc' }] } },
    ];
    const report = buildTokenReport('claude', tail(values));
    expect(report.harness).toBe('claude-code');
    expect(report.requests.observed).toBe(1);
    expect(report.requests.inputTokens).toEqual({ total: 42, evidence: 'observed', missingRequests: 0 });
    expect(report.toolResults.total).toBe(2);
    expect(report.toolResults.characters).toBe(9);
    expect(report.toolResults.byCategory.maiMcp.count).toBe(1);
    expect(report.toolResults.byCategory.unknown.count).toBe(1);
    expect(JSON.stringify(report)).not.toContain('private-session-id');
    expect(JSON.stringify(report)).not.toContain('private prompt');
    expect(JSON.stringify(report)).not.toContain('memory');
  });

  it('marks an incomplete request metric unavailable instead of publishing a subtotal', () => {
    const report = buildTokenReport('codex', tail([
      { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 2 } } } },
      { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { output_tokens: 3 } } } },
    ]));
    expect(report.requests.inputTokens).toEqual({ total: null, evidence: 'unavailable', missingRequests: 1 });
    expect(report.requests.outputTokens).toEqual({ total: 5, evidence: 'observed', missingRequests: 0 });
    expect(report.requests.cacheWriteTokens).toEqual({ total: null, evidence: 'unavailable', missingRequests: 2 });
    expect(report.requests.countEvidence).toBe('observed');
    expect(report.toolResults.countEvidence).toBe('observed');
    expect(renderTokenReport(report)).toContain('Input tokens: unavailable (unavailable; 1 missing request(s))');
  });

  it('discloses the unknown pre-tail count and an incomplete final line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mai-token-report-test-')); dirs.push(dir);
    const file = join(dir, 'rollout.jsonl');
    writeFileSync(file, 'x'.repeat(8 * 1024 * 1024 + 10) + '\n' + JSON.stringify({ recent: true }) + '\n');
    const bounded = await readTranscriptTailDetailed(file);
    expect(bounded.values).toEqual([{ recent: true }]);
    expect(bounded.scope).toBe('partial');
    expect(bounded.readStartByte).toBeGreaterThan(0);
    expect(bounded.unseenBeforeTailRecords).toBeNull();
    expect(bounded.droppedRecords).toBe(0);
    expect(renderTokenReport(buildTokenReport('codex', bounded))).toContain('unknown count');
    writeFileSync(file, JSON.stringify({ complete: true }) + '\n' + '{partial');
    expect((await readTranscriptTailDetailed(file)).scope).toBe('partial');
    writeFileSync(file, JSON.stringify({ complete: true }) + '\n');
    expect((await readTranscriptTailDetailed(file)).scope).toBe('complete');
  });

  it('exposes aggregate JSON through the CLI and rejects unsupported flags', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mai-token-cli-test-')); dirs.push(dir);
    const file = join(dir, 'rollout.jsonl');
    writeFileSync(file, [
      { type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'exec_command' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'passed' } },
      { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: {
        input_tokens: 100, output_tokens: 10, cached_input_tokens: 80, cache_write_input_tokens: 0,
      } } } },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    const result = spawnSync('node', ['build/cli.js', 'tokens', 'report', '--host', 'codex', '--file', file, '--json'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.schemaVersion).toBe(1);
    expect(report.requests.observed).toBe(1);
    expect(report.requests.inputTokens).toEqual({ total: 100, evidence: 'observed', missingRequests: 0 });
    expect(report.toolResults.total).toBe(1);
    expect(report.toolResults.charactersEvidence).toBe('proxy');
    expect(result.stdout).not.toContain(file);
    expect(result.stdout).not.toContain('passed');
    const badHost = spawnSync('node', ['build/cli.js', 'tokens', 'report', '--host', 'wrong', '--file', file], { encoding: 'utf8' });
    expect(badHost.status).toBe(1);
    const badFlag = spawnSync('node', ['build/cli.js', 'tokens', 'report', '--host', 'codex', '--file', file, '--unexpected'], { encoding: 'utf8' });
    expect(badFlag.status).toBe(1);
  });
});
