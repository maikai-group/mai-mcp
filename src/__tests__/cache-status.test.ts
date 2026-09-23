import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseClaudeStatusline, parseCodexEvents, parseClaudeTranscriptEvents,
  readTranscriptTail, renderCacheLine,
} from '../cache-status.js';

const NOW = Date.parse('2026-09-22T18:00:00.000Z');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('cache status from observed host data', () => {
  it('reads Claude statusline counters and host-reported warmth without calling a model', () => {
    const input = {
      session_id: 's1', model: { display_name: 'Opus' },
      context_window: { used_percentage: 42.4, current_usage: {
        input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80,
        cache_creation_input_tokens: 10,
      } },
      prompt_cache: { warm: true, expires_at: NOW / 1000 + 120, hit_ratio: 0.8 },
      cost: { total_cost_usd: 1.25 }, prompt: 'private prompt must not appear',
    };
    const status = parseClaudeStatusline(input, NOW);
    expect(status.usage).toEqual({ inputTokens: 190, outputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 10 });
    expect(status.cache.requestHitRatio).toBeCloseTo(80 / 190);
    expect(status.cache.sessionHitRatio).toBe(0.8);
    expect(status.cache.state).toBe('expiring');
    expect(status.apiEquivalentUsd).toBe(1.25);
    expect(renderCacheLine(status, NOW)).toBe('Opus · 42% context · cache expiring 2m · warmer off');
    expect(JSON.stringify(status)).not.toContain('private prompt');
    expect(parseClaudeStatusline({ ...input, prompt_cache: { warm: true, expires_at: NOW / 1000 + 3600 } }, NOW).cache.state).toBe('warm');
    expect(parseClaudeStatusline({ ...input, prompt_cache: { warm: false } }, NOW).cache.state).toBe('cold');
  });

  it('keeps unsupported and invalid counters unknown', () => {
    const status = parseClaudeStatusline({
      context_window: { used_percentage: 101, current_usage: { input_tokens: -1, output_tokens: 2.5 } },
      prompt_cache: { hit_ratio: 2 }, cost: { total_cost_usd: -4 },
    }, NOW);
    expect(status.usage.inputTokens).toBeNull();
    expect(status.usage.outputTokens).toBeNull();
    expect(status.usage.cacheReadTokens).toBeNull();
    expect(status.contextUsedPercent).toBeNull();
    expect(status.cache).toEqual({ state: 'unknown', expiresAt: null, requestHitRatio: null, sessionHitRatio: null });
    expect(status.apiEquivalentUsd).toBeNull();
    expect(() => parseClaudeStatusline([], NOW)).toThrow('JSON object');
  });

  it('reads the last Codex request while leaving current warmth unknown', () => {
    const status = parseCodexEvents([
      { type: 'session_meta', payload: { type: 'session_meta', id: 'c1', cwd: '/private/repo' } },
      { type: 'turn_context', payload: { model: 'gpt-6-sol' } },
      { timestamp: '2026-09-22T18:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens: 200, output_tokens: 30, cached_input_tokens: 150, cache_write_input_tokens: 5 },
      } } },
    ]);
    expect(status.sessionId).toBe('c1');
    expect(status.model).toBe('gpt-6-sol');
    expect(status.usage.cacheReadTokens).toBe(150);
    expect(status.cache.requestHitRatio).toBe(0.75);
    expect(status.cache.sessionHitRatio).toBeNull();
    expect(status.cache.state).toBe('unknown');
    expect(status.apiEquivalentUsd).toBeNull();
    expect(JSON.stringify(status)).not.toContain('/private/repo');
  });

  it('uses Claude transcript usage without inferring warmth', () => {
    const status = parseClaudeTranscriptEvents([{ type: 'assistant', sessionId: 'a1',
      timestamp: '2026-09-22T18:00:00Z', message: { model: 'claude-opus', usage: {
        input_tokens: 50, output_tokens: 8, cache_read_input_tokens: 20,
        cache_creation_input_tokens: 10,
      }, content: 'private text' } }]);
    expect(status.usage.cacheReadTokens).toBe(20);
    expect(status.usage.inputTokens).toBe(80);
    expect(status.cache.requestHitRatio).toBe(0.25);
    expect(status.cache.state).toBe('unknown');
    expect(JSON.stringify(status)).not.toContain('private text');
  });

  it('keeps the last usable Codex request when a trailing usage object is empty', () => {
    const status = parseCodexEvents([
      { type: 'turn_context', payload: { model: 'first-model' } },
      { type: 'event_msg', timestamp: '2026-09-22T18:00:00Z', payload: { type: 'token_count',
        info: { last_token_usage: { input_tokens: 100, output_tokens: 5, cached_input_tokens: 80 } } } },
      { type: 'turn_context', payload: { model: 'later-model' } },
      { type: 'event_msg', timestamp: '2026-09-22T18:01:00Z', payload: { type: 'token_count',
        info: { last_token_usage: {} } } },
    ]);
    expect(status.usage).toEqual({ inputTokens: 100, outputTokens: 5, cacheReadTokens: 80, cacheWriteTokens: null });
    expect(status.cache.requestHitRatio).toBe(0.8);
    expect(status.model).toBe('first-model');
    expect(status.observedAt).toBe('2026-09-22T18:00:00.000Z');
  });

  it('keeps the last usable Claude request when a trailing usage object is invalid', () => {
    const status = parseClaudeTranscriptEvents([
      { type: 'assistant', sessionId: 'first-session', timestamp: '2026-09-22T18:00:00Z',
        message: { model: 'first-model', usage: { input_tokens: 20, output_tokens: 4,
          cache_read_input_tokens: 70, cache_creation_input_tokens: 10 } } },
      { type: 'assistant', sessionId: 'later-session', timestamp: '2026-09-22T18:01:00Z',
        message: { model: 'later-model', usage: { input_tokens: -1 } } },
    ]);
    expect(status.usage).toEqual({ inputTokens: 100, outputTokens: 4, cacheReadTokens: 70, cacheWriteTokens: 10 });
    expect(status.cache.requestHitRatio).toBe(0.7);
    expect(status.sessionId).toBe('first-session');
    expect(status.model).toBe('first-model');
    expect(status.observedAt).toBe('2026-09-22T18:00:00.000Z');
  });

  it('normalizes equivalent Claude and Codex input totals', () => {
    const claude = parseClaudeStatusline({ context_window: { current_usage: {
      input_tokens: 100, cache_read_input_tokens: 80, cache_creation_input_tokens: 10,
    } } }, NOW);
    const codex = parseCodexEvents([{ type: 'event_msg', payload: { type: 'token_count',
      info: { last_token_usage: { input_tokens: 190, cached_input_tokens: 80, cache_write_input_tokens: 10 } },
    } }]);
    expect(claude.usage.inputTokens).toBe(190);
    expect(codex.usage.inputTokens).toBe(190);
    expect(claude.cache.requestHitRatio).toBeCloseTo(codex.cache.requestHitRatio ?? -1);
  });

  it('rejects non-regular paths before opening them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mai-cache-path-test-')); dirs.push(dir);
    const link = join(dir, 'link');
    symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(readTranscriptTail(dir)).rejects.toThrow('regular file');
    await expect(readTranscriptTail(link)).rejects.toThrow('regular file');
  });

  it('reads only a bounded complete tail and skips malformed content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mai-cache-test-')); dirs.push(dir);
    const file = join(dir, 'rollout.jsonl');
    writeFileSync(file, JSON.stringify({ old: true }) + '\n' + 'x'.repeat(8 * 1024 * 1024) + '\n' +
      '{invalid}\n' + JSON.stringify({ recent: true }) + '\n' + '{partial');
    expect(await readTranscriptTail(file)).toEqual([{ recent: true }]);
  });
  it('CLI emits a JSON snapshot and a Claude statusline without DB access', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mai-cache-cli-test-')); dirs.push(dir);
    const file = join(dir, 'rollout.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'event_msg', timestamp: '2026-09-22T18:00:00Z',
      payload: { type: 'token_count', info: { last_token_usage: {
        input_tokens: 100, output_tokens: 10, cached_input_tokens: 70, cache_write_input_tokens: 2,
      } } } }) + '\n');
    const status = spawnSync('node', ['build/cli.js', 'cache', 'status', '--host', 'codex', '--file', file, '--json'], { encoding: 'utf8' });
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout).usage.cacheReadTokens).toBe(70);
    const bad = spawnSync('node', ['build/cli.js', 'cache', 'status', '--host', 'wrong', '--file', file], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    const line = spawnSync('node', ['build/cli.js', 'cache', 'statusline', '--host', 'claude'], {
      encoding: 'utf8', input: JSON.stringify({ model: { display_name: 'Opus' }, prompt_cache: { warm: true } }),
    });
    expect(line.status).toBe(0);
    expect(line.stdout.trim()).toBe('Opus · cache warm · warmer off');
    const jsonLine = spawnSync('node', ['build/cli.js', 'cache', 'statusline', '--host', 'claude', '--json'], {
      encoding: 'utf8', input: JSON.stringify({ cost: { total_cost_usd: 0.5 } }),
    });
    expect(JSON.parse(jsonLine.stdout).apiEquivalentUsd).toBe(0.5);
  });
});
