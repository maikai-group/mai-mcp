/**
 * Capture-adapter registry + Claude Code adapter. DB-free: install writes to a
 * tmp dir; parseTranscript uses the shared fixture; no Postgres touched.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

describe('getCaptureAdapter', () => {
  it('returns the claude-code adapter', async () => {
    const { getCaptureAdapter } = await import('../capture/adapter.js');
    const a = getCaptureAdapter('claude-code');
    expect(a.harness).toBe('claude-code');
  });

  it('lists supported harnesses', async () => {
    const { listCaptureAdapters } = await import('../capture/adapter.js');
    const list = listCaptureAdapters();
    expect(list).toContain('claude-code');
    expect(list).toContain('codex');
    expect(list).toContain('generic');
    expect(list.length).toBeGreaterThanOrEqual(1);
  });

  it('throws on an unknown harness, naming the supported ones', async () => {
    const { getCaptureAdapter } = await import('../capture/adapter.js');
    expect(() => getCaptureAdapter('nonsense')).toThrowError(/claude-code/);
  });
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-capture-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('ClaudeCodeAdapter.install', () => {
  it('wires mcp + hooks + CLAUDE.md and is idempotent', async () => {
    const { getCaptureAdapter } = await import('../capture/adapter.js');
    const { GRADUATED_SENTINEL } = await import('../rules-render.js');
    const a = getCaptureAdapter('claude-code');

    const first = await a.install(tmp, 'capture-test');
    expect(first.harness).toBe('claude-code');
    expect(fs.existsSync(path.join(tmp, '.mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, '.claude', 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'CLAUDE.md'))).toBe(true);
    // first run: nothing pre-existing → each line reports created/updated (not "unchanged")
    expect(first.lines.every((l) => !l.endsWith('unchanged'))).toBe(true);
    expect(fs.readFileSync(path.join(tmp, 'CLAUDE.md'), 'utf8')).toContain(GRADUATED_SENTINEL);

    const second = await a.install(tmp, 'capture-test');
    // second run: everything already present → all unchanged
    expect(second.lines).toEqual([
      '.mcp.json unchanged',
      'hooks unchanged',
      'CLAUDE.md unchanged',
      'CLAUDE.md graduated-rules unchanged',
    ]);
  });
});

describe('ClaudeCodeAdapter.detect', () => {
  it('reports installed after install, and not-installed on a bare dir', async () => {
    const { getCaptureAdapter } = await import('../capture/adapter.js');
    const a = getCaptureAdapter('claude-code');
    const installedStatus = await a.detect(tmp); // tmp was wired in the previous describe
    expect(installedStatus.installed).toBe(true);

    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-bare-'));
    const bareStatus = await a.detect(bare);
    expect(bareStatus.installed).toBe(false);
    fs.rmSync(bare, { recursive: true, force: true });
  });
});

describe('ClaudeCodeAdapter.parseTranscript', () => {
  it('parses the shared fixture into a ParsedSession', async () => {
    const { getCaptureAdapter } = await import('../capture/adapter.js');
    const a = getCaptureAdapter('claude-code');
    const parsed = await a.parseTranscript(
      fileURLToPath(new URL('./fixtures/sample-session.jsonl', import.meta.url))
    );
    expect(parsed.messageCount).toBeGreaterThan(0);
    expect(parsed.toolCalls).toBeGreaterThan(0);
  });
});
