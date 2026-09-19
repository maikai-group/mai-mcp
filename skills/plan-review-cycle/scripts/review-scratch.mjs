#!/usr/bin/env node
// SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
// Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely.
//
// review-scratch.mjs — the canonical cross-platform scratch lifecycle for the
// review skills. Behavior-preserving port of review-scratch.sh: the same
// key=value marker, the same uid ownership, the same fail-closed prune rules.
//
//   review-scratch.mjs create
//   review-scratch.mjs cleanup ROOT_PATH
//   review-scratch.mjs prune [--days N] [--root PATH ...] [--dry-run]
//
// Dependency-free by design: it ships inside the installed skill copy and is
// invoked by launchd / Task Scheduler with nothing but Node on the path.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MARKER = '.mai-review-scratch-v1';
export const PREFIX = 'mai-plan-review-pass.';
export const TOMBSTONE_PREFIX = '.mai-review-tombstone.';
export const DARWIN_SYSTEM_TMP_ROOT = '/private/tmp';

export class ScratchError extends Error {}

function die(message) {
  throw new ScratchError(message);
}

function retain(candidate, reason) {
  process.stderr.write(`review-scratch: retaining ${candidate}: ${reason}\n`);
}

/** POSIX uid; Windows has none, and its stat uid is always 0, so 0 keeps the
 * marker/owner comparison uniform without a platform branch. */
export function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : 0;
}

/** Direct-child containment compares canonical parents. Windows paths are
 * case-insensitive, so the comparison casefolds there and only there. */
export function samePath(a, b, platform = process.platform) {
  if (platform === 'win32') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function realpath(target) {
  return fs.realpathSync.native(target);
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export function canonicalRoot(input) {
  if (!input) die('temporary root resolved empty');
  const stat = lstatOrNull(input);
  if (!stat) die(`temporary root does not exist: ${input}`);
  const root = realpath(input);
  if (!root) die('temporary root resolved empty');
  if (path.parse(root).root === root) die('refusing filesystem root as temporary root');
  if (!fs.statSync(root).isDirectory()) die(`temporary root is not a directory: ${input}`);
  return root;
}

/** The shell helper resolved ${MAI_REVIEW_TMP_ROOT:-${TMPDIR:-/tmp}}; Node's
 * os.tmpdir() applies the same TMPDIR/TMP/TEMP precedence per platform. */
export function defaultTmpRoot(env = process.env, platform = process.platform) {
  if (env.MAI_REVIEW_TMP_ROOT) return canonicalRoot(env.MAI_REVIEW_TMP_ROOT);
  const candidates = platform === 'win32'
    ? [env.TEMP, env.TMP]
    : [env.TMPDIR, env.TMP, env.TEMP];
  const named = candidates.find((value) => typeof value === 'string' && value.length > 0);
  return canonicalRoot(named ?? os.tmpdir());
}

/** With no --root, prune covers the same set the LaunchAgent used to name
 * explicitly: the resolved per-user temp root plus, on macOS, /private/tmp. */
export function defaultPruneRoots(env = process.env, platform = process.platform) {
  const roots = [defaultTmpRoot(env, platform)];
  if (platform === 'darwin') roots.push(canonicalRoot(DARWIN_SYSTEM_TMP_ROOT));
  return dedupe(roots, platform);
}

function dedupe(roots, platform) {
  const out = [];
  for (const root of roots) if (!out.some((seen) => samePath(seen, root, platform))) out.push(root);
  return out;
}

/** key=value lines. Unknown keys are ignored; a reader never rejects them. */
export function parseMarker(text) {
  const fields = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    fields[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return fields;
}

export function renderMarker(uid, createdAt = new Date()) {
  return `version=1\nuid=${uid}\ncreated_at=${createdAt.toISOString().replace(/\.\d{3}Z$/, 'Z')}\n`;
}

function readManagedMarker(candidate) {
  const markerPath = path.join(candidate, MARKER);
  const stat = lstatOrNull(markerPath);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) return null;
  if (stat.uid !== currentUid()) return null;
  const fields = parseMarker(fs.readFileSync(markerPath, 'utf8'));
  if (!('version' in fields) || !('uid' in fields)) return null;
  if (fields.uid !== String(currentUid())) return null;
  return fields;
}

/** Returns the basename of a validated direct child, null when absent, or throws. */
export function validateDirectChild(candidate, root, platform = process.platform) {
  if (!candidate) die('empty cleanup target');
  const stat = lstatOrNull(candidate);
  if (!stat) return null;
  if (stat.isSymbolicLink()) die(`refusing symlink target: ${candidate}`);
  if (!stat.isDirectory()) die(`cleanup target is not a directory: ${candidate}`);
  const parent = realpath(path.dirname(candidate));
  const base = path.basename(candidate);
  if (!samePath(parent, root, platform)) die(`target is not a direct child of ${root}: ${candidate}`);
  if (stat.uid !== currentUid()) die(`target is not owned by uid ${currentUid()}: ${candidate}`);
  return base;
}

function isManagedRoot(candidate, base) {
  if (!base.startsWith(PREFIX)) return null;
  return readManagedMarker(candidate);
}

/** Newest lstat mtime anywhere in the tree, symlinks/reparse points counted
 * by their own entry and never followed. Throws on enumeration failure. */
export function newestMtimeMs(tree) {
  let newest = fs.lstatSync(tree).mtimeMs;
  const stack = [tree];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      if (stat.isDirectory() && !stat.isSymbolicLink()) stack.push(full);
    }
  }
  return newest;
}

/** Regular files only, reparse points and symlinks never followed. */
export function regularFiles(tree) {
  const files = [];
  const stack = [tree];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) stack.push(full);
      else if (stat.isFile()) files.push(full);
    }
  }
  return files;
}

function findOnPath(name, env = process.env) {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const names = process.platform === 'win32'
    ? [name, ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((ext) => name + ext.toLowerCase())]
    : [name];
  for (const dir of dirs) {
    for (const file of names) {
      const full = path.join(dir, file);
      const stat = lstatOrNull(full);
      if (stat && stat.isFile()) {
        try {
          fs.accessSync(full, fs.constants.X_OK);
          return full;
        } catch {
          continue;
        }
      }
    }
  }
  return null;
}

/** POSIX open-file probe: `lsof +D`. Any state other than "ran and found
 * nothing" retains the root. Mirrors review-scratch.sh's status handling. */
function posixOpenFiles(candidate, env) {
  const lsof = env.MAI_REVIEW_LSOF || findOnPath('lsof', env);
  if (!lsof || !lstatOrNull(lsof) || !isExecutable(lsof)) return { retain: 'lsof is unavailable' };
  const result = spawnSync(lsof, ['+D', candidate], { encoding: 'utf8' });
  if (result.error) return { retain: `lsof failed to start: ${result.error.message}` };
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const secondLine = output.split('\n')[1] ?? '';
  if (secondLine.trim().length > 0) return { open: true };
  if (result.status === 0) return { retain: 'lsof returned success without a result' };
  if (result.status === 1 && output.length === 0) return { open: false };
  return { retain: `lsof failed (status ${result.status}): ${output.trim()}` };
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Constant PowerShell helper: reads a JSON array of file paths on stdin and
 * prints, as a JSON array, the paths another process holds open. A file is
 * "held" when an exclusive open (FileShare.None) is refused with a sharing or
 * lock violation — the same discrimination the acceptance receipt performs
 * with [System.IO.FileShare]::None. Any other failure (a vanished file, an
 * access-denied path) is a nonzero exit and the caller retains and says why.
 * No Add-Type, no P/Invoke: the earlier Restart Manager probe returned
 * ERROR_INVALID_HANDLE from RmGetList on a real Windows host (CI run
 * 34800133502) and could only report a count this needs anyway. */
export const WINDOWS_OPEN_FILE_PROBE = String.raw`
$ErrorActionPreference = 'Stop'
$raw = [Console]::In.ReadToEnd()
$paths = @()
# Windows PowerShell 5.1 hands a decoded JSON array back as one nested object;
# only pipeline enumeration flattens it to one string per path.
if ($raw.Trim().Length -gt 0) { $paths = @(ConvertFrom-Json -InputObject $raw | ForEach-Object { $_ }) }
$held = New-Object System.Collections.Generic.List[string]
foreach ($p in $paths) {
  try {
    $stream = [System.IO.File]::Open([string]$p, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
    $stream.Close()
  } catch {
    # A .NET method's exception reaches the handler wrapped in a
    # MethodInvocationException; the sharing/lock violation is the inner one.
    $ex = $_.Exception
    if ($ex -is [System.Management.Automation.MethodInvocationException] -and $ex.InnerException) { $ex = $ex.InnerException }
    $code = $ex.HResult -band 0xFFFF
    if ($ex -is [System.IO.IOException] -and ($code -eq 32 -or $code -eq 33)) { $held.Add([string]$p) } else { throw "cannot open [$p]: $($ex.Message)" }
  }
}
if ($held.Count -eq 0) { Write-Output '[]' } else { Write-Output (ConvertTo-Json -InputObject @($held.ToArray()) -Compress) }
`;

function windowsOpenFiles(candidate, env) {
  let files;
  try {
    files = regularFiles(candidate);
  } catch (error) {
    return { retain: `enumeration failed: ${error.message}` };
  }
  const shell = findOnPath('powershell.exe', env) || findOnPath('powershell', env);
  if (!shell) return { retain: 'powershell.exe is unavailable' };
  const encoded = Buffer.from(WINDOWS_OPEN_FILE_PROBE, 'utf16le').toString('base64');
  const result = spawnSync(shell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
  ], { encoding: 'utf8', input: JSON.stringify(files) });
  if (result.error) return { retain: `open-file probe failed to start: ${result.error.message}` };
  if (result.status !== 0) {
    return { retain: `open-file probe failed (status ${result.status}): ${(result.stderr ?? '').trim()}` };
  }
  let held;
  try {
    held = JSON.parse((result.stdout ?? '').trim());
  } catch {
    return { retain: 'open-file probe returned malformed JSON' };
  }
  if (!Array.isArray(held) || !held.every((file) => typeof file === 'string')) {
    return { retain: 'open-file probe returned malformed JSON' };
  }
  return { open: held.length > 0 };
}

function openFiles(candidate, env, platform) {
  return platform === 'win32' ? windowsOpenFiles(candidate, env) : posixOpenFiles(candidate, env);
}

/** OLD and IDLE: age strictly greater than `days`, measured from the NEWER of
 * the marker's created_at and the newest mtime in the tree, and no open file.
 * Every probe failure retains and says why. */
export function isOldAndIdle(candidate, marker, days, { env = process.env, platform = process.platform, now = Date.now() } = {}) {
  const cutoff = now - days * 86_400_000;
  let newest;
  try {
    newest = newestMtimeMs(candidate);
  } catch (error) {
    retain(candidate, `freshness scan failed: ${error.message}`);
    return false;
  }
  const createdAt = typeof marker.created_at === 'string' ? Date.parse(marker.created_at) : Number.NaN;
  if (!Number.isNaN(createdAt) && createdAt > newest) newest = createdAt;
  if (!(newest < cutoff)) return false;
  const probe = openFiles(candidate, env, platform);
  if (probe.retain) {
    retain(candidate, probe.retain);
    return false;
  }
  if (probe.open !== false) {
    retain(candidate, 'a file in the tree is held open');
    return false;
  }
  return true;
}

/** Rename the validated child to a private tombstone sibling, revalidate the
 * marker and containment on the tombstone, then remove. Any failure retains. */
function removeTree(candidate, root, platform, dryRun) {
  if (dryRun) {
    process.stdout.write(`would remove: ${candidate}\n`);
    return true;
  }
  const parent = path.dirname(candidate);
  const base = path.basename(candidate);
  const tombstone = path.join(parent, `${TOMBSTONE_PREFIX}${base}.${randomBytes(6).toString('hex')}`);
  try {
    fs.renameSync(candidate, tombstone);
  } catch (error) {
    retain(candidate, `rename failed: ${error.message}`);
    return false;
  }
  let valid = false;
  try {
    const stat = fs.lstatSync(tombstone);
    valid = stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === currentUid()
      && samePath(realpath(path.dirname(tombstone)), root, platform)
      && readManagedMarker(tombstone) !== null;
  } catch {
    valid = false;
  }
  if (!valid) {
    try {
      fs.renameSync(tombstone, candidate);
    } catch {
      // the tombstone stays where it is; nothing is deleted
    }
    retain(candidate, 'revalidation after rename failed');
    return false;
  }
  try {
    fs.rmSync(tombstone, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    retain(candidate, `removal failed after rename: ${error.message}`);
    return false;
  }
  process.stdout.write(`removed: ${candidate}\n`);
  return true;
}

/** A tombstone is a root that already passed every validation and was
 * renamed for removal; a crash or a transient lock can leave it behind, and a
 * partial removal may already have taken its marker. Only this helper creates
 * the tombstone name, after validation, so each prune reclaims leftovers on
 * ownership and direct-child containment and retries the removal; nothing is
 * stranded forever. */
function reclaimTombstones(root, platform, dryRun) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.name.startsWith(TOMBSTONE_PREFIX)) continue;
    const tombstone = path.join(root, entry.name);
    let stat;
    try {
      stat = fs.lstatSync(tombstone);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== currentUid()) continue;
    if (!samePath(realpath(path.dirname(tombstone)), root, platform)) continue;
    if (dryRun) {
      process.stdout.write(`would reclaim: ${tombstone}\n`);
      continue;
    }
    try {
      fs.rmSync(tombstone, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      process.stdout.write(`reclaimed: ${tombstone}\n`);
    } catch (error) {
      retain(tombstone, `tombstone removal failed: ${error.message}`);
    }
  }
}

export function cmdCreate(env = process.env, platform = process.platform) {
  const root = defaultTmpRoot(env, platform);
  const scratch = fs.mkdtempSync(path.join(root, PREFIX));
  fs.chmodSync(scratch, 0o700);
  for (const sub of ['tmp', 'npm-cache']) {
    const dir = path.join(scratch, sub);
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
  const markerPath = path.join(scratch, MARKER);
  const staged = `${markerPath}.${randomBytes(6).toString('hex')}`;
  fs.writeFileSync(staged, renderMarker(currentUid()), { mode: 0o600 });
  fs.renameSync(staged, markerPath);
  fs.chmodSync(markerPath, 0o600);
  process.stdout.write(`${scratch}\n`);
}

export function cmdCleanup(args, env = process.env, platform = process.platform) {
  if (args.length !== 1) die('usage: review-scratch.mjs cleanup <managed-root>');
  const root = defaultTmpRoot(env, platform);
  const candidate = path.resolve(args[0]);
  if (!lstatOrNull(candidate)) {
    process.stdout.write(`already absent: ${candidate}\n`);
    return;
  }
  const base = validateDirectChild(candidate, root, platform);
  if (base === null) die(`cleanup target is not a directory: ${candidate}`);
  if (!isManagedRoot(candidate, base)) die(`target is not a marked ${PREFIX} root: ${candidate}`);
  if (!removeTree(candidate, root, platform, false)) die('cleanup did not remove the managed root; see the retention reason above');
}

function pruneRoot(root, days, dryRun, env, platform) {
  reclaimTombstones(root, platform, dryRun);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.name.startsWith(PREFIX)) continue;
    const candidate = path.join(root, entry.name);
    let base;
    try {
      base = validateDirectChild(candidate, root, platform);
    } catch {
      continue;
    }
    if (base === null) continue;
    const marker = isManagedRoot(candidate, base);
    if (!marker) continue;
    if (!isOldAndIdle(candidate, marker, days, { env, platform })) continue;
    removeTree(candidate, root, platform, dryRun);
  }
}

export function parsePruneArgs(args) {
  let days = 7;
  let dryRun = false;
  const roots = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--days') {
      if (i + 1 >= args.length) die('--days needs a value');
      days = args[i + 1];
      i += 1;
    } else if (arg === '--root') {
      if (i + 1 >= args.length) die('--root needs a value');
      roots.push(args[i + 1]);
      i += 1;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else {
      die(`unknown prune option: ${arg}`);
    }
  }
  if (!/^[0-9]+$/.test(String(days))) die('--days must be a non-negative integer');
  return { days: Number(days), dryRun, roots };
}

export function cmdPrune(args, env = process.env, platform = process.platform) {
  const { days, dryRun, roots } = parsePruneArgs(args);
  const resolved = roots.length > 0
    ? dedupe(roots.map((root) => canonicalRoot(root)), platform)
    : defaultPruneRoots(env, platform);
  for (const root of resolved) pruneRoot(root, days, dryRun, env, platform);
}

export function usage() {
  return [
    'usage:',
    '  review-scratch.mjs create',
    '  review-scratch.mjs cleanup <managed-root>',
    '  review-scratch.mjs prune [--days N] [--root PATH ...] [--dry-run]',
    '',
  ].join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'create':
        if (rest.length !== 0) die('create takes no arguments');
        cmdCreate();
        return 0;
      case 'cleanup':
        cmdCleanup(rest);
        return 0;
      case 'prune':
        cmdPrune(rest);
        return 0;
      case undefined:
      case '':
      case '-h':
      case '--help':
        process.stdout.write(usage());
        return 0;
      default:
        die(`unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof ScratchError) {
      process.stderr.write(`review-scratch: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
  return 0;
}

const invoked = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;
if (invoked) process.exitCode = main();
