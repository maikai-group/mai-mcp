// Physical filesystem identity boundary for registered project roots. All graph
// producers/readers compare paths only after they pass through this module.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const CONTROL = /[\u0000-\u001f\u007f]/;

export interface CanonicalRegisteredRootsOptions {
  baseDir: string;
  rejectRelative: boolean;
}

export interface PhysicalPathAliases {
  readonly rawToPhysical: ReadonlyMap<string, string>;
  readonly physicalToRaw: ReadonlyMap<string, readonly string[]>;
}

function checkedPath(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
  if (CONTROL.test(value)) throw new Error(`${label} contains a control character`);
  return value;
}

/** Resolve existing symlink components while retaining normalized nonexistent tails. */
export function canonicalPhysicalPath(input: string, baseDir: string): string {
  checkedPath(input, 'path');
  checkedPath(baseDir, 'base directory');
  const absolute = path.isAbsolute(input) ? path.normalize(input) : path.resolve(baseDir, input);
  let ancestor = absolute;
  const tail: string[] = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    tail.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  let physicalAncestor: string;
  try {
    physicalAncestor = fs.realpathSync.native(ancestor);
  } catch {
    physicalAncestor = path.resolve(ancestor);
  }
  return path.normalize(path.join(physicalAncestor, ...tail));
}

function requireDirectory(root: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(root);
  } catch {
    throw new Error(`Registered repo root is missing: ${root}`);
  }
  if (!stat.isDirectory()) throw new Error(`Registered repo root is not a directory: ${root}`);
}

export function canonicalRegisteredRoots(
  rawRoots: readonly string[],
  options: CanonicalRegisteredRootsOptions,
): string[] {
  const roots = new Set<string>();
  for (const rawRoot of rawRoots) {
    checkedPath(rawRoot, 'registered repo root');
    if (options.rejectRelative && !path.isAbsolute(rawRoot)) {
      throw new Error(`Registered repo root must be absolute: ${rawRoot}`);
    }
    const physical = canonicalPhysicalPath(rawRoot, options.baseDir);
    requireDirectory(physical);
    roots.add(physical);
  }
  return [...roots].sort();
}

export function canonicalGitTopLevel(repoRoot: string): string {
  const physicalRoot = canonicalRegisteredRoots([repoRoot], {
    baseDir: process.cwd(),
    rejectRelative: true,
  })[0];
  let top: string;
  try {
    top = execFileSync('git', ['-C', physicalRoot, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error(`Registered repo root is not a Git worktree: ${repoRoot}`);
  }
  return canonicalRegisteredRoots([top], { baseDir: physicalRoot, rejectRelative: true })[0];
}

export function physicalPathAliases(
  rawPaths: readonly string[],
  options: CanonicalRegisteredRootsOptions,
): PhysicalPathAliases {
  const rawToPhysical = new Map<string, string>();
  const grouped = new Map<string, string[]>();
  for (const raw of rawPaths) {
    checkedPath(raw, 'stored path alias');
    if (options.rejectRelative && !path.isAbsolute(raw)) {
      throw new Error(`Stored path alias must be absolute: ${raw}`);
    }
    const physical = canonicalPhysicalPath(raw, options.baseDir);
    rawToPhysical.set(raw, physical);
    const aliases = grouped.get(physical) ?? [];
    aliases.push(raw);
    grouped.set(physical, aliases);
  }
  const physicalToRaw = new Map<string, readonly string[]>();
  for (const [physical, aliases] of grouped) {
    physicalToRaw.set(physical, [...new Set(aliases)].sort());
  }
  return { rawToPhysical, physicalToRaw };
}

export function aliasesForPhysicalPath(aliases: PhysicalPathAliases, physical: string): readonly string[] {
  return aliases.physicalToRaw.get(physical) ?? [];
}
