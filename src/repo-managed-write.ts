/** Repo-contained write boundary (Plan 15 Task 2, authority 05ec915d).
 *
 * Two deliberately separate phases:
 *   - assertRepoManagedDestination: side-effect-free validation of one
 *     repo-relative destination. Callers assert their COMPLETE destination
 *     set with zero writes before anything is created.
 *   - prepareRepoManagedDestination: the mutation-phase helper — creates
 *     missing parent components one at a time, rechecking each. Never a
 *     preflight alias.
 *
 * This is a portable containment and ordinary-concurrency boundary, not a
 * descriptor-relative sandbox against a malicious process already running as
 * the same OS user (explicitly outside decision 05ec915d's threat model). */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export class RepoManagedWriteError extends Error {}

function fail(message: string): never {
  throw new RepoManagedWriteError(message);
}

/** Resolve and pin the real repo root; throws when it is not a directory. */
function resolveRepoRoot(repoRoot: string): string {
  let real: string;
  try {
    real = realpathSync(repoRoot);
  } catch {
    fail(`repo root does not exist: ${repoRoot}`);
  }
  const stat = lstatSync(real);
  if (!stat.isDirectory()) fail(`repo root is not a directory: ${repoRoot}`);
  return real;
}

interface ValidatedDestination {
  repoRealRoot: string;
  absolutePath: string;
  /** Path components of relativeFile under the root, in order. */
  components: string[];
}

function validateRelative(repoRoot: string, relativeFile: string): ValidatedDestination {
  if (relativeFile.length === 0) fail('destination path is empty');
  if (relativeFile.includes('\0')) fail(`destination path contains NUL: ${JSON.stringify(relativeFile)}`);
  if (path.posix.isAbsolute(relativeFile) || path.win32.isAbsolute(relativeFile)) {
    fail(`destination path must be repo-relative, got absolute: ${relativeFile}`);
  }
  const repoRealRoot = resolveRepoRoot(repoRoot);
  const absolutePath = path.resolve(repoRealRoot, relativeFile);
  if (absolutePath === repoRealRoot || !absolutePath.startsWith(repoRealRoot + path.sep)) {
    fail(`destination path escapes the repo root: ${relativeFile}`);
  }
  const components = path.relative(repoRealRoot, absolutePath).split(path.sep);
  if (components.some((part) => part === '' || part === '.' || part === '..')) {
    fail(`destination path escapes the repo root: ${relativeFile}`);
  }
  return { repoRealRoot, absolutePath, components };
}

/** Side-effect-free: walk every EXISTING component with lstat, reject
 * symlinks and non-directory ancestors, and accept a missing suffix without
 * creating it. Returns the validated absolute destination path. */
export function assertRepoManagedDestination(repoRoot: string, relativeFile: string): string {
  const { repoRealRoot, absolutePath, components } = validateRelative(repoRoot, relativeFile);
  let current = repoRealRoot;
  for (let i = 0; i < components.length; i += 1) {
    current = path.join(current, components[i]);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      // Missing suffix is acceptable — and is NOT created here.
      return absolutePath;
    }
    if (stat.isSymbolicLink()) {
      fail(`destination component is a symlink: ${current}`);
    }
    const isFinal = i === components.length - 1;
    if (!isFinal && !stat.isDirectory()) {
      fail(`destination ancestor is not a directory: ${current}`);
    }
  }
  return absolutePath;
}

/** Mutation-phase: assert, then create missing parent components one at a
 * time, rechecking every created/existing component. Only call after the
 * caller's COMPLETE destination set has passed assertion. */
export function prepareRepoManagedDestination(repoRoot: string, relativeFile: string): string {
  const absolutePath = assertRepoManagedDestination(repoRoot, relativeFile);
  const { repoRealRoot, components } = validateRelative(repoRoot, relativeFile);
  let current = repoRealRoot;
  for (let i = 0; i < components.length - 1; i += 1) {
    current = path.join(current, components[i]);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      mkdirSync(current);
      stat = lstatSync(current);
    }
    if (stat.isSymbolicLink()) fail(`destination component is a symlink: ${current}`);
    if (!stat.isDirectory()) fail(`destination ancestor is not a directory: ${current}`);
  }
  return absolutePath;
}

export interface RepoManagedWriteHooks {
  /** Race seam: the LAST injectable operation. Everything after it — final
   * revalidation, temp write, rename, parent fsync — is one synchronous
   * commit section with no awaits, callbacks, or spawned commands. */
  beforeCommit?: () => void | Promise<void>;
}

interface TargetSnapshot {
  missing: boolean;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  mode: number;
}

const MISSING_SNAPSHOT: TargetSnapshot = {
  missing: true,
  dev: -1,
  ino: -1,
  size: -1,
  mtimeMs: -1,
  mode: 0o644,
};

/** Reject any symlinked component between root and target, synchronously. */
function revalidateChain(repoRealRoot: string, components: string[]): void {
  let current = repoRealRoot;
  for (let i = 0; i < components.length; i += 1) {
    current = path.join(current, components[i]);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return; // missing suffix stays acceptable
    }
    if (stat.isSymbolicLink()) fail(`destination component is a symlink: ${current}`);
    if (i < components.length - 1 && !stat.isDirectory()) {
      fail(`destination ancestor is not a directory: ${current}`);
    }
  }
}

function snapshotTarget(absolutePath: string): TargetSnapshot {
  let stat;
  try {
    stat = lstatSync(absolutePath);
  } catch {
    return MISSING_SNAPSHOT;
  }
  if (stat.isSymbolicLink()) fail(`destination is a symlink: ${absolutePath}`);
  if (!stat.isFile()) fail(`destination is not a regular file: ${absolutePath}`);
  return {
    missing: false,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mode: stat.mode & 0o777,
  };
}

function requireUnchanged(absolutePath: string, snapshot: TargetSnapshot): void {
  const now = snapshotTarget(absolutePath);
  if (now.missing && snapshot.missing) return;
  if (
    now.missing !== snapshot.missing ||
    now.dev !== snapshot.dev ||
    now.ino !== snapshot.ino ||
    now.size !== snapshot.size ||
    now.mtimeMs !== snapshot.mtimeMs
  ) {
    fail(`destination changed during managed write: ${absolutePath}`);
  }
}

/** Contained read-transform-write under authority 05ec915d. The transform
 * receives the current UTF-8 content (or null when missing) and returns the
 * complete replacement bytes, or null for unchanged. Portable containment and
 * ordinary-concurrency detection only — NOT a defense against a malicious
 * same-user process racing after final validation (excluded threat model). */
export async function updateRepoManagedFile(
  repoRoot: string,
  relativeFile: string,
  transform: (current: string | null) => string | null | Promise<string | null>,
  testHooks: RepoManagedWriteHooks = {}
): Promise<'created' | 'updated' | 'unchanged'> {
  const absolutePath = assertRepoManagedDestination(repoRoot, relativeFile);
  const repoRealRoot = realpathSync(repoRoot);
  const components = path.relative(repoRealRoot, absolutePath).split(path.sep);
  prepareRepoManagedDestination(repoRoot, relativeFile);

  // Snapshot + read through an O_NOFOLLOW handle; missing is a distinct state.
  let snapshot: TargetSnapshot;
  let current: string | null;
  let fd: number | null = null;
  try {
    fd = openSync(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') {
      fd = null;
    } else {
      fail(`cannot open destination for managed read: ${absolutePath}`);
    }
  }
  if (fd === null) {
    snapshot = MISSING_SNAPSHOT;
    current = null;
  } else {
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) fail(`destination is not a regular file: ${absolutePath}`);
      snapshot = {
        missing: false,
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        mode: stat.mode & 0o777,
      };
      current = readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
  }

  const replacement = await transform(current);
  if (replacement === null || replacement === current) return 'unchanged';

  await testHooks.beforeCommit?.();

  // ---- synchronous commit section: no injectable operation from here on ----
  revalidateChain(repoRealRoot, components);
  requireUnchanged(absolutePath, snapshot);

  const tempPath = path.join(
    path.dirname(absolutePath),
    `.${path.basename(absolutePath)}.mai-${process.pid}-${randomBytes(6).toString('hex')}.tmp`
  );
  let tempFd: number | null = null;
  try {
    tempFd = openSync(
      tempPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      snapshot.mode
    );
    const bytes = Buffer.from(replacement, 'utf8');
    let written = 0;
    while (written < bytes.length) {
      written += writeSync(tempFd, bytes, written, bytes.length - written);
    }
    fsyncSync(tempFd);
    closeSync(tempFd);
    tempFd = null;

    revalidateChain(repoRealRoot, components);
    requireUnchanged(absolutePath, snapshot);
    renameSync(tempPath, absolutePath);
    // Directory fsync is a POSIX durability step; Windows refuses fsync on a
    // directory handle (EPERM), and NTFS journals the rename itself.
    if (process.platform !== 'win32') {
      const dirFd = openSync(path.dirname(absolutePath), fsConstants.O_RDONLY);
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    }
  } catch (err) {
    if (tempFd !== null) closeSync(tempFd);
    rmSync(tempPath, { force: true });
    throw err;
  }
  return snapshot.missing ? 'created' : 'updated';
}
