/** Complete skill and reviewer-agent lifecycle (Plan 15 Task 2).
 *
 * Sources are runtime-enumerated from the checkout — every direct skills/
 * directory containing SKILL.md plus exactly the four pinned
 * .claude/agents/plan-reviewer-*.md definitions. State classification is
 * hash-based (tree SHA vs sidecar record vs source), so a server version bump
 * cannot make unchanged skills stale. Installs stage and hash the complete
 * set before atomic renames; foreign artifacts are preserved byte-identical.
 * The repo-scope Codex destination goes through the 05ec915d contained
 * assert-then-prepare boundary. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAI_ROOT } from '../paths.js';
import {
  assertRepoManagedDestination,
  prepareRepoManagedDestination,
} from '../repo-managed-write.js';

export type SkillTarget = 'claude' | 'codex' | 'all';
export type CodexScope = 'repo' | 'user' | 'admin';
export type ManagedState = 'missing' | 'current' | 'stale' | 'drifted';
export type SkillAction = 'status' | 'install' | 'upgrade';

export interface SkillRequest {
  action: SkillAction;
  target?: SkillTarget;
  codexScope?: CodexScope;
  force?: boolean;
}

export interface ManagedItemStatus {
  name: string;
  kind: 'skill' | 'reviewer-agent';
  group: string;
  destination: string;
  state: ManagedState;
  action: 'none' | 'installed' | 'upgraded' | 'refused';
  detail?: string;
}

export interface SkillRunResult {
  ok: boolean;
  action: SkillAction;
  targets: string[];
  items: ManagedItemStatus[];
  notes: string[];
}

export interface SkillsIO {
  platform: NodeJS.Platform;
  homedir(): string;
  env: Readonly<Record<string, string | undefined>>;
  cwd(): string;
  now(): Date;
  gitToplevel(cwd: string): string | null;
  runCommand(
    command: string,
    args: string[],
    options: { cwd: string; timeoutMs: number }
  ): { status: number; stdout: string; stderr: string };
  /** Test seam: throw to simulate an atomic failure at a named phase. */
  failurePoint?(phase: 'stage' | 'swap', target: string): void;
}

export function defaultSkillsIO(): SkillsIO {
  return {
    platform: process.platform,
    homedir: () => os.homedir(),
    env: process.env,
    cwd: () => process.cwd(),
    now: () => new Date(),
    gitToplevel: (cwd: string) => {
      try {
        return execFileSync('git', ['rev-parse', '--show-toplevel'], {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
        }).trim();
      } catch {
        return null;
      }
    },
    runCommand: (command, args, options) => {
      try {
        const stdout = execFileSync(command, args, {
          cwd: options.cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: options.timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
        });
        return { status: 0, stdout, stderr: '' };
      } catch (err) {
        if (
          typeof err === 'object' &&
          err !== null &&
          'status' in err &&
          typeof err.status === 'number'
        ) {
          const stdout = 'stdout' in err && typeof err.stdout === 'string' ? err.stdout : '';
          const stderr = 'stderr' in err && typeof err.stderr === 'string' ? err.stderr : '';
          return { status: err.status, stdout, stderr };
        }
        const message = err instanceof Error ? err.message : String(err);
        return { status: 1, stdout: '', stderr: message };
      }
    },
  };
}

export class SkillsError extends Error {}

function fail(message: string): never {
  throw new SkillsError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const REVIEWER_AGENT_NAMES = [
  'plan-reviewer-broad',
  'plan-reviewer-delta',
  'plan-reviewer-clearance',
  'plan-reviewer-clearance-max',
] as const;

export const SKILL_SIDECAR = '.mai-skill.json';
export const REVIEWER_SIDECAR = '.mai-reviewer-agents.json';
/** Numeric manifest-format version — deliberately NOT the server version. */
export const MANIFEST_FORMAT_VERSION = 1;

function u64be(value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(value));
  return buf;
}

function walkRegularFiles(dir: string, base: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = base === '' ? entry.name : `${base}/${entry.name}`;
    if (entry.isSymbolicLink()) fail(`symlink in managed tree: ${full}`);
    if (entry.isDirectory()) {
      out.push(...walkRegularFiles(full, relative));
      continue;
    }
    if (!entry.isFile()) fail(`non-regular entry in managed tree: ${full}`);
    out.push(relative);
  }
  return out;
}

/** Deterministic tree SHA: sorted POSIX relative paths, framed as
 * u64be(path bytes) + path + u64be(content bytes) + content, sidecar
 * excluded. */
export function hashTree(dir: string): string {
  const files = walkRegularFiles(dir, '')
    .filter((relative) => relative !== SKILL_SIDECAR)
    .sort();
  const hash = createHash('sha256');
  for (const relative of files) {
    const pathBytes = Buffer.from(relative, 'utf8');
    const content = readFileSync(path.join(dir, relative));
    hash.update(u64be(pathBytes.length));
    hash.update(pathBytes);
    hash.update(u64be(content.length));
    hash.update(content);
  }
  return hash.digest('hex');
}

export interface SkillSource {
  name: string;
  dir: string;
  sha: string;
}
export interface ReviewerAgentSource {
  name: string;
  file: string;
  sha: string;
}

export function shippedSkills(root: string = MAI_ROOT): SkillSource[] {
  const skillsDir = path.join(root, 'skills');
  const sources: SkillSource[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) fail(`symlink in skills source: ${path.join(skillsDir, entry.name)}`);
    if (!entry.isDirectory()) continue; // LICENSE / SPINE.md live at the root
    const dir = path.join(skillsDir, entry.name);
    if (!existsSync(path.join(dir, 'SKILL.md'))) {
      fail(`skill directory has no SKILL.md: ${dir}`);
    }
    sources.push({ name: entry.name, dir, sha: hashTree(dir) });
  }
  if (sources.length === 0) fail(`no skills found under ${skillsDir}`);
  return sources.sort((a, b) => a.name.localeCompare(b.name));
}

export function shippedReviewerAgents(root: string = MAI_ROOT): ReviewerAgentSource[] {
  const agentsDir = path.join(root, '.claude', 'agents');
  const found = readdirSync(agentsDir, { withFileTypes: true }).filter((entry) =>
    /^plan-reviewer-.*\.md$/.test(entry.name)
  );
  const expected = new Set(REVIEWER_AGENT_NAMES.map((name) => `${name}.md`));
  const actual = new Set(found.map((entry) => entry.name));
  if (
    actual.size !== expected.size ||
    [...expected].some((name) => !actual.has(name))
  ) {
    fail(
      `reviewer agent inventory mismatch under ${agentsDir}: expected exactly ` +
        `${[...expected].sort().join(', ')}; found ${[...actual].sort().join(', ') || '(none)'}`
    );
  }
  return REVIEWER_AGENT_NAMES.map((name) => {
    const file = path.join(agentsDir, `${name}.md`);
    const stat = lstatSync(file);
    if (!stat.isFile()) fail(`reviewer agent source is not a regular file: ${file}`);
    const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
    return { name, file, sha };
  });
}

/** Spawn the authoritative checker from the brain checkout — never a
 * same-named script from the consumer cwd, and never a second suite list. */
export function checkSkillReferenceClosure(io: SkillsIO = defaultSkillsIO()): void {
  const checker = path.join(MAI_ROOT, 'scripts', 'check-skills.mjs');
  const result = io.runCommand(process.execPath, [checker], {
    cwd: MAI_ROOT,
    timeoutMs: 120_000,
  });
  if (result.status !== 0) {
    fail(
      `skill source suite is invalid (check-skills exited ${result.status}):\n` +
        `${result.stderr || result.stdout}`.trim()
    );
  }
}

interface SkillSidecar {
  name: string;
  sha: string;
  version: number;
  installedAt: string;
}
function parseSkillSidecar(file: string): SkillSidecar | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { name, sha, version, installedAt } = parsed;
  if (typeof name !== 'string' || typeof sha !== 'string') return null;
  if (version !== MANIFEST_FORMAT_VERSION || typeof installedAt !== 'string') return null;
  return { name, sha, version, installedAt };
}

interface ReviewerSidecar {
  suiteVersion: number;
  installedAt: string;
  agents: Record<string, string>;
}
function parseReviewerSidecar(file: string): ReviewerSidecar | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { suiteVersion, installedAt, agents } = parsed;
  if (suiteVersion !== MANIFEST_FORMAT_VERSION || typeof installedAt !== 'string') return null;
  if (!isRecord(agents)) return null;
  const map: Record<string, string> = {};
  for (const [name, sha] of Object.entries(agents)) {
    if (typeof sha !== 'string') return null;
    map[name] = sha;
  }
  return { suiteVersion, installedAt, agents: map };
}

export function classifySkill(source: SkillSource, destRoot: string): {
  state: ManagedState;
  detail?: string;
} {
  const installedDir = path.join(destRoot, source.name);
  if (!existsSync(installedDir)) return { state: 'missing' };
  let installedSha: string;
  try {
    installedSha = hashTree(installedDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { state: 'drifted', detail: `unhashable installed tree: ${message}` };
  }
  const sidecar = parseSkillSidecar(path.join(installedDir, SKILL_SIDECAR));
  if (sidecar === null || sidecar.name !== source.name) {
    return { state: 'drifted', detail: 'no valid install record' };
  }
  if (installedSha !== sidecar.sha) {
    return { state: 'drifted', detail: 'installed bytes differ from the install record' };
  }
  if (sidecar.sha !== source.sha) return { state: 'stale' };
  return { state: 'current' };
}

export function classifyReviewerSuite(
  sources: ReviewerAgentSource[],
  agentsDir: string
): { state: ManagedState; detail?: string } {
  const sidecar = parseReviewerSidecar(path.join(agentsDir, REVIEWER_SIDECAR));
  const present = sources.filter((source) =>
    existsSync(path.join(agentsDir, `${source.name}.md`))
  );
  if (sidecar === null) {
    if (present.length === 0) return { state: 'missing' };
    return { state: 'drifted', detail: 'reviewer files present without a valid install record' };
  }
  if (present.length < sources.length) {
    return { state: 'drifted', detail: 'recorded reviewer suite is partially deleted' };
  }
  let stale = false;
  for (const source of sources) {
    const file = path.join(agentsDir, `${source.name}.md`);
    if (lstatSync(file).isSymbolicLink()) {
      return { state: 'drifted', detail: `installed reviewer is a symlink: ${file}` };
    }
    const installedSha = createHash('sha256').update(readFileSync(file)).digest('hex');
    const recorded = sidecar.agents[source.name];
    if (typeof recorded !== 'string' || installedSha !== recorded) {
      return { state: 'drifted', detail: `installed ${source.name}.md differs from the install record` };
    }
    if (recorded !== source.sha) stale = true;
  }
  return { state: stale ? 'stale' : 'current' };
}

interface ResolvedDestinations {
  labels: string[];
  claudeSkillsDir: string | null;
  claudeAgentsDir: string | null;
  codexSkillsDir: string | null;
  codexScope: CodexScope | null;
  codexRepoRoot: string | null;
}

function resolveDestinations(request: SkillRequest, io: SkillsIO): ResolvedDestinations {
  const target: SkillTarget = request.target ?? 'all';
  if (target === 'claude' && request.codexScope !== undefined) {
    fail('--codex-scope requires a codex target');
  }
  const scope: CodexScope = request.codexScope ?? 'user';
  if ((target === 'codex' || target === 'all') && scope === 'admin' && io.platform === 'win32') {
    fail('Codex admin scope is not supported on native Windows; use --codex-scope user or repo');
  }
  const home = io.homedir();
  const out: ResolvedDestinations = {
    labels: [],
    claudeSkillsDir: null,
    claudeAgentsDir: null,
    codexSkillsDir: null,
    codexScope: null,
    codexRepoRoot: null,
  };
  if (target === 'claude' || target === 'all') {
    out.claudeSkillsDir = path.join(home, '.claude', 'skills');
    out.claudeAgentsDir = path.join(home, '.claude', 'agents');
    out.labels.push('claude');
  }
  if (target === 'codex' || target === 'all') {
    out.codexScope = scope;
    if (scope === 'user') {
      const codexHome = io.env.CODEX_HOME ?? path.join(home, '.codex');
      out.codexSkillsDir = path.join(codexHome, 'skills');
    } else if (scope === 'admin') {
      out.codexSkillsDir = '/etc/codex/skills';
    } else {
      const top = io.gitToplevel(io.cwd());
      if (top === null) fail('--codex-scope repo requires running inside a git repository');
      out.codexRepoRoot = top;
      out.codexSkillsDir = path.join(top, '.agents', 'skills');
    }
    out.labels.push(`codex:${scope}`);
  }
  return out;
}

function codexDiscoveryScopes(io: SkillsIO): Array<{ scope: CodexScope; dir: string }> {
  const home = io.homedir();
  const scopes: Array<{ scope: CodexScope; dir: string }> = [];
  const top = io.gitToplevel(io.cwd());
  if (top !== null) scopes.push({ scope: 'repo', dir: path.join(top, '.agents', 'skills') });
  const codexHome = io.env.CODEX_HOME ?? path.join(home, '.codex');
  scopes.push({ scope: 'user', dir: path.join(codexHome, 'skills') });
  scopes.push({ scope: 'admin', dir: '/etc/codex/skills' });
  return scopes;
}

function nearestExistingAncestor(dir: string): string {
  let current = dir;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function isWritable(dir: string): boolean {
  try {
    accessSync(nearestExistingAncestor(dir), fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Stage the complete set next to the destination, verify staged hashes, then
 * swap with renames. Partial staging failure never touches the installed set. */
function stageAndSwapSkills(
  destRoot: string,
  writes: SkillSource[],
  io: SkillsIO
): void {
  mkdirSync(destRoot, { recursive: true });
  const stageRoot = path.join(
    destRoot,
    `.mai-stage-${process.pid}-${Math.random().toString(16).slice(2, 10)}`
  );
  mkdirSync(stageRoot);
  try {
    for (const source of writes) {
      const staged = path.join(stageRoot, source.name);
      io.failurePoint?.('stage', source.name);
      cpSync(source.dir, staged, { recursive: true });
      const stagedSha = hashTree(staged);
      if (stagedSha !== source.sha) {
        fail(`staged copy hash mismatch for ${source.name}`);
      }
      const sidecar: SkillSidecar = {
        name: source.name,
        sha: stagedSha,
        version: MANIFEST_FORMAT_VERSION,
        installedAt: io.now().toISOString(),
      };
      writeFileSync(path.join(staged, SKILL_SIDECAR), `${JSON.stringify(sidecar, null, 2)}\n`);
    }
    for (const source of writes) {
      const finalDir = path.join(destRoot, source.name);
      const retired = path.join(stageRoot, `old-${source.name}`);
      const hadPrior = existsSync(finalDir);
      if (hadPrior) renameSync(finalDir, retired);
      try {
        io.failurePoint?.('swap', source.name);
        renameSync(path.join(stageRoot, source.name), finalDir);
      } catch (err) {
        if (hadPrior && !existsSync(finalDir)) renameSync(retired, finalDir);
        throw err;
      }
    }
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

function stageAndSwapReviewers(
  agentsDir: string,
  sources: ReviewerAgentSource[],
  io: SkillsIO
): void {
  mkdirSync(agentsDir, { recursive: true });
  const stageRoot = path.join(
    agentsDir,
    `.mai-stage-${process.pid}-${Math.random().toString(16).slice(2, 10)}`
  );
  mkdirSync(stageRoot);
  try {
    const agents: Record<string, string> = {};
    for (const source of sources) {
      io.failurePoint?.('stage', source.name);
      const staged = path.join(stageRoot, `${source.name}.md`);
      cpSync(source.file, staged);
      const stagedSha = createHash('sha256').update(readFileSync(staged)).digest('hex');
      if (stagedSha !== source.sha) fail(`staged copy hash mismatch for ${source.name}.md`);
      agents[source.name] = stagedSha;
    }
    const sidecar: ReviewerSidecar = {
      suiteVersion: MANIFEST_FORMAT_VERSION,
      installedAt: io.now().toISOString(),
      agents,
    };
    writeFileSync(
      path.join(stageRoot, REVIEWER_SIDECAR),
      `${JSON.stringify(sidecar, null, 2)}\n`
    );
    for (const source of sources) {
      io.failurePoint?.('swap', source.name);
      renameSync(path.join(stageRoot, `${source.name}.md`), path.join(agentsDir, `${source.name}.md`));
    }
    renameSync(path.join(stageRoot, REVIEWER_SIDECAR), path.join(agentsDir, REVIEWER_SIDECAR));
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

export function runSkills(request: SkillRequest, io: SkillsIO = defaultSkillsIO()): SkillRunResult {
  const skills = shippedSkills();
  const reviewers = shippedReviewerAgents();
  const dest = resolveDestinations(request, io);
  const writing = request.action === 'install' || request.action === 'upgrade';
  if (writing) checkSkillReferenceClosure(io);

  const items: ManagedItemStatus[] = [];
  const notes: string[] = [];
  const blockers: string[] = [];

  interface SkillDestination {
    group: string;
    root: string;
    repoRoot: string | null;
  }
  const skillDestinations: SkillDestination[] = [];
  if (dest.claudeSkillsDir !== null) {
    skillDestinations.push({ group: 'claude skills', root: dest.claudeSkillsDir, repoRoot: null });
  }
  if (dest.codexSkillsDir !== null && dest.codexScope !== null) {
    skillDestinations.push({
      group: `codex ${dest.codexScope} skills`,
      root: dest.codexSkillsDir,
      repoRoot: dest.codexScope === 'repo' ? dest.codexRepoRoot : null,
    });
  }

  const planned: Array<{ destination: SkillDestination; writes: SkillSource[] }> = [];
  for (const destination of skillDestinations) {
    const writes: SkillSource[] = [];
    for (const source of skills) {
      const { state, detail } = classifySkill(source, destination.root);
      const item: ManagedItemStatus = {
        name: source.name,
        kind: 'skill',
        group: destination.group,
        destination: destination.root,
        state,
        action: 'none',
        detail,
      };
      if (writing) {
        if (state === 'drifted' && request.force !== true) {
          item.action = 'refused';
          item.detail = `${detail ?? 'drifted'} — rerun with --force to overwrite`;
          blockers.push(`${destination.group}/${source.name}: drifted (use --force)`);
        } else if (state !== 'current') {
          writes.push(source);
          item.action = state === 'missing' ? 'installed' : 'upgraded';
        }
      }
      items.push(item);
    }
    planned.push({ destination, writes });
  }

  let reviewerWrite = false;
  if (dest.claudeAgentsDir !== null) {
    const { state, detail } = classifyReviewerSuite(reviewers, dest.claudeAgentsDir);
    const suiteItem: ManagedItemStatus = {
      name: 'plan-reviewer suite (4 definitions)',
      kind: 'reviewer-agent',
      group: 'claude reviewer agents',
      destination: dest.claudeAgentsDir,
      state,
      action: 'none',
      detail,
    };
    if (writing) {
      if (state === 'drifted' && request.force !== true) {
        suiteItem.action = 'refused';
        suiteItem.detail = `${detail ?? 'drifted'} — rerun with --force to overwrite`;
        blockers.push('claude reviewer agents: drifted (use --force)');
      } else if (state !== 'current') {
        reviewerWrite = true;
        suiteItem.action = state === 'missing' ? 'installed' : 'upgraded';
      }
    }
    items.push(suiteItem);
  }

  if (writing) {
    // Cross-scope duplicate refusal before any Codex write.
    if (dest.codexSkillsDir !== null && dest.codexScope !== null) {
      for (const { scope, dir } of codexDiscoveryScopes(io)) {
        if (scope === dest.codexScope || !existsSync(dir)) continue;
        for (const source of skills) {
          if (existsSync(path.join(dir, source.name))) {
            blockers.push(
              `skill '${source.name}' already exists in codex ${scope} scope (${dir}) — ` +
                'Codex does not merge duplicate skill names across discovery scopes; remove one copy first'
            );
          }
        }
      }
      if (dest.codexScope === 'admin' && !isWritable(dest.codexSkillsDir)) {
        blockers.push('codex admin scope is not writable; no automatic elevation');
        notes.push('run manually:');
        notes.push(`sudo mkdir -p ${dest.codexSkillsDir}`);
        for (const source of skills) {
          notes.push(`sudo cp -R "${source.dir}" "${path.join(dest.codexSkillsDir, source.name)}"`);
        }
      }
    }

    if (blockers.length > 0) {
      return {
        ok: false,
        action: request.action,
        targets: dest.labels,
        items,
        notes: [...blockers, ...notes],
      };
    }

    for (const { destination, writes } of planned) {
      if (writes.length === 0) continue;
      if (destination.repoRoot !== null) {
        // Complete-set assertion with zero writes, then preparation.
        assertRepoManagedDestination(destination.repoRoot, path.join('.agents', 'skills'));
        for (const source of skills) {
          assertRepoManagedDestination(
            destination.repoRoot,
            path.join('.agents', 'skills', source.name)
          );
        }
        prepareRepoManagedDestination(
          destination.repoRoot,
          path.join('.agents', 'skills', '.mai-anchor')
        );
      }
      stageAndSwapSkills(destination.root, writes, io);
    }
    if (reviewerWrite && dest.claudeAgentsDir !== null) {
      stageAndSwapReviewers(dest.claudeAgentsDir, reviewers, io);
    }
    if (
      dest.claudeSkillsDir !== null &&
      (reviewerWrite || planned.some((p) => p.destination.root === dest.claudeSkillsDir && p.writes.length > 0))
    ) {
      notes.push('restart Claude Code to pick up the updated skills and reviewer agents');
    }
  }

  return { ok: true, action: request.action, targets: dest.labels, items, notes };
}

const STATE_SYMBOL: Record<ManagedState, string> = {
  current: '✓',
  stale: '↷',
  missing: '∅',
  drifted: '!',
};

export function formatSkillResult(result: SkillRunResult): string {
  const lines: string[] = [];
  lines.push(`mai skills ${result.action} — targets: ${result.targets.join(', ')}`);
  const groups = [...new Set(result.items.map((item) => item.group))];
  for (const group of groups) {
    lines.push(`${group}:`);
    for (const item of result.items.filter((entry) => entry.group === group)) {
      const acted = item.action === 'none' ? '' : ` [${item.action}]`;
      const detail = item.detail === undefined ? '' : ` — ${item.detail}`;
      lines.push(`  ${STATE_SYMBOL[item.state]} ${item.name}: ${item.state}${acted}${detail}`);
    }
  }
  if (result.notes.length > 0) {
    lines.push('notes:');
    for (const note of result.notes) lines.push(`  ${note}`);
  }
  lines.push(result.ok ? 'skills: OK' : 'skills: FAILED');
  return lines.join('\n');
}
