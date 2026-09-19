import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import {
  decodeSource, SourceEvidence, SOURCE_FILE_BYTES, SOURCE_TOTAL_BYTES, SOURCE_CONCURRENCY,
} from '../graph/source-evidence.js';
import { listRepoFiles } from '../graph/walk.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const hash = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');
function fixture(files: Record<string, string | Buffer>) {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mai-source-evidence-')));
  dirs.push(repo);
  const git = (...args: string[]): string => execFileSync('git', [
    '-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  }
  git('add', '-A');
  return { repo, git, file: (rel: string) => path.join(repo, rel) };
}

describe('source evidence', () => {
  it('matches TypeScript decoding and keeps Node UTF-8 BOM semantics distinct', async () => {
    const text = 'export const café = "水";\n';
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    const be = Buffer.from(le).swap16();
    const cases = [Buffer.from(text), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]), le, be];
    const f = fixture(Object.fromEntries(cases.map((bytes, index) => [`${index}.ts`, bytes])));
    const source = new SourceEvidence([f.repo]);
    for (const [index, bytes] of cases.entries()) {
      const file = f.file(`${index}.ts`);
      expect(decodeSource(bytes, 'typescript')).toBe(ts.sys.readFile(file));
      expect(await source.read(file, 'typescript')).toEqual({ state: 'verified', hash: hash(text) });
      expect(await source.read(file, 'utf8')).toEqual({ state: 'verified', hash: hash(bytes.toString('utf8')) });
    }
  });

  it('reads once for hundreds of symbols and sees same-size edits on the next operation', async () => {
    const f = fixture({ 'a.ts': 'alpha' });
    const open = vi.spyOn(fs.promises, 'open');
    const source = new SourceEvidence([f.repo]);
    const results = await Promise.all(Array.from({ length: 400 }, () => source.read(f.file('a.ts'), 'typescript')));
    expect(results.every((result) => result.state === 'verified' && result.hash === hash('alpha'))).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    fs.writeFileSync(f.file('a.ts'), 'bravo');
    expect(await new SourceEvidence([f.repo]).read(f.file('a.ts'), 'typescript'))
      .toEqual({ state: 'verified', hash: hash('bravo') });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('uses tracked staged source in an unborn repo and preserves Unicode and leading spaces', async () => {
    const f = fixture({ 'café.ts': 'one', ' lead.ts': 'two', '.gitignore': 'ignored.ts\n' });
    fs.writeFileSync(f.file('untracked.ts'), 'three');
    fs.writeFileSync(f.file('ignored.ts'), 'four');
    const source = new SourceEvidence([f.repo]);
    expect((await source.census(f.repo)).files).toEqual(new Set([f.file('café.ts'), f.file(' lead.ts'), f.file('.gitignore')]));
    expect(await source.read(f.file('café.ts'), 'typescript')).toEqual({ state: 'verified', hash: hash('one') });
    for (const file of ['untracked.ts', 'ignored.ts']) {
      expect(await source.read(f.file(file), 'typescript')).toEqual({ state: 'removed', reason: 'untracked' });
    }
  });

  it('treats an index deletion as removed even while bytes remain on disk', async () => {
    const f = fixture({ 'a.ts': 'one' });
    f.git('rm', '--cached', 'a.ts');
    expect(fs.existsSync(f.file('a.ts'))).toBe(true);
    expect(await new SourceEvidence([f.repo]).read(f.file('a.ts'), 'typescript'))
      .toEqual({ state: 'removed', reason: 'untracked' });
  });

  it('does not open excluded files and partitions nested registered roots', async () => {
    const f = fixture({ 'outer.ts': 'one', 'nested/inner.ts': 'two', 'excluded.ts': 'private' });
    const nested = f.file('nested');
    const source = new SourceEvidence([f.repo, nested], [f.file('excluded.ts')]);
    const open = vi.spyOn(fs.promises, 'open');
    expect(await source.read(f.file('excluded.ts'), 'typescript')).toEqual({ state: 'unknown', reason: 'excluded' });
    expect(open).not.toHaveBeenCalled();
    expect((await source.census(f.repo)).files).toEqual(new Set([f.file('outer.ts')]));
    expect((await source.census(nested)).files).toEqual(new Set([f.file('nested/inner.ts')]));
  });

  it('fails closed for a corrupt Git index without falling back to untracked files', async () => {
    const f = fixture({ 'a.ts': 'one' });
    fs.writeFileSync(f.file('.git/index'), 'broken');
    expect(await new SourceEvidence([f.repo]).read(f.file('a.ts'), 'typescript'))
      .toEqual({ state: 'unknown', reason: 'git' });
    expect(() => listRepoFiles(f.repo, new Set(['.ts']))).toThrow('enumeration failed');
  });

  it('labels unresolved merge entries unknown', async () => {
    const f = fixture({ 'a.ts': 'base\n' });
    f.git('commit', '-qm', 'base');
    const branch = f.git('branch', '--show-current');
    f.git('checkout', '-qb', 'other');
    fs.writeFileSync(f.file('a.ts'), 'other\n');
    f.git('commit', '-qam', 'other');
    f.git('checkout', '-q', branch);
    fs.writeFileSync(f.file('a.ts'), 'main\n');
    f.git('commit', '-qam', 'main');
    expect(() => f.git('merge', 'other')).toThrow();
    expect(await new SourceEvidence([f.repo]).read(f.file('a.ts'), 'typescript'))
      .toEqual({ state: 'unknown', reason: 'conflict' });
  });

  it('rejects permission failures without returning source text', async () => {
    const f = fixture({ 'a.ts': 'private source' });
    vi.spyOn(fs.promises, 'open').mockRejectedValue(Object.assign(new Error('private source'), { code: 'EACCES' }));
    expect(await new SourceEvidence([f.repo]).read(f.file('a.ts'), 'typescript'))
      .toEqual({ state: 'unknown', reason: 'read' });
  });

  it.each(['mutate', 'replace'])('rejects a file that changes during open: %s', async (operation) => {
    const f = fixture({ 'a.ts': 'alpha' });
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (operation === 'replace') fs.renameSync(f.file('a.ts'), f.file('old.ts'));
      fs.writeFileSync(f.file('a.ts'), 'bravo');
      return handle;
    });
    expect(await new SourceEvidence([f.repo]).read(f.file('a.ts'), 'typescript'))
      .toEqual({ state: 'unknown', reason: 'race' });
  });

  it('enforces literal status limits and the shared byte budget', async () => {
    expect([SOURCE_FILE_BYTES, SOURCE_TOTAL_BYTES, SOURCE_CONCURRENCY]).toEqual([16777216, 134217728, 4]);
    const f = fixture({ 'a.ts': 'alpha', 'b.ts': 'bravo', 'large.ts': 'large' });
    fs.truncateSync(f.file('large.ts'), 16777217);
    expect(await new SourceEvidence([f.repo]).read(f.file('large.ts'), 'typescript'))
      .toEqual({ state: 'unknown', reason: 'size' });
    const source = new SourceEvidence([f.repo], [], { file: 10, total: 5 });
    expect((await source.read(f.file('a.ts'), 'typescript')).state).toBe('verified');
    expect(await source.read(f.file('b.ts'), 'typescript')).toEqual({ state: 'unknown', reason: 'budget' });
  });

  it('never keeps more than four descriptors open', async () => {
    const f = fixture(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${i}.ts`, 'alpha'])));
    const open = fs.promises.open.bind(fs.promises);
    let active = 0;
    let peak = 0;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      active++;
      peak = Math.max(peak, active);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); active--; });
      return handle;
    });
    const source = new SourceEvidence([f.repo]);
    const result = await Promise.all(Array.from({ length: 20 }, (_, i) => source.read(f.file(`${i}.ts`), 'typescript')));
    expect(result.every((row) => row.state === 'verified')).toBe(true);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    expect(active).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('refuses a symlink escape without opening the target', async () => {
    const f = fixture({ 'a.ts': 'alpha' });
    const other = fixture({ 'private.ts': 'private' });
    fs.unlinkSync(f.file('a.ts'));
    fs.symlinkSync(other.file('private.ts'), f.file('a.ts'));
    const open = vi.spyOn(fs.promises, 'open');
    expect((await new SourceEvidence([f.repo]).read(f.file('a.ts'), 'typescript')).state).not.toBe('verified');
    expect(open).not.toHaveBeenCalled();
  });
});
