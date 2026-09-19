import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Assembling needs a CLEAN tree (Plan 32b Task 7): the assembler refuses a
 * working tree that is modified or untracked on any path it ships, because a
 * dirty tree has no identity. Tests therefore assemble from a clone of HEAD
 * with the in-flight task's shipped edits snapshotted on top as one throwaway
 * commit, so the clone is clean and its HEAD names exactly the bytes under
 * test. Only the shipped roots are copied — never stray untracked data. */
export interface ReleaseSnapshot {
  clone: string;
  assembler: string;
  head: string;
  env: NodeJS.ProcessEnv;
}

const SHIPPED_ROOTS = [
  'src', 'skills', 'skill-blocks', 'vendor', 'scripts', 'hooks', 'templates', 'frontend', 'db',
  '.claude/agents', 'release/public', 'installer', 'docs', '.github', 'package.json', 'package-lock.json',
  'tsconfig.json', 'docker-compose.yml', '.nvmrc', '.npmrc', '.gitattributes', 'vitest.config.ts',
];

export function snapshotRelease(tmp: string, root: string = path.resolve('.')): ReleaseSnapshot {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    npm_config_cache: path.join(tmp, 'npm-cache'),
  };
  const clone = path.join(tmp, 'clone');
  execFileSync('git', ['clone', '--quiet', root, clone]);
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', ...SHIPPED_ROOTS], {
    cwd: root, encoding: 'utf8',
  });
  for (const line of status.split('\n').filter(Boolean)) {
    const code = line.slice(0, 2);
    const rel = line.slice(3).split(' -> ').pop() ?? '';
    const source = path.join(root, rel);
    const target = path.join(clone, rel);
    if (code.includes('D') && !fs.existsSync(source)) {
      fs.rmSync(target, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  const gitIdentity = {
    ...env,
    GIT_AUTHOR_NAME: 'release-snapshot', GIT_AUTHOR_EMAIL: 'snapshot@mai-mcp.invalid',
    GIT_COMMITTER_NAME: 'release-snapshot', GIT_COMMITTER_EMAIL: 'snapshot@mai-mcp.invalid',
  };
  // Disposable clone: the broad add is confined to this throwaway snapshot.
  execFileSync('git', ['add', '--all'], { cwd: clone, env: gitIdentity });
  if (execFileSync('git', ['status', '--porcelain'], { cwd: clone, encoding: 'utf8' }).trim()) {
    execFileSync('git', ['commit', '--quiet', '-m', 'working-tree snapshot for the release gates'], { cwd: clone, env: gitIdentity });
  }
  // Hard-linked dependencies: a symlink would resolve outside the clone and
  // the bootstrap bundler refuses inputs that escape the checkout.
  const nodeModules = path.join(root, 'node_modules');
  execFileSync('rsync', ['-a', `--link-dest=${nodeModules}`, `${nodeModules}/`, `${path.join(clone, 'node_modules')}/`]);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: clone, encoding: 'utf8' }).trim();
  return { clone, assembler: path.join(clone, 'scripts', 'release-public.sh'), head, env };
}
