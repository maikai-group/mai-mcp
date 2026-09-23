import { afterEach, expect, it, vi } from 'vitest';
import { captureNavigation, scoreTopK } from '../navigation/pilot.js';
import { normalizeInput } from '../navigation/input.js';
import { runNavigation } from '../navigation/service.js';
import { ProviderError } from '../navigation/provider.js';
import type { Batch, Evidence, Evaluate, Ports } from '../navigation/types.js';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, parsePilotCase, reserveReceipt } from '../scripts/navigation-pilot.js';
import type { PilotGitRead } from '../scripts/navigation-pilot.js';
import { MAI_ROOT } from '../paths.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const config = { key: 'pilot-secret-never-persist', model: 'jev-1.13.0' };
const input = normalizeInput({ intent: 'layout', question: 'Which caller needs the guard?' });
const a: Evidence = { id: 'a', kind: 'source', ref: 'caller.ts:1', text: 'caller invokes write',
  hash: 'hash-a', freshness: 'fixture', truncated: false };
const b: Evidence = { ...a, id: 'b', ref: 'other.ts:1', text: 'unrelated read', hash: 'hash-b' };
const empty = async (): Promise<Batch> => ({ evidence: [], gaps: [] });
const ports = (): Ports => ({ code: async () => ({ evidence: [b, a], gaps: [] }),
  memory: empty, seed: empty, source: empty, expand: empty });
const assess: Evaluate = async () => ({ model: config.model, choice: 'stop', confidence: 1,
  scores: { a: 0.9, b: 0.1 }, attempts: 1, inputTokens: 10, outputTokens: 2 });

it('captures exact evaluator inputs without changing the navigation report', async () => {
  let offered: readonly Evidence[] = [];
  const observed = vi.fn<Evaluate>().mockImplementation(async (...args) => {
    offered = structuredClone(args[1]);
    return assess(...args);
  });
  const signal = new AbortController().signal;
  const capture = await captureNavigation('live', input, config,
    { ports: ports(), evaluate: observed, now: Date.now }, signal);
  const ordinary = await runNavigation(input, config,
    { ports: ports(), evaluate: assess, now: Date.now }, signal);
  expect(capture.report).toEqual(ordinary);
  expect(capture.initialEvidence?.map(item => item.id)).toEqual(['b', 'a']);
  expect(capture.report.evidence.map(item => item.id)).toEqual(['a', 'b']);
  expect(capture.assessments[0]?.request.state.evidence).toEqual(offered);
  expect(capture.assessments[0]?.requestBytes).toBe(
    Buffer.byteLength(JSON.stringify(capture.assessments[0]?.request), 'utf8'));
  expect(JSON.stringify(capture)).not.toContain(config.key);
  expect(capture.unknownUsageAttempts).toBe(0);
  expect(capture.usageComplete).toBe(true);
});

it('prepares without calling the provider and records synthetic work explicitly', async () => {
  const evaluate = vi.fn<Evaluate>();
  const capture = await captureNavigation('prepare', input, config,
    { ports: ports(), evaluate, now: Date.now }, new AbortController().signal);
  expect(evaluate).not.toHaveBeenCalled();
  expect(capture.assessments).toHaveLength(1);
  expect(capture.assessments[0]?.synthetic).toBe(true);
  expect(capture.attemptedRequestBytes).toBe(0);
});

it('records unknown retry usage and only safe failure categories', async () => {
  const retried = await captureNavigation('live', input, config,
    { ports: ports(), now: Date.now,
      evaluate: async (...args) => ({ ...await assess(...args), attempts: 3 }) },
    new AbortController().signal);
  expect(retried.unknownUsageAttempts).toBe(2);
  expect(retried.usageComplete).toBe(false);
  expect(retried.attemptedRequestBytes).toBe((retried.assessments[0]?.requestBytes ?? 0) * 3);
  const failed = await captureNavigation('live', input, config,
    { ports: ports(), now: Date.now, evaluate: async () => { throw new ProviderError('auth', 1); } },
    new AbortController().signal);
  expect(failed.assessments[0]?.failure).toEqual({ code: 'auth', attempts: 1 });
  expect(failed.unknownUsageAttempts).toBe(1);
  expect(failed.usageComplete).toBe(false);
  expect(failed.report.status).toBe('partial');
  const secret = await captureNavigation('live', input, config,
    { ports: { ...ports(), code: async () => { throw Error(config.key); } },
      evaluate: assess, now: Date.now }, new AbortController().signal);
  expect(JSON.stringify(secret)).not.toContain(config.key);
  expect(secret.initialEvidence).toBeNull();
});

it('retains a partial cancelled capture without a fabricated baseline', async () => {
  const abort = new AbortController(); abort.abort();
  const evaluate = vi.fn<Evaluate>();
  const capture = await captureNavigation('live', input, config,
    { ports: ports(), evaluate, now: Date.now }, abort.signal);
  expect(capture.report.status).toBe('cancelled');
  expect(capture.initialEvidence).toBeNull();
  expect(evaluate).not.toHaveBeenCalled();
});

it('measures retrieval, including absent relevant items and abstention', () => {
  expect(scoreTopK(['a', 'b'], ['a', 'missing'])).toEqual({
    returned: 2, hits: 1, precision: 0.5, recall: 0.5 });
  expect(scoreTopK([], ['a'])).toEqual({ returned: 0, hits: 0, precision: 0, recall: 0 });
  expect(scoreTopK(['b'], [])).toEqual({ returned: 1, hits: 0, precision: 0, recall: null });
  expect(() => scoreTopK(['a', 'a'], ['a'])).toThrow('invalid ranking');
  expect(() => scoreTopK(['a'], ['a', 'a'])).toThrow('invalid ranking');
});

it('rejects hidden-label fields at both case and input boundaries', () => {
  const sample = { caseId: 'layout-one', sourceRevision: 'a'.repeat(40), input };
  expect(parsePilotCase(sample).input).toEqual(input);
  expect(() => parsePilotCase({ ...sample, expected: ['a'] })).toThrow();
  expect(() => parsePilotCase({ ...sample, input: { ...input, expected: ['a'] } })).toThrow();
  expect(() => parsePilotCase({ ...sample, sourceRevision: 'main' })).toThrow();
});

it('refuses absent live authorization before reading a file or invoking fetch', async () => {
  const http = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', http);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await main(['live', 'absent.json', 'absent-output'])).toBe(2);
  expect(await main([])).toBe(2);
  expect(http).not.toHaveBeenCalled();
});

it('reserves a new receipt exclusively and preserves existing data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-navigation-pilot-'));
  try {
    const out = path.join(root, 'run-one');
    const fd = reserveReceipt(out);
    try { fs.writeFileSync(fd, 'owned evidence'); } finally { fs.closeSync(fd); }
    expect(() => reserveReceipt(out)).toThrow();
    expect(fs.readFileSync(path.join(out, 'receipt.json'), 'utf8')).toBe('owned evidence');
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(out, 'receipt.json')).mode & 0o077).toBe(0);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it.each(['prepare', 'disabled', 'live', 'dirty', 'stale', 'missing-build',
  'worktree-dirty', 'index-dirty', 'untracked-source', 'git-unavailable',
  'build-lookup-failed', 'status-failed', 'wrong-revision-same-prefix'] as const)(
  'enforces the %s command boundary with isolated ports', async scenario => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-navigation-pilot-'));
    const evaluate = vi.fn<Evaluate>().mockImplementation(assess);
    const closePool = vi.fn<() => Promise<void>>().mockResolvedValue();
    const getProjectId = vi.fn<() => Promise<string>>().mockResolvedValue('project-fixture');
    const createPorts = vi.fn().mockImplementation(ports);
    const readGit = vi.fn<PilotGitRead>().mockImplementation(async (args, cwd) => {
      expect(cwd).toBe(MAI_ROOT);
      if (scenario === 'git-unavailable') throw Error('Git unavailable');
      if (args[0] === 'status') {
        expect(args).toEqual([
          'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none',
        ]);
        if (scenario === 'status-failed') throw Error('Git status failed');
        if (scenario === 'worktree-dirty') return ' M src/navigation/service.ts\0';
        if (scenario === 'index-dirty') return 'M  skills/write-plan/SKILL.md\0';
        if (scenario === 'untracked-source') return '?? src/navigation/untracked.ts\0';
        return '';
      }
      if (args.includes('HEAD^{commit}')) return 'a'.repeat(40) + '\n';
      expect(args).toEqual(['rev-parse', '--verify', '--end-of-options', 'aaaaaaa^{commit}']);
      if (scenario === 'build-lookup-failed') throw Error('Ambiguous build commit');
      return (scenario === 'stale' ? 'b' : 'a').repeat(40) + '\n';
    });
    const resolveJevConfig = vi.fn().mockResolvedValue(scenario === 'disabled'
      ? { state: 'disabled', reason: 'not_enabled' }
      : { state: 'ready', config, revision: 1, credentialSource: 'saved' });
    vi.doMock('../db.js', () => ({ getProjectId, closePool }));
    vi.doMock('../build-info.js', () => ({
      readBuildInfo: async () => scenario === 'missing-build' ? null : {
        version: 'fixture', sha: 'aaaaaaa', dirty: scenario === 'dirty',
        builtAt: '2026-09-21T00:00:00Z',
      },
    }));
    vi.doMock('../navigation/retrieval.js', () => ({ createPorts }));
    vi.doMock('../navigation/provider.js', () => ({ evaluate }));
    vi.doMock('../providers/runtime.js', () => ({ resolveJevConfig }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const file = path.join(root, 'case.json'), out = path.join(root, 'run');
      fs.writeFileSync(file, JSON.stringify({ caseId: 'layout-one',
        sourceRevision: scenario === 'wrong-revision-same-prefix'
          ? 'a'.repeat(7) + 'b'.repeat(33) : 'a'.repeat(40), input }));
      const args = scenario === 'prepare' ? ['prepare', file, out]
        : ['live', file, out, '--allow-live'];
      expect(await main(args, readGit)).toBe(scenario === 'prepare' || scenario === 'live' ? 0 : 2);
      expect(evaluate).toHaveBeenCalledTimes(scenario === 'live' ? 1 : 0);
      const sourceVerified = ['prepare', 'disabled', 'live'].includes(scenario);
      expect(closePool).toHaveBeenCalledTimes(sourceVerified ? 1 : 0);
      if (scenario === 'prepare' || scenario === 'live') {
        const text = fs.readFileSync(path.join(out, 'receipt.json'), 'utf8');
        expect(text).not.toContain(config.key);
        const receipt: unknown = JSON.parse(text);
        expect(receipt).toMatchObject({ caseId: 'layout-one', capture: { mode: scenario },
          sourceRevision: 'a'.repeat(40),
          sourceIdentity: { head: 'a'.repeat(40), buildCommit: 'a'.repeat(40), clean: true } });
      } else expect(fs.existsSync(out)).toBe(false);
      if (scenario === 'prepare') expect(resolveJevConfig).not.toHaveBeenCalled();
      if (!sourceVerified) {
        expect(getProjectId).not.toHaveBeenCalled();
        expect(createPorts).not.toHaveBeenCalled();
        expect(resolveJevConfig).not.toHaveBeenCalled();
      }
    } finally {
      for (const id of ['../db.js', '../build-info.js', '../navigation/retrieval.js',
        '../navigation/provider.js', '../providers/runtime.js']) vi.doUnmock(id);
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
