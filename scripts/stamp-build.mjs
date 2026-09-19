// Post-tsc build fingerprint writer (Plan 15 Task 1). Dependency-free ESM:
// stamps build/build-info.json with {version,sha,dirty,builtAt} so a running
// process can detect that the on-disk build changed underneath it.
//
// Untracked files participate in `dirty` because tsconfig.json compiles
// src/**/* whether or not git tracks it. Dirty builds deliberately ignore
// SOURCE_DATE_EPOCH and take max(now, prior builtAt + 1ms) so two sequential
// dirty builds at one HEAD can never share a (sha,builtAt) activation
// identity; clean builds honor the epoch for reproducible release output.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CHECKOUT_ROOT = join(HERE, '..');

const CHILD_LIMITS = { timeout: 15_000, maxBuffer: 1024 * 1024 };

export function readPackageVersion(packageJsonPath) {
  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof parsed.version !== 'string' ||
    parsed.version.length === 0
  ) {
    throw new Error(`no valid version string in ${packageJsonPath}`);
  }
  return parsed.version;
}

export function readGitIdentity(rootDir) {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...CHILD_LIMITS,
    }).trim();
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...CHILD_LIMITS,
    });
    if (sha.length === 0) return { sha: 'unknown', dirty: false };
    return { sha, dirty: status.trim().length > 0 };
  } catch {
    // Missing .git or failed git command — never a stamping failure.
    return { sha: 'unknown', dirty: false };
  }
}

/** Same strictness as src/build-info.ts: exactly four fields, exact types,
 * parseable ISO timestamp. Duplicated by necessity — this script must stay
 * dependency-free and cannot import the compiled reader's env/dotenv chain. */
export function isValidBuildInfo(value) {
  if (typeof value !== 'object' || value === null) return false;
  if (Object.keys(value).sort().join(',') !== 'builtAt,dirty,sha,version') return false;
  return (
    typeof value.version === 'string' &&
    value.version.length > 0 &&
    typeof value.sha === 'string' &&
    value.sha.length > 0 &&
    typeof value.dirty === 'boolean' &&
    typeof value.builtAt === 'string' &&
    Number.isFinite(Date.parse(value.builtAt))
  );
}

export function readPriorBuildInfo(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return isValidBuildInfo(parsed) ? parsed : null;
}

export function nextBuiltAt({ dirty, nowMs, sourceDateEpoch, priorInfo }) {
  if (!dirty) {
    if (sourceDateEpoch !== undefined) {
      const epoch = Number(sourceDateEpoch);
      if (typeof sourceDateEpoch !== 'string' || sourceDateEpoch.trim() === '' || !Number.isFinite(epoch)) {
        throw new Error(`SOURCE_DATE_EPOCH is not numeric: ${String(sourceDateEpoch)}`);
      }
      return new Date(epoch * 1000).toISOString();
    }
    return new Date(nowMs).toISOString();
  }
  // A missing/malformed prior stamp supplies no lower bound; it never turns a
  // malformed new value into success.
  const priorMs = priorInfo !== null && priorInfo !== undefined ? Date.parse(priorInfo.builtAt) : Number.NaN;
  const floor = Number.isFinite(priorMs) ? priorMs + 1 : Number.NEGATIVE_INFINITY;
  return new Date(Math.max(nowMs, floor)).toISOString();
}

export function makeBuildInfo(rootDir, env = process.env, nowMs = Date.now()) {
  const version = readPackageVersion(join(rootDir, 'package.json'));
  const { sha, dirty } = readGitIdentity(rootDir);
  const priorInfo = readPriorBuildInfo(join(rootDir, 'build', 'build-info.json'));
  const builtAt = nextBuiltAt({ dirty, nowMs, sourceDateEpoch: env.SOURCE_DATE_EPOCH, priorInfo });
  return { version, sha, dirty, builtAt };
}

export function writeBuildInfo(rootDir, info) {
  const buildDir = join(rootDir, 'build');
  const finalPath = join(buildDir, 'build-info.json');
  const tempPath = join(buildDir, `.build-info-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tempPath, `${JSON.stringify(info, null, 2)}\n`);
  try {
    renameSync(tempPath, finalPath);
  } catch (err) {
    rmSync(tempPath, { force: true });
    throw err;
  }
  return finalPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeBuildInfo(CHECKOUT_ROOT, makeBuildInfo(CHECKOUT_ROOT));
}
