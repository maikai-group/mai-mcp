import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendMaiShadowRecord, findingCandidate, measureAndRecordMaiShadow, planCandidate,
  releaseMaiShadowLockIfOwned,
  readMaiShadowReport, renderMaiShadowReport,
} from '../token-mai-shadow.js';
import type { FindingShadowIdentity, MaiShadowRecord } from '../token-mai-shadow.js';
import type { ReadSection } from '../read-budget.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mai-read-shadow-test-'));
  dirs.push(root);
  return root;
}

const ids = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
];
const identities: FindingShadowIdentity[] = ids.map((id, index) => ({
  id, status: 'open', severity: 'blocker', title: `Title ${index}`, location: `src/file-${index}.ts:1`,
}));
const headlines = identities.map((row) => `- \`${row.id}\` [blocker/open] **${row.title}** · ${row.location}`);
const sections: ReadSection[] = [{ heading: '# Findings\n',
  fullRows: headlines.map((headline) => headline + '\n  issue: ' + 'body '.repeat(200)), headlineRows: headlines }];
const findingPointer = 'finding:"UUID[:part]"';
const candidate = `# Findings\n\n${headlines.join('\n')}\n\n_4/4 finding headlines shown; ${findingPointer}._`;
const header = `plan \`55555555-5555-4555-8555-555555555555\` [reviewing] my-plan\n`
  + `  path: docs/plan.md\n  sha: ${'a'.repeat(64)}\n`
  + '  findings: 1 open blocker(s), 0 open warning(s), 1 total';
const record: MaiShadowRecord = {
  schemaVersion: 1, at: '2026-09-22T00:00:00.000Z', tool: 'mai_findings',
  policyVersion: 1, kind: 'candidate', baselineChars: 1500, candidateChars: 500,
};

describe('MAI read shadow candidates', () => {
  it('keeps all four exact finding headlines and recovery guidance', () => {
    const draft = findingCandidate(sections, identities, 'x'.repeat(5000), candidate);
    expect(draft).toEqual({ kind: 'candidate', text: candidate });
    for (const id of ids) expect(candidate).toContain(id);
    expect(candidate).toContain(findingPointer);
    expect(findingCandidate(sections, identities, 'short', candidate)).toEqual({ kind: 'skip', reason: 'not-shorter' });
    expect(findingCandidate(sections, identities, 'x'.repeat(5000), candidate.slice(0, -1)))
      .toMatchObject({ kind: 'candidate' });
    expect(findingCandidate(sections, identities, 'x'.repeat(5000), candidate.replace(headlines[2], 'omitted')))
      .toEqual({ kind: 'skip', reason: 'missing-field' });
    expect(findingCandidate(sections, identities, 'x'.repeat(5000), candidate + 'x'.repeat(3000)))
      .toEqual({ kind: 'skip', reason: 'too-large' });
  });

  it('keeps plan identity and each shown review with exact pass recovery', () => {
    const reviews = [
      { pass: 1, verdict: 'blocked', reviewer: 'reviewer-a', planSha: '12345678' + 'b'.repeat(56), synthesis: 'long' },
      { pass: 2, verdict: 'approved', reviewer: 'reviewer-b', planSha: '12345678' + 'c'.repeat(56), synthesis: 'long' },
    ];
    const draft = planCandidate(header, reviews, header + 'body '.repeat(500));
    expect(draft.kind).toBe('candidate');
    if (draft.kind === 'candidate') {
      expect(draft.text).toContain('pass:"1"');
      expect(draft.text).toContain('pass:"2"');
      expect(draft.text).toContain('blocked');
      expect(draft.text).toContain('approved');
      expect(draft.text).toContain('docs/plan.md');
      expect(draft.text).toContain(reviews[0].planSha);
      expect(draft.text).toContain(reviews[1].planSha);
    }
    expect(planCandidate(header.replace('a'.repeat(64), 'null'), reviews, 'x'.repeat(3000)))
      .toEqual({ kind: 'skip', reason: 'missing-field' });
    expect(planCandidate(header, [{ ...reviews[0], planSha: null }], 'x'.repeat(3000)))
      .toEqual({ kind: 'skip', reason: 'missing-field' });
    expect(planCandidate(header, reviews, 'short')).toEqual({ kind: 'skip', reason: 'not-shorter' });
  });
});

describe('private MAI read shadow log', () => {
  it('round-trips aggregate-only rows, modes and malformed-line counts', async () => {
    const root = tempRoot();
    await appendMaiShadowRecord(root, record);
    await appendMaiShadowRecord(root, { ...record, tool: 'mai_plan', kind: 'skip', candidateChars: null, reason: 'not-shorter' });
    const file = join(root, 'mai-read.jsonl');
    if (typeof process.getuid === 'function') {
      expect(lstatSync(root).mode & 0o077).toBe(0);
      expect(lstatSync(file).mode & 0o077).toBe(0);
    }
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain(ids[0]);
    expect(raw).not.toContain('body');
    expect(raw).not.toContain('query');
    writeFileSync(file, raw + '{bad-json\n');
    const report = await readMaiShadowReport(root);
    expect(report).toMatchObject({ schemaVersion: 1, evidence: 'proxy', hypothetical: true,
      status: 'observed', ignoredRows: 1,
      byTool: { mai_findings: { attempts: 1, candidates: 1, baselineChars: 1500, candidateChars: 500 },
        mai_plan: { attempts: 1, skips: 1, baselineChars: 1500, candidateChars: 0 } } });
    expect(renderMaiShadowReport(report)).toContain('hypothetical character proxy');
    expect(await readMaiShadowReport(tempRoot())).toMatchObject({ status: 'unavailable' });
  });

  it('rejects a full file and a held lock without changing the delivered result', async () => {
    const root = tempRoot();
    await appendMaiShadowRecord(root, record);
    const file = join(root, 'mai-read.jsonl');
    writeFileSync(file, 'x'.repeat(2 * 1024 * 1024));
    await appendMaiShadowRecord(root, record);
    expect(lstatSync(file).size).toBe(2 * 1024 * 1024);
    expect(await readMaiShadowReport(root)).toMatchObject({ status: 'observed', ignoredRows: 1 });
    writeFileSync(join(root, 'mai-read.lock'), '', { mode: 0o600 });
    const delivered = { content: [{ type: 'text', text: 'Original reply' }] };
    await expect(measureAndRecordMaiShadow(root, 'mai_findings', delivered,
      { kind: 'skip', reason: 'not-shorter' }, '')).rejects.toThrow('busy');
    expect(delivered.content[0].text).toBe('Original reply');
    expect(lstatSync(join(root, 'mai-read.lock')).isFile()).toBe(true);
  });

  it('keeps a replacement lock when the original writer releases its own handle', async () => {
    const root = tempRoot();
    const path = join(root, 'mai-read.lock');
    writeFileSync(path, 'first', { mode: 0o600 });
    const first = lstatSync(path);
    renameSync(path, join(root, 'moved-first.lock'));
    writeFileSync(path, 'replacement', { mode: 0o600 });
    const replacement = lstatSync(path);
    await releaseMaiShadowLockIfOwned(path, first);
    expect(readFileSync(path, 'utf8')).toBe('replacement');
    await releaseMaiShadowLockIfOwned(path, replacement);
    expect(existsSync(path)).toBe(false);
  });

  it('serializes concurrent near-cap writers into complete bounded rows', async () => {
    const root = tempRoot();
    const line = `${JSON.stringify(record)}\n`;
    const max = 2 * 1024 * 1024;
    const count = Math.floor((max - line.length * 2) / line.length);
    writeFileSync(join(root, 'mai-read.jsonl'), line.repeat(count), { mode: 0o600 });
    const worker = `import { appendMaiShadowRecord } from './build/token-mai-shadow.js';
      const row = ${JSON.stringify(record)};
      try { await appendMaiShadowRecord(process.argv[1], row); } catch (error) {
        if (error.message !== 'MAI shadow log busy') process.exitCode = 1;
      }`;
    const runs = Array.from({ length: 6 }, () => new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', worker, root], { cwd: process.cwd() });
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    }));
    expect(await Promise.all(runs)).toEqual([0, 0, 0, 0, 0, 0]);
    const file = join(root, 'mai-read.jsonl');
    expect(lstatSync(file).size).toBeLessThanOrEqual(max);
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(lines.length).toBeGreaterThan(count);
    for (const item of lines) expect(JSON.parse(item)).toEqual(record);
  }, 10_000);
});

describe('built CLI MAI read shadow report', () => {
  function cli(root: string, args: string[]) {
    return spawnSync(process.execPath, ['build/cli.js', 'tokens', ...args], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, MAI_TOKEN_RECEIPTS_DIR: root },
    });
  }

  it('reports three aggregate-only rows, malformed input, and unavailable state', async () => {
    const root = tempRoot();
    const missing = cli(root, ['shadow-report', '--json']);
    expect(missing.status).toBe(0);
    expect(JSON.parse(missing.stdout)).toMatchObject({ schemaVersion: 1, evidence: 'proxy',
      hypothetical: true, status: 'unavailable' });
    const unsafe = tempRoot();
    writeFileSync(join(unsafe, 'target'), 'private');
    symlinkSync('target', join(unsafe, 'mai-read.jsonl'));
    const unsafeReport = cli(unsafe, ['shadow-report', '--json']);
    expect(unsafeReport.status).toBe(0);
    expect(JSON.parse(unsafeReport.stdout)).toMatchObject({ status: 'unavailable' });
    await appendMaiShadowRecord(root, record);
    await appendMaiShadowRecord(root, { ...record, tool: 'mai_plan', baselineChars: 2000,
      candidateChars: 900 });
    await appendMaiShadowRecord(root, { ...record, kind: 'skip', candidateChars: null,
      reason: 'not-shorter', baselineChars: 100 });
    const file = join(root, 'mai-read.jsonl');
    writeFileSync(file, readFileSync(file, 'utf8') + '{malformed\n');
    const json = cli(root, ['shadow-report', '--json']);
    expect(json.status).toBe(0);
    const report = JSON.parse(json.stdout);
    expect(report).toMatchObject({ status: 'observed', ignoredRows: 1,
      byTool: { mai_findings: { attempts: 2, candidates: 1, skips: 1,
        baselineChars: 1600, candidateChars: 500 },
      mai_plan: { attempts: 1, candidates: 1, skips: 0, baselineChars: 2000, candidateChars: 900 } } });
    expect(json.stdout).not.toContain(ids[0]);
    expect(json.stdout).not.toContain('body');
    const text = cli(root, ['shadow-report']);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('hypothetical character proxy');
    expect(text.stdout).toContain('no measured token or cost savings');
    expect(cli(root, ['shadow-report', 'extra']).status).not.toBe(0);
    expect(cli(root, ['shadow-report', '--unknown']).status).not.toBe(0);
  });
});
