import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotRelease } from './support/release-snapshot.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const RELEASE_PUBLIC = path.join(ROOT, 'scripts', 'release-public.sh');
function releaseLayout(root: string): 'private' | 'public' {
  const assemblerExists = fs.existsSync(path.join(root, 'scripts', 'release-public.sh'));
  if (fs.existsSync(path.join(root, 'release', 'public')) && !assemblerExists) {
    throw new Error('private release assembler missing');
  }
  return assemblerExists ? 'private' : 'public';
}
const IS_PRIVATE_SOURCE = releaseLayout(ROOT) === 'private';
const names = ['mai-brain-web-start.sh', 'mai-brain-web-status.sh', 'mai-brain-web-stop.sh', 'mai-brain-web-launchd.sh'];
const templates = new Map<string, string>([
  ['mai-brain-web-start.sh', `#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -eq 0 ]; then
  ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
  exec node "$ROOT/build/entry.js" dashboard start
elif [ "$#" -eq 1 ] && [ "$1" = "--foreground" ]; then
  ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
  exec node "$ROOT/build/entry.js" dashboard run
else
  echo "usage: bash scripts/mai-brain-web-start.sh [--foreground]" >&2
  exit 2
fi
`],
  ['mai-brain-web-status.sh', `#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
exec node "$ROOT/build/entry.js" dashboard status
`],
  ['mai-brain-web-stop.sh', `#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
exec node "$ROOT/build/entry.js" dashboard stop
`],
  ['mai-brain-web-launchd.sh', `#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/build/entry.js" dashboard persist "$@"
`],
]);

function privateReleaseScriptEntries(source: string): string[] {
  const match = /for s in ([\s\S]*?)\ndo/u.exec(source);
  if (!match) return [];
  return match[1].replaceAll('\\\n', ' ').trim().split(/\s+/u);
}

export function assertPortableLifecycleClosure(
  source: string,
  wrappers: ReadonlyMap<string, string>,
  expectedTemplates: ReadonlyMap<string, string>,
): void {
  const entries = privateReleaseScriptEntries(source);
  const expected = ['mai-brain-web-start.sh', 'mai-brain-web-status.sh', 'mai-brain-web-stop.sh', 'mai-brain-web-launchd.sh'];
  const lifecycle = entries.filter(entry => /^mai-brain-web-(?:state|start|status|stop|launchd)\.sh$/u.test(entry));
  if (JSON.stringify(lifecycle) !== JSON.stringify(expected)) throw new Error('incorrect lifecycle copy set');
  if (entries.filter(entry => entry === 'check-roadmap-order.mjs').length !== 1) {
    throw new Error('release checker closure must contain check-roadmap-order.mjs exactly once');
  }
  assertLifecycleWrappers(wrappers, expectedTemplates);
}

function assertLifecycleWrappers(
  wrappers: ReadonlyMap<string, string>,
  expectedTemplates: ReadonlyMap<string, string>,
): void {
  for (const name of names) {
    const actual = wrappers.get(name);
    const template = expectedTemplates.get(name);
    if (actual === undefined || template === undefined || actual.replace(/\r\n/gu, '\n') !== template) {
      throw new Error(`incorrect lifecycle wrapper: ${name}`);
    }
  }
}

const temps: string[] = [];
afterEach(() => {
  for (const temp of temps.splice(0)) fs.rmSync(temp, { recursive: true, force: true });
});

function fixture(): { root: string; log: string; env: NodeJS.ProcessEnv } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-web-wrapper-'));
  temps.push(root);
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'build'));
  for (const name of names) fs.copyFileSync(path.join(ROOT, 'scripts', name), path.join(root, 'scripts', name));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(root, 'node-argv');
  const node = path.join(bin, 'node');
  fs.writeFileSync(node, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" > "$MAI_WRAPPER_LOG"\nexit 23\n', { mode: 0o755 });
  return { root, log, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, MAI_WRAPPER_LOG: log } };
}

function runWrapper(name: string, args: readonly string[] = []) {
  const test = fixture();
  const result = spawnSync('bash', [path.join(test.root, 'scripts', name), ...args], { env: test.env, encoding: 'utf8' });
  return { ...test, result, argv: fs.existsSync(test.log) ? fs.readFileSync(test.log, 'utf8').trim().split('\n') : [] };
}

function entryOf(root: string): string {
  return path.join(fs.realpathSync.native(root), 'build', 'entry.js');
}

function logicalEntryOf(root: string): string {
  const canonical = spawnSync('bash', ['-c', 'cd "$1" && pwd', 'bash', root], { encoding: 'utf8' });
  if (canonical.status !== 0) throw new Error('could not canonicalize wrapper fixture root');
  return path.join(canonical.stdout.trim(), 'build', 'entry.js');
}

describe('portable dashboard wrappers', () => {
  it('accepts the public layout and fails closed when a private assembler is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-release-layout-'));
    temps.push(root);
    expect(releaseLayout(root)).toBe('public');
    fs.mkdirSync(path.join(root, 'release', 'public'), { recursive: true });
    expect(() => releaseLayout(root)).toThrow('private release assembler missing');
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(path.join(root, 'scripts', 'release-public.sh'), '#!/usr/bin/env bash\n');
    expect(releaseLayout(root)).toBe('private');
  });

  it('keeps the dashboard launcher block identical and pins the replacement documentation', () => {
    const root = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const block = (source: string) => source.match(/<!-- dashboard-launcher:start -->[\s\S]*?<!-- dashboard-launcher:end -->/u)?.[0];
    if (IS_PRIVATE_SOURCE) {
      const published = fs.readFileSync(path.join(ROOT, 'release', 'public', 'README.md'), 'utf8');
      expect(block(root)).toBe(block(published));
    }
    expect(block(root)).toContain('`mai dashboard run`');
    expect(block(root)).toContain('(docs/configuration.md#dashboard)');

    const configuration = fs.readFileSync(path.join(ROOT, 'docs', 'configuration.md'), 'utf8');
    expect(configuration).toContain('mai dashboard run');
    expect(configuration).toContain('may require operator approval to bind `127.0.0.1`');
    expect(configuration).toContain('does not bypass its\nsandbox');
    expect(configuration).toContain('Every start, run, status and stop serializes state transactions through a per-user state lock owned by SQLite on a permanent private file. Owner death releases the OS lock without deleting that file. Readiness and shutdown waits release the state lock while a lifecycle reservation excludes replacement launches. An unavailable lock fails closed before reading or changing managed state.');
  });

  it('provides dashboard wrappers, persistence entries and test helpers in both layouts', () => {
    const wrappers = new Map(names.map(name => [name, fs.readFileSync(path.join(ROOT, 'scripts', name), 'utf8')]));
    expect(() => assertLifecycleWrappers(wrappers, templates)).not.toThrow();
    for (const name of ['check-roadmap-order.mjs', 'windows/install-dashboard.ps1',
      'plan-closure-lint.mjs', 'test-semantic-model-worker.mjs']) {
      expect(fs.statSync(path.join(ROOT, 'scripts', name)).isFile()).toBe(true);
    }
  });

  it.skipIf(!IS_PRIVATE_SOURCE)('ships the exact lifecycle and roadmap-checker closure from the private assembler', () => {
    const source = fs.readFileSync(RELEASE_PUBLIC, 'utf8');
    const wrappers = new Map(names.map(name => [name, fs.readFileSync(path.join(ROOT, 'scripts', name), 'utf8')]));
    expect(() => assertPortableLifecycleClosure(source, wrappers, templates)).not.toThrow();
    expect(() => assertPortableLifecycleClosure(source.replace('mai-brain-web-start.sh ', 'mai-brain-web-state.sh mai-brain-web-start.sh '), wrappers, templates)).toThrow();
    expect(() => assertPortableLifecycleClosure(source.replace('mai-brain-web-status.sh ', ''), wrappers, templates)).toThrow();
  });

  it('rejects a packaged delegate with the wrong dispatch verb', () => {
    const wrappers = new Map(names.map(name => [name, fs.readFileSync(path.join(ROOT, 'scripts', name), 'utf8')]));
    wrappers.set('mai-brain-web-status.sh', wrappers.get('mai-brain-web-status.sh')?.replace('dashboard status', 'dashboard start') ?? '');
    expect(() => assertLifecycleWrappers(wrappers, templates)).toThrow('incorrect lifecycle wrapper');
  });

  it('delegates bare start and rejects every other argument shape before node', () => {
    const clean = runWrapper('mai-brain-web-start.sh');
    expect(clean.result.status).toBe(23);
    expect(clean.argv).toEqual([entryOf(clean.root), 'dashboard', 'start']);
    for (const args of [['--bad'], ['--foreground', 'extra'], ['--foreground', '--foreground']]) {
      const invalid = runWrapper('mai-brain-web-start.sh', args);
      expect(invalid.result.status).toBe(2);
      expect(invalid.result.stderr).toBe('usage: bash scripts/mai-brain-web-start.sh [--foreground]\n');
      expect(invalid.argv).toEqual([]);
    }
  });

  it('delegates foreground start to dashboard run', () => {
    const test = runWrapper('mai-brain-web-start.sh', ['--foreground']);
    expect(test.result.status).toBe(23);
    expect(test.argv).toEqual([entryOf(test.root), 'dashboard', 'run']);
  });

  it('delegates status exactly', () => {
    const test = runWrapper('mai-brain-web-status.sh');
    expect(test.result.status).toBe(23);
    expect(test.argv).toEqual([entryOf(test.root), 'dashboard', 'status']);
  });

  it('delegates stop exactly', () => {
    const test = runWrapper('mai-brain-web-stop.sh');
    expect(test.result.status).toBe(23);
    expect(test.argv).toEqual([entryOf(test.root), 'dashboard', 'stop']);
  });

  it('delegates persistence actions exactly', () => {
    const test = runWrapper('mai-brain-web-launchd.sh', ['restart']);
    expect(test.result.status).toBe(23);
    expect(test.argv).toEqual([logicalEntryOf(test.root), 'dashboard', 'persist', 'restart']);
  });

  it.skipIf(!IS_PRIVATE_SOURCE)('assembles both persistence operator entries at their exact public paths', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-public-assembly-'));
    temps.push(parent);
    const output = path.join(parent, 'public');
    // Plan 32b Task 7: the assembler refuses a dirty tree, so assemble from a
    // clean snapshot clone (execution amendment A2).
    const snapshot = snapshotRelease(parent, ROOT);
    const result = spawnSync('bash', [snapshot.assembler, '--development-without-windows-receipt', output], {
      cwd: snapshot.clone,
      encoding: 'utf8',
      timeout: 180_000,
      env: snapshot.env,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.existsSync(path.join(output, 'scripts', 'mai-brain-web-launchd.sh'))).toBe(true);
    expect(fs.existsSync(path.join(output, 'scripts', 'windows', 'install-dashboard.ps1'))).toBe(true);
  }, 190_000);
});
