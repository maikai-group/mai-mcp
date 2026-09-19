/** Plan 15 Task 1: build identity — stamper, validated reader, restart banner,
 * source status, and the two-mode dispatcher. Fixture repos live in os.tmpdir;
 * the stdio case is DB-free by the mcp-v2-smoke pattern (unreachable port 1).
 * The stamper is dependency-free .mjs outside rootDir, so it is loaded through
 * a computed dynamic import and narrowed by a runtime guard — no casts. */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  readBuildInfo,
  buildRestartBanner,
  sourceBuildStatus,
} from '../build-info.js';
import type { BuildInfo } from '../build-info.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ENTRY = path.join(REPO_ROOT, 'build', 'entry.js');
const STAMPER_URL = new URL('../../scripts/stamp-build.mjs', import.meta.url).href;

interface GitIdentity {
  sha: string;
  dirty: boolean;
}
interface StampModule {
  CHECKOUT_ROOT: string;
  readPackageVersion(packageJsonPath: string): string;
  readGitIdentity(rootDir: string): GitIdentity;
  isValidBuildInfo(value: unknown): boolean;
  readPriorBuildInfo(file: string): BuildInfo | null;
  nextBuiltAt(args: {
    dirty: boolean;
    nowMs: number;
    sourceDateEpoch?: string;
    priorInfo?: BuildInfo | null;
  }): string;
  makeBuildInfo(
    rootDir: string,
    env?: Record<string, string | undefined>,
    nowMs?: number
  ): BuildInfo;
  writeBuildInfo(rootDir: string, info: BuildInfo): string;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isStampModule(value: unknown): value is StampModule {
  if (!isRecord(value)) return false;
  return (
    typeof value.CHECKOUT_ROOT === 'string' &&
    typeof value.readPackageVersion === 'function' &&
    typeof value.readGitIdentity === 'function' &&
    typeof value.isValidBuildInfo === 'function' &&
    typeof value.readPriorBuildInfo === 'function' &&
    typeof value.nextBuiltAt === 'function' &&
    typeof value.makeBuildInfo === 'function' &&
    typeof value.writeBuildInfo === 'function'
  );
}
async function loadStamper(): Promise<StampModule> {
  const specifier = STAMPER_URL;
  const loaded: unknown = await import(specifier);
  if (!isStampModule(loaded)) throw new Error('stamp-build.mjs exports are incomplete');
  return loaded;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Isolated repo shaped like the checkout: gitignored build/, tracked src. */
function makeGitFixture(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mai-build-info-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'plan15@test.invalid');
  git(dir, 'config', 'user.name', 'Plan 15 Fixture');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'fixture', version: '1.2.3' })}\n`
  );
  writeFileSync(path.join(dir, '.gitignore'), 'build/\n');
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'tracked.ts'), 'export const tracked = 1;\n');
  git(dir, 'add', 'package.json', '.gitignore', 'src/tracked.ts');
  git(dir, 'commit', '-q', '-m', 'fixture baseline');
  mkdirSync(path.join(dir, 'build'));
  return dir;
}

function tempFile(content: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mai-build-info-file-'));
  const file = path.join(dir, 'build-info.json');
  writeFileSync(file, content);
  return file;
}

const VALID: BuildInfo = {
  version: '1.2.3',
  sha: 'abc1234',
  dirty: false,
  builtAt: '2026-08-17T00:00:00.000Z',
};

function bannerLine(boot: BuildInfo, disk: BuildInfo): string {
  return (
    `⚠ mai-mcp: serving build ${boot.sha}@${boot.builtAt}; on disk is ` +
    `${disk.sha}@${disk.builtAt} — restart Claude Code/Codex to activate the new MCP surface.`
  );
}

describe('build-info reader', () => {
  it('case 1: valid JSON round-trips', async () => {
    const file = tempFile(`${JSON.stringify(VALID, null, 2)}\n`);
    expect(await readBuildInfo(file)).toEqual(VALID);
  });

  it('case 2: malformed JSON is null', async () => {
    expect(await readBuildInfo(tempFile('{not json'))).toBeNull();
  });

  it('case 3: missing file is null', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mai-build-info-missing-'));
    expect(await readBuildInfo(path.join(dir, 'nope.json'))).toBeNull();
  });

  it('case 4: wrong field type, invalid date, and extra keys are null', async () => {
    expect(
      await readBuildInfo(tempFile(JSON.stringify({ ...VALID, dirty: 'yes' })))
    ).toBeNull();
    expect(
      await readBuildInfo(tempFile(JSON.stringify({ ...VALID, builtAt: 'not-a-date' })))
    ).toBeNull();
    expect(
      await readBuildInfo(tempFile(JSON.stringify({ ...VALID, extra: true })))
    ).toBeNull();
    const { builtAt: _dropped, ...missing } = VALID;
    expect(await readBuildInfo(tempFile(JSON.stringify(missing)))).toBeNull();
  });
});

describe('restart banner', () => {
  it('case 5: identical boot/disk has no banner', async () => {
    const file = tempFile(`${JSON.stringify(VALID)}\n`);
    expect(await buildRestartBanner(VALID, file)).toBeNull();
  });

  it('case 6: differing sha yields the exact banner', async () => {
    const disk: BuildInfo = { ...VALID, sha: 'def5678' };
    const file = tempFile(`${JSON.stringify(disk)}\n`);
    expect(await buildRestartBanner(VALID, file)).toBe(bannerLine(VALID, disk));
  });

  it('case 7: differing builtAt at the same sha yields the exact banner', async () => {
    const disk: BuildInfo = { ...VALID, builtAt: '2026-08-17T00:00:01.000Z' };
    const file = tempFile(`${JSON.stringify(disk)}\n`);
    expect(await buildRestartBanner(VALID, file)).toBe(bannerLine(VALID, disk));
  });

  it('boot or disk invalid yields no banner', async () => {
    expect(await buildRestartBanner(null, tempFile(JSON.stringify(VALID)))).toBeNull();
    expect(await buildRestartBanner(VALID, tempFile('{broken'))).toBeNull();
  });
});

describe('stamper', () => {
  it('case 8: a .git-less checkout stamps sha unknown and clean', async () => {
    const stamper = await loadStamper();
    const dir = mkdtempSync(path.join(os.tmpdir(), 'mai-build-info-nogit-'));
    expect(stamper.readGitIdentity(dir)).toEqual({ sha: 'unknown', dirty: false });
  });

  it('rejects a malformed package and a non-numeric epoch', async () => {
    const stamper = await loadStamper();
    const noVersion = tempFile(JSON.stringify({ name: 'x' }));
    expect(() => stamper.readPackageVersion(noVersion)).toThrow(/no valid version/);
    expect(() =>
      stamper.nextBuiltAt({ dirty: false, nowMs: 0, sourceDateEpoch: 'soon' })
    ).toThrow(/SOURCE_DATE_EPOCH/);
  });

  it('case 9: SOURCE_DATE_EPOCH makes two clean builds deterministic', async () => {
    const stamper = await loadStamper();
    const fixture = makeGitFixture();
    const env = { SOURCE_DATE_EPOCH: '1700000000' };
    const first = stamper.makeBuildInfo(fixture, env, 1_000);
    const second = stamper.makeBuildInfo(fixture, env, 2_000);
    expect(first.builtAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(second.builtAt).toBe(first.builtAt);
    expect(first.dirty).toBe(false);
    expect(first.version).toBe('1.2.3');
  });

  it('case 11: an untracked src file is dirty; the clean checkout is not', async () => {
    const stamper = await loadStamper();
    const fixture = makeGitFixture();
    expect(stamper.readGitIdentity(fixture).dirty).toBe(false);
    writeFileSync(path.join(fixture, 'src', 'untracked.ts'), 'export const u = 1;\n');
    expect(stamper.readGitIdentity(fixture).dirty).toBe(true);
  });

  it('case 14: sequential clean/dirty builds at one HEAD get distinct identities and exact banners', async () => {
    const stamper = await loadStamper();
    const fixture = makeGitFixture();
    const stampPath = path.join(fixture, 'build', 'build-info.json');
    const env = { SOURCE_DATE_EPOCH: '1700000000' };

    const clean = stamper.makeBuildInfo(fixture, env, Date.now());
    expect(clean.dirty).toBe(false);
    stamper.writeBuildInfo(fixture, clean);

    appendFileSync(path.join(fixture, 'src', 'tracked.ts'), 'export const edited = 2;\n');
    const dirtyTracked = stamper.makeBuildInfo(fixture, env, Date.now());
    expect(dirtyTracked.dirty).toBe(true);
    expect(dirtyTracked.sha).toBe(clean.sha);
    expect(Date.parse(dirtyTracked.builtAt)).toBeGreaterThan(Date.parse(clean.builtAt));
    stamper.writeBuildInfo(fixture, dirtyTracked);
    expect(await buildRestartBanner(clean, stampPath)).toBe(bannerLine(clean, dirtyTracked));

    git(fixture, 'checkout', '--', 'src/tracked.ts');
    writeFileSync(path.join(fixture, 'src', 'untracked.ts'), 'export const u = 3;\n');
    const dirtyUntracked = stamper.makeBuildInfo(fixture, env, Date.now());
    expect(dirtyUntracked.dirty).toBe(true);
    expect(dirtyUntracked.sha).toBe(clean.sha);
    expect(Date.parse(dirtyUntracked.builtAt)).toBeGreaterThan(
      Date.parse(dirtyTracked.builtAt)
    );
    stamper.writeBuildInfo(fixture, dirtyUntracked);
    expect(await buildRestartBanner(dirtyTracked, stampPath)).toBe(
      bannerLine(dirtyTracked, dirtyUntracked)
    );

    const values = new Set([clean.builtAt, dirtyTracked.builtAt, dirtyUntracked.builtAt]);
    expect(values.size).toBe(3);
  });
});

describe('source build status', () => {
  it('case 10: matching, mismatching, and unknown shas report correctly', async () => {
    const fixture = makeGitFixture();
    const head = git(fixture, 'rev-parse', '--short', 'HEAD');

    const current = await sourceBuildStatus({ ...VALID, sha: head }, fixture);
    expect(current.stale).toBe(false);
    expect(current.fingerprint).toContain(head);

    const behind = await sourceBuildStatus({ ...VALID, sha: '0000000' }, fixture);
    expect(behind.stale).toBe(true);
    expect(behind.detail).toBe('build is behind source — run npm run build');

    const unknown = await sourceBuildStatus({ ...VALID, sha: 'unknown' }, fixture);
    expect(unknown.stale).toBe(false);
  });
});

interface InitializeResponse {
  id: number;
  serverName: string;
}
function parseInitializeResponse(line: string): InitializeResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.id !== 'number' || !('result' in parsed)) return null;
  const result: unknown = parsed.result;
  if (!isRecord(result) || !('serverInfo' in result)) return null;
  const serverInfo: unknown = result.serverInfo;
  if (!isRecord(serverInfo) || typeof serverInfo.name !== 'string') return null;
  return { id: parsed.id, serverName: serverInfo.name };
}

describe('dispatcher', () => {
  it('case 12: entry with --help selects the CLI without MAI_PROJECT_SLUG', () => {
    const stdout = execFileSync(process.execPath, [ENTRY, '--help'], {
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(stdout).toContain('Usage: mai <command>');
  }, 30_000);

  it('case 13: no-verb entry serves one bounded real MCP stdio initialize', async () => {
    const child = spawn(process.execPath, [ENTRY], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '',
        MAI_PROJECT_SLUG: 'plan15-entry',
        MAI_DB_URL: 'postgresql://postgres:postgres@127.0.0.1:1/unreachable',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });

    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'plan15-entry-test', version: '0.0.0' },
      },
    };
    child.stdin.write(`${JSON.stringify(request)}\n`);

    const deadline = Date.now() + 10_000;
    const responses = (): InitializeResponse[] =>
      stdout
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map(parseInitializeResponse)
        .filter((entry): entry is InitializeResponse => entry !== null);
    while (responses().length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Duplicate-start window: a second serveStdio would answer id 1 twice.
    await new Promise((resolve) => setTimeout(resolve, 400));

    const seen = responses();
    child.stdin.end();
    const exitTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    const exitCode = await exited;
    clearTimeout(exitTimer);

    expect(seen.length).toBe(1);
    expect(seen[0].id).toBe(1);
    expect(seen[0].serverName).toBe('mai-mcp');
    expect(stderr).toContain("serving project 'plan15-entry' on stdio");
    expect(stdout).not.toContain('Usage: mai <command>');
    expect(exitCode).not.toBeNull();
  }, 30_000);
});

function hashTreeFiles(dir: string): Map<string, string> {
  const hashes = new Map<string, string>();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    const relative = path.relative(dir, full);
    hashes.set(relative, createHash('sha256').update(readFileSync(full)).digest('hex'));
  }
  return hashes;
}
function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[A-Za-z]|\u001bc/g, '');
}

describe('dev watcher', () => {
  it('case 15: npm run dev is a non-emitting typecheck watch', async () => {
    const packageRaw: unknown = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')
    );
    if (!isRecord(packageRaw) || !isRecord(packageRaw.scripts)) {
      throw new Error('package.json scripts missing');
    }
    const devScript = packageRaw.scripts.dev;
    if (typeof devScript !== 'string') throw new Error('dev script missing');
    expect(devScript).toBe('tsc --watch --noEmit');
    expect(devScript.startsWith('tsc ')).toBe(true);
    const devArgs = devScript.split(/\s+/).slice(1);

    const fixture = mkdtempSync(path.join(os.tmpdir(), 'mai-dev-watch-'));
    mkdirSync(path.join(fixture, 'src'));
    mkdirSync(path.join(fixture, 'build'));
    writeFileSync(path.join(fixture, 'src', 'a.ts'), 'export const a: number = 1;\n');
    writeFileSync(
      path.join(fixture, 'tsconfig.json'),
      `${JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          outDir: './build',
          rootDir: './src',
        },
        include: ['src/**/*'],
      })}\n`
    );
    writeFileSync(path.join(fixture, 'build', 'a.js'), '// pre-existing stale output\n');
    writeFileSync(
      path.join(fixture, 'build', 'build-info.json'),
      `${JSON.stringify(VALID, null, 2)}\n`
    );
    const before = hashTreeFiles(path.join(fixture, 'build'));

    const tscBin = path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    const child = spawn(process.execPath, [tscBin, ...devArgs], {
      cwd: fixture,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '' },
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      output += chunk;
    });
    const exited = new Promise<void>((resolve) => {
      child.on('exit', () => resolve());
    });
    const cycles = (): number => {
      const matches = stripAnsi(output).match(/Found \d+ error/g);
      return matches === null ? 0 : matches.length;
    };
    const waitForCycles = async (count: number): Promise<void> => {
      const deadline = Date.now() + 45_000;
      while (cycles() < count) {
        if (Date.now() > deadline) {
          child.kill('SIGKILL');
          throw new Error(`watch cycle ${count} not reached; output: ${stripAnsi(output)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };

    try {
      await waitForCycles(1);
      appendFileSync(path.join(fixture, 'src', 'a.ts'), 'export const b: number = 2;\n');
      await waitForCycles(2);
      appendFileSync(path.join(fixture, 'src', 'a.ts'), 'export const c: number = 3;\n');
      await waitForCycles(3);
    } finally {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(killTimer);
    }

    const after = hashTreeFiles(path.join(fixture, 'build'));
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [file, hash] of before) {
      expect(after.get(file)).toBe(hash);
    }
  }, 120_000);
});

describe('budgeted restart banner (plan 38)', () => {
  const info = (sha: string, builtAt: string): BuildInfo =>
    ({ version: '0.15.1', sha, dirty: false, builtAt });

  it('renders two 12-char SHAs and two ordinary timestamps at exactly 173 chars', async () => {
    const { renderRestartBanner, RESTART_BANNER_MAX } = await import('../build-info.js');
    expect(RESTART_BANNER_MAX).toBe(173);
    const banner = renderRestartBanner(
      info('a'.repeat(12), '2026-08-27T12:34:56.000Z'),
      info('b'.repeat(12), '2026-08-26T01:02:03.000Z'),
      true,
    );
    expect(banner).not.toBeNull();
    expect(banner).toHaveLength(RESTART_BANNER_MAX);
    expect(banner).toContain('restart Claude Code/Codex');
    expect(banner).toContain('2026-08-27T12:34:56.000Z');   // byte-complete ISO
    expect(banner).toContain('aaaaaaaaaaaa@');
  });

  it('ellipsizes an arbitrarily long SHA and stays truthful within the maximum', async () => {
    const { renderRestartBanner, RESTART_BANNER_MAX, boundedBuildSha } = await import('../build-info.js');
    const long = 'c'.repeat(400);
    expect(boundedBuildSha(long)).toBe(`${'c'.repeat(6)}…${'c'.repeat(5)}`);
    expect(boundedBuildSha('0123456789ab')).toBe('0123456789ab');   // 12 is byte-complete
    const banner = renderRestartBanner(
      info(long, '2026-08-27T12:34:56.000Z'),
      info('d'.repeat(80), '2026-08-26T01:02:03.000Z'),
      true,
    );
    expect(banner).not.toBeNull();
    expect((banner ?? '').length).toBeLessThanOrEqual(RESTART_BANNER_MAX);
    expect(banner).toContain('…');
    expect(banner).toContain('restart Claude Code/Codex');
  });

  it('renders accepted expanded-year timestamps as exact signed epoch milliseconds', async () => {
    const { renderRestartBanner, RESTART_BANNER_MAX, boundedBuildTime } = await import('../build-info.js');
    const positive = '+010000-01-01T00:00:00.000Z';
    const negative = '-000001-01-01T12:34:00.000Z';
    expect(new Date(positive).toISOString()).toHaveLength(27);
    expect(boundedBuildTime(positive)).toBe(`${new Date(positive).getTime()}ms`);
    expect(boundedBuildTime(negative)).toBe(`${new Date(negative).getTime()}ms`);
    expect(boundedBuildTime(positive).endsWith('ms')).toBe(true);
    expect(boundedBuildTime(negative).startsWith('-')).toBe(true);
    // The compact identity is SHORTER than the 27-char canonical counterexample.
    expect(boundedBuildTime(positive).length).toBeLessThan(27);
    expect(boundedBuildTime(negative).length).toBeLessThan(27);
    expect(boundedBuildTime('2026-08-27T12:34:56.000Z')).toBe('2026-08-27T12:34:56.000Z');

    const banner = renderRestartBanner(
      info('e'.repeat(12), positive), info('f'.repeat(12), negative), true);
    expect(banner).not.toBeNull();
    expect((banner ?? '').length).toBeLessThanOrEqual(RESTART_BANNER_MAX);
    expect(banner).toContain('ms;');
    expect(banner).toContain('restart Claude Code/Codex');
  });

  it('keeps the unbudgeted banner byte-identical and the raw equality check intact', async () => {
    const { renderRestartBanner } = await import('../build-info.js');
    const boot = info('a'.repeat(400), '+010000-01-01T00:00:00.000Z');
    const disk = info('b'.repeat(400), '2026-08-26T01:02:03.000Z');
    expect(renderRestartBanner(boot, disk, false)).toBe(
      `⚠ mai-mcp: serving build ${boot.sha}@${boot.builtAt}; on disk is ` +
      `${disk.sha}@${disk.builtAt} — restart Claude Code/Codex to activate the new MCP surface.`
    );
    // Compaction cannot hide a changed build: equality is decided on RAW values,
    // and two identities that only DISPLAY alike still produce a banner.
    expect(renderRestartBanner(boot, boot, true)).toBeNull();
    const twin = info(`${'a'.repeat(6)}zzzzz${'a'.repeat(389)}`, boot.builtAt);
    expect(renderRestartBanner(boot, twin, true)).not.toBeNull();
  });
});
