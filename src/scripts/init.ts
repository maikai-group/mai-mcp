// mai init — idempotent project onboarding (Plan 15 Task 3: multi-harness).
// One shared implementation wires EVERY selected harness: it derives the
// complete final registered-repository × persisted-harness unions before any
// mutation, collision-checks a destination-owner map, asserts the complete
// destination set with zero writes (05ec915d containment), and only then
// installs the full cross-product and persists that same expectation.
// External commands run via execFile arrays — never a shell string (T6).
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { getPool } from '../db.js';
import { BRAIN_ROOT, MAI_ROOT } from '../paths.js';
import { RULES_MARKER } from './managed-block.js';
import { updateRepoManagedFile, assertRepoManagedDestination } from '../repo-managed-write.js';
import { withProjectProjectionLock } from '../project-projection-lock.js';
import type { HookEntryShape } from '../coordination-api.js';
import {
  canonicalMaiHooks, isLegacyMaiHookCommand, isMaiHookCommand,
  MAI_HOOK_DELEGATES, MAI_HOOK_MODES, MAI_HOOKS,
} from '../hook-wiring.js';
import { findExecutable, spawnArgv } from '../platform/commands.js';
import { defaultProcessOps } from '../platform/processes.js';
import type { ProcessOps } from '../platform/processes.js';
import type { ProjectVerification } from './verify.js';
import { canonicalPhysicalPath, canonicalRegisteredRoots } from '../graph/roots.js';
import { owningRegisteredRepo } from '../graph/contracts.js';

export {
  canonicalMaiHooks, isLegacyMaiHookCommand, isMaiHookCommand,
  MAI_HOOK_DELEGATES, MAI_HOOK_MODES, MAI_HOOKS,
} from '../hook-wiring.js';
// Predecessor-system guard: a legacy memory database may exist on another
// local port. This tool only ever connects to the database in MAI_DB_URL;
// nothing here migrates or reads any other system's data.

export interface DestinationClaim {
  repoRoot: string;
  relativePath: string;
  writerId: string;
  collisionOnly?: boolean;
}
export type DestinationWriterMap = ReadonlyMap<string, readonly DestinationClaim[]>;
export type DestinationMapBuilder = (
  claims: readonly DestinationClaim[]
) => DestinationWriterMap;
export interface PreFileLlmAuthority {
  provider?: string;
  summary?: string;
}

export interface InitArgs {
  slug: string;
  root: string;
  repos: string[];
  replaceRepos?: boolean;
  repoMaps?: Array<{ storedRoot: string; targetRoot: string }>;
  excludes?: string[];
  postgres?: string;
  draftTopics: boolean;
  harnesses?: string[];
  rulesFile?: string;
  llm?: 'claude-code' | 'codex-cli' | 'none';
  embeddings?: 'local' | 'none';
  yes?: boolean;
  printSummary?: boolean;
  sharedSkillsVerification?: 'required' | 'deferred';
  consentEnvFile?: string;
  preFileLlmAuthority?: PreFileLlmAuthority;
  destinationMapBuilder?: DestinationMapBuilder;
  /** Test-only seam (plan 31): runs immediately after the authoritative
   * metadata read while the projection lock is still held. */
  afterProjectionRead?: () => Promise<void>;
}
export interface InitResult {
  slug: string;
  root: string;
  repos: string[];
  harnesses: string[];
  summary: string[];
  verification: ProjectVerification;
}

export function initNextSteps(slug: string, postgresConfigured: boolean): string[] {
  return [
    `  - review any drafts in docs/context/${slug}/_drafts/ and move approved ones up a level`,
    '  - start the dashboard: mai dashboard start',
    '  - restart Claude Code sessions in the repos so the new .mcp.json + hooks load',
    ...(postgresConfigured ? [] : [`  - mai graph build --project ${slug} --db-url <dev-db-url> later to add schema introspection`]),
  ];
}
export function normalizeHarnesses(values: string[] | undefined): string[] {
  const input = values?.length ? values : ['claude-code'];
  return [...new Set(input)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function readTextOrNull(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** Canonical .mcp.json server entry. agentId and linkedProjects are preserved
 * from an existing entry on refresh; the authoritative linked list comes from
 * projects.metadata.linked_projects via the upgrade/link paths (plan 31). An
 * empty linkedProjects renders byte-identically to the pre-plan-31 entry. */
export function buildMcpServerEntry(
  repoPath: string, slug: string, agentId: string, linkedProjects: readonly string[] = []
): Record<string, unknown> {
  const env: Record<string, string> = {
    MAI_PROJECT_SLUG: slug, MAI_PROJECT_ROOT: repoPath, MAI_AGENT_ID: agentId,
  };
  if (linkedProjects.length > 0) env.MAI_LINKED_PROJECTS = [...linkedProjects].sort().join(',');
  return { command: 'node', args: [`${MAI_ROOT}/build/index.js`], env };
}

/**
 * Merge the mai-mcp server entry into a repo's .mcp.json without disturbing
 * other servers. Contained write (05ec915d); writes only on real change.
 */
export async function mergeMcpJson(
  repoPath: string,
  slug: string,
  opts: { agentId?: string; linkedProjects?: readonly string[] } = {}
): Promise<'created' | 'updated' | 'unchanged'> {
  return updateRepoManagedFile(repoPath, '.mcp.json', (current) => {
    let existing: Record<string, unknown> = {};
    if (current !== null) {
      try {
        const parsed: unknown = JSON.parse(current);
        if (isRecord(parsed)) existing = parsed;
      } catch {
        existing = {};
      }
    }
    const before = JSON.stringify(existing);
    const servers = isRecord(existing.mcpServers) ? existing.mcpServers : {};
    const prev: unknown = servers['mai-mcp'];
    let prevAgentId: string | undefined;
    if (isRecord(prev) && isRecord(prev.env) && typeof prev.env.MAI_AGENT_ID === 'string') {
      prevAgentId = prev.env.MAI_AGENT_ID;
    }
    const agentId = opts.agentId ?? prevAgentId ?? 'agent@claude-code';
    let prevLinked: string[] = [];
    if (isRecord(prev) && isRecord(prev.env) && typeof prev.env.MAI_LINKED_PROJECTS === 'string') {
      prevLinked = prev.env.MAI_LINKED_PROJECTS.split(',').map((s) => s.trim()).filter(Boolean);
    }
    const linked = opts.linkedProjects ?? prevLinked;
    servers['mai-mcp'] = buildMcpServerEntry(repoPath, slug, agentId, linked);
    // The structure graph is served by mai-mcp's own mai_graph_* tools — no
    // second MCP server needed (the Graphify swap, plan 4c).
    existing.mcpServers = servers;
    if (current !== null && JSON.stringify(existing) === before) return null;
    return JSON.stringify(existing, null, 2) + '\n';
  });
}

/** Upgrade semantics: strip every entry whose hooks ALL reference mai-mcp,
 * then append the canonical set. Foreign hooks (and mixed entries, which we
 * conservatively leave alone) survive untouched. Pure — caller does the I/O. */
export function upgradeHooksObject(settings: Record<string, unknown>, slug: string): Record<string, unknown> {
  const out = structuredClone(settings);
  const hooks = isRecord(out.hooks) ? out.hooks : {};
  const entriesOf = (value: unknown): HookEntryShape[] => (Array.isArray(value) ? (value as HookEntryShape[]) : []);
  const isMai = (e: HookEntryShape): boolean =>
    (e.hooks ?? []).length > 0 &&
    (e.hooks ?? []).every((h) => typeof h.command === 'string' && isMaiHookCommand(h.command));
  for (const event of Object.keys(hooks)) {
    const kept = entriesOf(hooks[event]).filter((e) => !isMai(e));
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  for (const { event, entry } of canonicalMaiHooks(slug)) {
    hooks[event] = [...entriesOf(hooks[event]), entry];
  }
  out.hooks = hooks;
  return out;
}

/**
 * Append mai SessionEnd/SessionStart/Stop hooks to a repo's .claude/settings.json
 * ONLY if not already present. Other hooks survive untouched. Contained write.
 */
export async function mergeHooks(repoPath: string, slug: string): Promise<'created' | 'updated' | 'unchanged'> {
  return updateRepoManagedFile(repoPath, path.join('.claude', 'settings.json'), (current) => {
    let settings: Record<string, unknown> = {};
    if (current !== null) {
      try {
        const parsed: unknown = JSON.parse(current);
        if (isRecord(parsed)) settings = parsed;
      } catch {
        settings = {};
      }
    }
    const before = JSON.stringify(settings);
    const next = upgradeHooksObject(settings, slug);
    if (current !== null && JSON.stringify(next) === before) return null;
    return JSON.stringify(next, null, 2) + '\n';
  });
}

export { RULES_MARKER } from './managed-block.js';

/**
 * Install a Memory-brain block into an arbitrary rules file (CLAUDE.md,
 * AGENTS.md, .cursorrules, …) from a canonical template. Marker-idempotent:
 * a block already present — including one pasted by hand — reads as
 * 'unchanged'. Existing content is never modified, only appended to.
 */
export async function mergeRulesFile(
  repoPath: string,
  fileName: string,
  templateName: string
): Promise<'created' | 'updated' | 'unchanged'> {
  const template = await fs.readFile(path.join(MAI_ROOT, 'templates', templateName), 'utf8');
  const block = template.endsWith('\n') ? template : template + '\n';
  return updateRepoManagedFile(repoPath, fileName, (current) => {
    if (current === null) return block;
    if (current.includes(RULES_MARKER)) return null;
    const sep = current.endsWith('\n') ? '\n' : '\n\n';
    return current + sep + block;
  });
}

/** Claude Code rules file — kept as a stable wrapper (tests + adapter import it). */
export async function mergeClaudeMd(repoPath: string): Promise<'created' | 'updated' | 'unchanged'> {
  return mergeRulesFile(repoPath, 'CLAUDE.md', 'memory-brain-block.md');
}

/** Pure basename boundary for the generic rules file (Plan 15 Task 3). Trim is
 * NOT normalization — surrounding whitespace rejects. Only repo-local
 * non-symlink text-rules basenames pass; structured/managed destinations and
 * their cross-platform case aliases cannot be selected. */
export function validateRulesFileName(value: string): string {
  const bad = (why: string): never => {
    throw new Error(`invalid rules-file name ${JSON.stringify(value)}: ${why}`);
  };
  if (value.length === 0) bad('empty');
  if (value !== value.trim()) bad('leading/trailing whitespace');
  if (value.includes('\0')) bad('contains NUL');
  if (value.includes('/') || value.includes('\\')) bad('path separators are not allowed — use a repo-local basename');
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) bad('absolute paths are not allowed');
  if (value !== path.posix.basename(value) || value !== path.win32.basename(value)) {
    bad('must be a plain basename in both path dialects');
  }
  if (value === '.' || value === '..') bad('not a filename');
  const lower = value.toLowerCase();
  const textSurface =
    value === 'AGENTS.md' ||
    lower.endsWith('.md') ||
    lower.endsWith('.txt') ||
    lower.endsWith('.rules') ||
    /^\.[a-z0-9_-]+rules$/.test(value);
  if (!textSurface) bad('not a text rules surface (.md/.txt/.rules, AGENTS.md, or a hidden *rules file)');
  const reservedAliases = ['.mcp.json', '.claude', '.codex', '.agents', 'claude.md'];
  if (reservedAliases.includes(lower)) bad('aliases a managed destination');
  if (lower === 'agents.md' && value !== 'AGENTS.md') bad('AGENTS.md sharing must be byte-exact AGENTS.md');
  return value;
}

/** Pure destination-owner arithmetic: one collision key per (repo, case-folded
 * POSIX path); equal-path aliases require one writer id, and file/ancestor
 * prefix collisions reject in both orders. Adapter order and marker presence
 * never resolve a collision. */
export function buildDestinationWriterMap(claims: readonly DestinationClaim[]): DestinationWriterMap {
  const foldedPath = (relativePath: string): string =>
    path.posix.normalize(relativePath.split('\\').join('/')).toLowerCase();
  const map = new Map<string, DestinationClaim[]>();
  for (const claim of claims) {
    const key = `${path.resolve(claim.repoRoot)}\0${foldedPath(claim.relativePath)}`;
    const bucket = map.get(key) ?? [];
    bucket.push(claim);
    map.set(key, bucket);
  }
  for (const [key, bucket] of map) {
    const writerIds = [...new Set(bucket.map((c) => c.writerId))].sort();
    if (writerIds.length > 1) {
      throw new Error(
        `destination owner collision at ${key.split('\0')[1]}: incompatible writers ${writerIds.join(' vs ')}`
      );
    }
  }
  const byRepo = new Map<string, Array<{ folded: string; writerId: string }>>();
  for (const claim of claims) {
    const repo = path.resolve(claim.repoRoot);
    const list = byRepo.get(repo) ?? [];
    list.push({ folded: foldedPath(claim.relativePath), writerId: claim.writerId });
    byRepo.set(repo, list);
  }
  for (const [repo, list] of byRepo) {
    for (const a of list) {
      for (const b of list) {
        if (a.folded !== b.folded && b.folded.startsWith(`${a.folded}/`)) {
          throw new Error(
            `destination prefix collision in ${repo}: ${a.writerId} owns '${a.folded}' which is an ancestor of ` +
              `${b.writerId}'s '${b.folded}'`
          );
        }
      }
    }
  }
  return map;
}

const SKILLS_TREE_RELATIVE = path.posix.join('.agents', 'skills');

function buildClaims(
  finalRepos: readonly string[],
  finalHarnesses: readonly string[],
  genericRulesFile: string | null
): DestinationClaim[] {
  const claims: DestinationClaim[] = [];
  for (const repoRoot of finalRepos) {
    for (const harness of finalHarnesses) {
      if (harness === 'claude-code') {
        claims.push(
          { repoRoot, relativePath: '.mcp.json', writerId: 'claude-mcp-json' },
          { repoRoot, relativePath: path.posix.join('.claude', 'settings.json'), writerId: 'claude-hooks-json' },
          { repoRoot, relativePath: 'CLAUDE.md', writerId: 'claude-rules' }
        );
      } else if (harness === 'codex') {
        claims.push(
          { repoRoot, relativePath: path.posix.join('.codex', 'config.toml'), writerId: 'codex-config-toml' },
          { repoRoot, relativePath: 'AGENTS.md', writerId: 'agents-rules' }
        );
      } else if (harness === 'generic' && genericRulesFile !== null) {
        claims.push({
          repoRoot,
          relativePath: genericRulesFile,
          writerId: genericRulesFile === 'AGENTS.md' ? 'agents-rules' : 'generic-rules',
        });
      }
    }
    // Reserved repo-scope skill root: participates in alias/prefix arithmetic
    // but is never asserted or created by runInit — Task 2 owns its lifecycle.
    claims.push({ repoRoot, relativePath: SKILLS_TREE_RELATIVE, writerId: 'skills-tree', collisionOnly: true });
  }
  return claims;
}

interface StoredExpectations {
  hasKey: boolean;
  harnesses: string[];
  genericRulesFile: string | null;
  malformed: string | null;
}

const KNOWN_HARNESSES = ['claude-code', 'codex', 'generic'];

function readStoredExpectations(metadata: Record<string, unknown> | null): StoredExpectations {
  const out: StoredExpectations = { hasKey: false, harnesses: [], genericRulesFile: null, malformed: null };
  if (metadata === null) return out;
  if ('capture_harnesses' in metadata) {
    out.hasKey = true;
    const raw = metadata.capture_harnesses;
    if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string' || !KNOWN_HARNESSES.includes(v))) {
      out.malformed = `metadata.capture_harnesses is malformed (${JSON.stringify(raw)}) — re-run mai init to repair`;
      return out;
    }
    out.harnesses = raw.filter((v): v is string => typeof v === 'string');
  }
  if ('generic_rules_file' in metadata) {
    const raw = metadata.generic_rules_file;
    if (typeof raw !== 'string') {
      out.malformed = `metadata.generic_rules_file is malformed (${JSON.stringify(raw)}) — re-run mai init to repair`;
      return out;
    }
    out.genericRulesFile = raw;
  }
  return out;
}

/** Legacy first-write reconstruction: only the contracts the legacy verifier
 * could actually observe — unconditional Claude, marker-triggered Codex, and
 * marker-triggered AGENTS.md generic — evaluated for EVERY registered repo. */
async function reconstructLegacyExpectations(
  repos: readonly string[]
): Promise<{ harnesses: string[]; genericRulesFile: string | null }> {
  const { MCP_MARKER } = await import('../capture/codex.js');
  const harnesses = new Set<string>(['claude-code']);
  let genericRulesFile: string | null = null;
  for (const repo of repos) {
    const codexRaw = await readTextOrNull(path.join(repo, '.codex', 'config.toml'));
    const hasCodexMarker = codexRaw !== null && codexRaw.includes(MCP_MARKER);
    if (hasCodexMarker) harnesses.add('codex');
    const agentsRaw = await readTextOrNull(path.join(repo, 'AGENTS.md'));
    if (agentsRaw !== null && agentsRaw.includes(RULES_MARKER) && !hasCodexMarker) {
      harnesses.add('generic');
      genericRulesFile = 'AGENTS.md';
    }
  }
  return { harnesses: [...harnesses], genericRulesFile };
}

function draftPrompt(slug: string): string {
  return [
    `Read this repository (and sibling repos listed in its .mcp.json mai-mcp env if any)`,
    `and draft three starter context topics for the mai-mcp brain. Write the files to`,
    `${BRAIN_ROOT}/docs/context/${slug}/_drafts/: overview.md, architecture.md,`,
    `conventions.md. Each file MUST start with YAML frontmatter (title, when, keywords`,
    `comma-separated, always: true for overview only) followed by a body with a`,
    `'## TL;DR' section. Source from the repo's own docs (README, SOURCE_OF_TRUTH.md,`,
    `RULES.md, ROADMAP.md if present) and the code itself. Factual only — do not invent`,
    `status or dates. Do not write anywhere except the _drafts directory.`,
  ].join('\n');
}

export interface DraftTopicsOps {
  env: NodeJS.ProcessEnv;
  find: typeof findExecutable;
  spawn: typeof spawnArgv;
  process: Pick<ProcessOps, 'processBirthId' | 'terminateTree'>;
  timeoutMs: number;
  maxBufferBytes: number;
}

export function defaultDraftTopicsOps(): DraftTopicsOps {
  return { env: { ...process.env }, find: findExecutable, spawn: spawnArgv,
    process: defaultProcessOps(), timeoutMs: 0, maxBufferBytes: 64 * 1024 * 1024 };
}

export async function runDraftTopics(
  prompt: string, productRoot: string, ops: DraftTopicsOps = defaultDraftTopicsOps(),
): Promise<void> {
  const env = { ...ops.env };
  const executable = ops.find('claude', { env });
  if (!executable) throw new Error('claude executable unavailable');
  const child = ops.spawn(executable,
    ['-p', prompt, '--permission-mode', 'acceptEdits', '--add-dir', BRAIN_ROOT],
    { cwd: productRoot, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  const pid = child.pid;
  const birth = pid === undefined ? Promise.resolve(null)
    : ops.process.processBirthId(pid).catch(() => null);
  await new Promise<void>((resolve, reject) => {
    let done = false;
    let ending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => { if (timer !== undefined) clearTimeout(timer); };
    const destroy = () => { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); };
    const fail = (reason: Error): void => {
      if (done || ending) return;
      ending = true;
      clear();
      void (async () => {
        let failure = reason;
        try {
          const captured = await birth;
          if (pid !== undefined && child.exitCode === null && child.signalCode === null) {
            if (captured === null) throw new Error('draft process identity unavailable; termination refused');
            await ops.process.terminateTree(pid, async () => child.exitCode === null
              && child.signalCode === null && await ops.process.processBirthId(pid) === captured);
          }
        } catch {
          failure = new Error(`${reason.message}; draft process cleanup could not be proved`);
        } finally {
          destroy();
          done = true;
          reject(failure);
        }
      })();
    };
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout?.on('data', (data: Buffer) => {
      stdoutBytes += data.length;
      if (stdoutBytes > ops.maxBufferBytes) fail(new Error('draft stdout exceeded buffer limit'));
    });
    child.stderr?.on('data', (data: Buffer) => {
      stderrBytes += data.length;
      if (stderrBytes > ops.maxBufferBytes) fail(new Error('draft stderr exceeded buffer limit'));
    });
    child.stdin?.on('error', () => fail(new Error('draft stdin failed')));
    child.stdout?.on('error', () => fail(new Error('draft stdout failed')));
    child.stderr?.on('error', () => fail(new Error('draft stderr failed')));
    child.on('error', () => fail(new Error('draft process launch failed')));
    child.on('close', (code, signal) => {
      if (done || ending) return;
      done = true;
      clear();
      destroy();
      if (code === 0 && signal === null) resolve();
      else reject(new Error(`draft process exited ${code ?? signal ?? 'unknown'}`));
    });
    if (ops.timeoutMs > 0) timer = setTimeout(() => fail(new Error('draft process timed out')), ops.timeoutMs);
    child.stdin?.end();
  });
}

export async function runInit(args: InitArgs): Promise<InitResult> {
  const summary: string[] = [];

  // A dev-DB URL with a bad scheme is an argument error and fails onboarding
  // NOW with the named message — the graph step's non-fatal catch below exists
  // for real build failures and must never swallow a typo'd scheme (plan 34).
  if (args.postgres) {
    const { dialectOf } = await import('../graph/extractors/db.js');
    dialectOf(args.postgres);
  }

  // 1. Validate everything cheap BEFORE any DB row, directory, or file write.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(args.slug)) {
    throw new Error(`Invalid slug '${args.slug}' — lowercase kebab-case only.`);
  }
  const harnesses = normalizeHarnesses(args.harnesses);
  const { listCaptureAdapters, getCaptureAdapter } = await import('../capture/adapter.js');
  const known = listCaptureAdapters();
  for (const h of harnesses) {
    if (!known.includes(h)) {
      throw new Error(`Unknown harness '${h}'. Supported: ${known.join(', ')}.`);
    }
  }
  if (args.rulesFile !== undefined && !(harnesses.length === 1 && harnesses[0] === 'generic')) {
    throw new Error(`--rules-file applies only when the harness list is exactly ['generic'].`);
  }
  const invocationCwd = process.cwd();
  const productRoot = canonicalRegisteredRoots([args.root], {
    baseDir: invocationCwd,
    rejectRelative: false,
  })[0];
  const explicitRepos = canonicalRegisteredRoots(args.repos, {
    baseDir: invocationCwd,
    rejectRelative: args.replaceRepos === true,
  });
  if (args.replaceRepos === true && explicitRepos.length === 0) {
    throw new Error('--replace-repos requires at least one explicit --repo');
  }
  if (args.replaceRepos !== true && (args.repoMaps?.length ?? 0) > 0) {
    throw new Error('--repo-map is valid only with --replace-repos');
  }
  const repos = explicitRepos.length > 0 ? explicitRepos : [productRoot];
  const excludes = (args.excludes ?? []).map((entry) => canonicalPhysicalPath(entry, productRoot));
  const repairMaps = new Map<string, string>();
  for (const entry of args.repoMaps ?? []) {
    if (repairMaps.has(entry.storedRoot)) throw new Error(`Duplicate --repo-map source: ${entry.storedRoot}`);
    if (!path.isAbsolute(entry.targetRoot)) {
      throw new Error(`--repo-map target must be absolute: ${entry.targetRoot}`);
    }
    const target = canonicalRegisteredRoots([entry.targetRoot], {
      baseDir: productRoot,
      rejectRelative: true,
    })[0];
    repairMaps.set(entry.storedRoot, target);
  }

  // Plan 31: every projection writer (init/upgrade/link) serializes on one
  // cross-process, slug-keyed advisory lock. It is taken BEFORE the
  // authoritative metadata read and held through the adapter fleet writes,
  // metadata persistence, the explicit link refresh, and the post-init verify —
  // so no concurrent producer can invalidate the authority this run froze.
  // Slug-keyed, so it also covers a fresh init before a project row exists.
  return withProjectProjectionLock(args.slug, async (): Promise<InitResult> => {
  // 2. ONE read-only project lookup → derive the complete intended end state.
  const pool = getPool();
  const existing = await pool.query<{ id: string; path: string | null; metadata: Record<string, unknown> | null }>(
    `SELECT id, path, metadata FROM projects WHERE slug = $1`,
    [args.slug]
  );
  const prevMeta = existing.rows.length > 0 ? existing.rows[0].metadata : null;
  if (args.afterProjectionRead !== undefined) await args.afterProjectionRead();
  const prevRepos = isRecord(prevMeta) && Array.isArray(prevMeta.repos)
    ? prevMeta.repos.filter((r): r is string => typeof r === 'string')
    : [];
  const prevExcludes = isRecord(prevMeta) && Array.isArray(prevMeta.graph_excludes)
    ? prevMeta.graph_excludes.filter((r): r is string => typeof r === 'string')
    : [];
  const stored = readStoredExpectations(prevMeta);
  if (stored.malformed !== null) {
    throw new Error(stored.malformed);
  }
  const evidenceRows = existing.rows.length === 0
    ? []
    : (await pool.query<{ repo_path: string }>(
      `SELECT DISTINCT repo_path FROM code_commits WHERE project_id = $1 AND repo_path IS NOT NULL`,
      [existing.rows[0].id],
    )).rows;
  const canonicalLegacyDirectory = (raw: string, active: boolean): string => {
    const mapped = repairMaps.get(raw);
    if (mapped !== undefined) {
      if (active && owningRegisteredRepo(mapped, repos) === null) {
        throw new Error(`--repo-map target for active metadata is outside the replacement union: ${mapped}`);
      }
      return mapped;
    }
    try {
      const physical = canonicalRegisteredRoots([raw], { baseDir: productRoot, rejectRelative: true })[0];
      return physical;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Cannot canonicalize stored path '${raw}' (${detail}). Repair with: mai init ${args.slug} --root ${productRoot} --replace-repos --repo <absolute-repo> --repo-map '${raw}' <absolute-root>`,
      );
    }
  };
  const priorCanonicalRepos = prevRepos.map((raw) => canonicalLegacyDirectory(raw, true));
  const priorCanonicalExcludes = prevExcludes.flatMap((raw): string[] => {
    const mapped = repairMaps.get(raw);
    if (mapped !== undefined) {
      if (owningRegisteredRepo(mapped, repos) === null) {
        throw new Error(`--repo-map target for active metadata is outside the replacement union: ${mapped}`);
      }
      return [mapped];
    }
    if (!path.isAbsolute(raw)) {
      throw new Error(
        `Cannot canonicalize stored path '${raw}' (stored exclude is relative). Repair with: mai init ${args.slug} --root ${productRoot} --replace-repos --repo <absolute-repo> --repo-map '${raw}' <absolute-root>`,
      );
    }
    if (!fsSync.existsSync(raw)) {
      throw new Error(
        `Cannot canonicalize stored path '${raw}' (stored exclude is missing). Repair with: mai init ${args.slug} --root ${productRoot} --replace-repos --repo <absolute-repo> --repo-map '${raw}' <absolute-root>`,
      );
    }
    const physical = canonicalPhysicalPath(raw, productRoot);
    return args.replaceRepos === true && owningRegisteredRepo(physical, repos) === null ? [] : [physical];
  });
  const canonicalEvidence = new Map<string, string>();
  for (const row of evidenceRows) canonicalEvidence.set(row.repo_path, canonicalLegacyDirectory(row.repo_path, false));
  const finalRepos = args.replaceRepos === true
    ? [...repos]
    : [...new Set([...priorCanonicalRepos, ...repos])].sort();
  const finalExcludes = [...new Set([...priorCanonicalExcludes, ...excludes])].sort();
  if (args.replaceRepos === true) {
    const storedPaths = new Set([...prevRepos, ...prevExcludes, ...evidenceRows.map((row) => row.repo_path)]);
    for (const source of repairMaps.keys()) {
      if (!storedPaths.has(source)) throw new Error(`--repo-map source is not a stored path: ${source}`);
    }
  }

  let priorHarnesses: string[];
  let priorGeneric: string | null;
  if (stored.hasKey) {
    priorHarnesses = stored.harnesses;
    priorGeneric = stored.genericRulesFile;
  } else {
    // Legacy row (or fresh project). Reconstruction only matters when a row
    // already exists; a fresh project has no legacy contracts to preserve.
    if (existing.rows.length > 0) {
      const legacy = await reconstructLegacyExpectations(finalRepos);
      priorHarnesses = legacy.harnesses;
      priorGeneric = legacy.genericRulesFile ?? stored.genericRulesFile;
    } else {
      priorHarnesses = [];
      priorGeneric = null;
    }
  }
  const finalHarnesses = [...new Set([...priorHarnesses, ...harnesses])].sort();

  // Resolve and validate the generic basename BEFORE any write. An explicit
  // generic run replaces the prior value deliberately; other runs preserve it.
  let finalGenericRulesFile: string | null = null;
  if (finalHarnesses.includes('generic')) {
    const currentExplicit = harnesses.includes('generic')
      ? validateRulesFileName(args.rulesFile ?? 'AGENTS.md')
      : null;
    finalGenericRulesFile = currentExplicit ?? priorGeneric ?? 'AGENTS.md';
    validateRulesFileName(finalGenericRulesFile);
  } else if (priorGeneric !== null) {
    finalGenericRulesFile = validateRulesFileName(priorGeneric);
  }

  // 3. Destination-owner map over the COMPLETE immutable claim set — exactly
  // once, before filesystem assertion, adapter construction, metadata
  // mutation, or any managed write. A builder rejection propagates unchanged.
  const claims = buildClaims(finalRepos, finalHarnesses, finalGenericRulesFile);
  const builder = args.destinationMapBuilder ?? buildDestinationWriterMap;
  builder(claims);

  // 4. Side-effect-free assertion of every unique adapter destination in
  // every final repo (collision-only reservations excluded). If any rejects,
  // no directory, file, or DB byte has changed.
  const asserted = new Set<string>();
  for (const claim of claims) {
    if (claim.collisionOnly === true) continue;
    const key = `${path.resolve(claim.repoRoot)}\0${claim.relativePath}`;
    if (asserted.has(key)) continue;
    asserted.add(key);
    assertRepoManagedDestination(claim.repoRoot, claim.relativePath);
  }

  // Authoritative repair is the first mutation and commits atomically before
  // projection installation. Later wiring failures leave this root repair in
  // place and are reported as post-repair work.
  if (args.replaceRepos === true && existing.rows.length > 0) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE projects
         SET path = $1,
             metadata = jsonb_set(
               jsonb_set(COALESCE(metadata, '{}'::jsonb), '{repos}', $2::jsonb),
               '{graph_excludes}', $3::jsonb
             ),
             last_active_at = NOW()
         WHERE id = $4`,
        [productRoot, JSON.stringify(finalRepos), JSON.stringify(finalExcludes), existing.rows[0].id],
      );
      for (const [storedPath, physicalPath] of canonicalEvidence) {
        if (storedPath === physicalPath) continue;
        await client.query(
          `UPDATE code_commits SET repo_path = $1 WHERE project_id = $2 AND repo_path = $3`,
          [physicalPath, existing.rows[0].id, storedPath],
        );
      }
      await client.query('COMMIT');
      summary.push(`project roots: authoritative replacement committed (${finalRepos.length} repos)`);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // 5. Construct every final adapter, then install the complete
  // finalRepos × finalHarnesses cross-product. Writes happen only here, each
  // through the contained writer's prepare-then-commit path.
  const adapters = finalHarnesses.map((h) =>
    getCaptureAdapter(h, h === 'generic' && finalGenericRulesFile !== null ? { rulesFile: finalGenericRulesFile } : undefined)
  );
  try {
    for (const repo of finalRepos) {
      for (const adapter of adapters) {
        const res = await adapter.install(repo, args.slug);
        summary.push(`${repo} [${adapter.harness}]: ${res.lines.join(', ')}`);
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (args.replaceRepos === true && existing.rows.length > 0) {
      throw new Error(`Authoritative root repair committed; post-repair wiring failed: ${detail}`);
    }
    throw error;
  }

  // DB context makes absent linked_projects authoritative empty. Preserve-
  // from-file belongs only to standalone builders that truly lack DB context.
  // This unconditional explicit [] scrubs a stale runtime grant and remains
  // byte-identical for a genuinely fresh/unlinked project (R10).
  const declaredLinks = isRecord(prevMeta) && Array.isArray(prevMeta.linked_projects)
    ? prevMeta.linked_projects.filter((v): v is string => typeof v === 'string')
    : [];
  const { applyEnvChanges } = await import('./link.js');
  for (const repo of finalRepos) {
    const refresh = await applyEnvChanges(repo, args.slug, declaredLinks);
    summary.push(...refresh.lines.map((l) => `links: ${l}`));
    if (refresh.refusedLegacy) {
      throw new Error(`links: LEGACY block in ${repo} — run mai upgrade ${args.slug} then re-run mai init`);
    }
  }

  // 6. Persist the EXACT same final unions through one parameterized metadata
  // update — never a partial current-run subset.
  const metadataSets = [
    { path: '{repos}', value: JSON.stringify(finalRepos) },
    { path: '{graph_excludes}', value: JSON.stringify(finalExcludes) },
    { path: '{capture_harnesses}', value: JSON.stringify(finalHarnesses) },
    ...(finalGenericRulesFile !== null
      ? [{ path: '{generic_rules_file}', value: JSON.stringify(finalGenericRulesFile) }]
      : []),
  ];
  if (existing.rows.length > 0) {
    let expr = `COALESCE(metadata, '{}'::jsonb)`;
    const params: string[] = [];
    for (const set of metadataSets) {
      params.push(set.value);
      expr = `jsonb_set(${expr}, '${set.path}', $${params.length}::jsonb)`;
    }
    params.push(productRoot, args.slug);
    await pool.query(
      `UPDATE projects SET metadata = ${expr}, path = $${params.length - 1}, last_active_at = NOW()
       WHERE slug = $${params.length}`,
      params
    );
    summary.push(
      `project row: updated (repos: ${finalRepos.length}, harnesses: ${finalHarnesses.join('+')}, graph excludes: ${finalExcludes.length})`
    );
  } else {
    const metaEntries: Record<string, unknown> = {
      repos: finalRepos,
      graph_excludes: finalExcludes,
      capture_harnesses: finalHarnesses,
    };
    if (finalGenericRulesFile !== null) metaEntries.generic_rules_file = finalGenericRulesFile;
    await pool.query(
      `INSERT INTO projects (slug, name, path, metadata) VALUES ($1, $2, $3, $4::jsonb)`,
      [args.slug, args.slug, productRoot, JSON.stringify(metaEntries)]
    );
    summary.push(
      `project row: created (repos: ${finalRepos.length}, harnesses: ${finalHarnesses.join('+')}, graph excludes: ${finalExcludes.length})`
    );
  }

  // 7. Brain dirs.
  const draftsDir = path.join(BRAIN_ROOT, 'docs', 'context', args.slug, '_drafts');
  const trackingDir = path.join(BRAIN_ROOT, 'docs', 'tracking', args.slug);
  await fs.mkdir(draftsDir, { recursive: true });
  await fs.mkdir(trackingDir, { recursive: true });
  summary.push(`brain dirs: docs/context/${args.slug}/_drafts, docs/tracking/${args.slug}`);

  // 8. Graduated-rules render (plan 27), once per project, through the
  // contained policy — the recorded post-init projection default is unchanged
  // for background/healing writers.
  try {
    const row = await pool.query<{ id: string }>(`SELECT id FROM projects WHERE slug = $1`, [args.slug]);
    const { writeGraduatedRulesBlocks } = await import('../rules-render.js');
    const lines = await writeGraduatedRulesBlocks(row.rows[0].id, { writePolicy: 'repo-contained' });
    if (lines.length > 0) summary.push(`graduated rules: ${lines.join(', ')}`);
  } catch (err) {
    // AMENDMENT A10 (plan 27, finding ff719d60): non-fatal is deliberate, but a
    // SKIPPED line with no recovery command leaves the operator with no idea
    // that upgrade is the heal — the sibling graph handler below names its own.
    const message = err instanceof Error ? err.message : String(err);
    summary.push(
      `graduated rules: SKIPPED (${message.split('\n')[0]}) — heal later with \`mai upgrade ${args.slug}\``
    );
  }

  // 9. Structure graph — mai-graph (the Graphify swap, plan 4c). In-process,
  //    local + key-less by construction. Non-fatal.
  try {
    const row = await pool.query<{ id: string }>(`SELECT id FROM projects WHERE slug = $1`, [args.slug]);
    const { runGraphBuild } = await import('../graph/build.js');
    const graphSummary = await runGraphBuild({ projectId: row.rows[0].id, slug: args.slug, dbUrl: args.postgres });
    for (const line of graphSummary.split('\n')) {
      if (line.startsWith('- ')) summary.push(`graph: ${line.slice(2)}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    summary.push(
      `graph: SKIPPED (${message.split('\n')[0]}) — build later with \`mai graph build --project ${args.slug}\``
    );
  }

  // 10. Draft topics (optional; non-fatal).
  if (args.draftTopics) {
    try {
      await runDraftTopics(draftPrompt(args.slug), productRoot);
      const written = await fs.readdir(draftsDir).catch(() => [] as string[]);
      if (written.length > 0) {
        summary.push(`topic drafts: ${written.length} file(s) → docs/context/${args.slug}/_drafts/ (review before moving out)`);
      } else {
        summary.push(`topic drafts: claude ran but wrote no files (headless permission?) — write them by hand instead`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary.push(`topic drafts: SKIPPED (${message.split('\n')[0]})`);
    }
  }

  // 11. Subscription-provider consent. --yes derives an automatic choice from
  // real availability; automatic runs never prompt and never overwrite an
  // operator's existing provider. Only a typed authority conflict escapes the
  // best-effort catch — all other consent failures stay deliberately SKIPPED.
  const {
    maybeOfferSubscriptionProvider,
    maybeOfferLocalEmbeddings,
    stdConsentIO,
    subscriptionAvailability,
    LlmAuthorityConflictError,
    defaultEnvPath,
  } = await import('./llm-consent.js');
  const { PRE_FILE_LLM_AUTHORITY } = await import('../env.js');
  const authority = args.preFileLlmAuthority ?? PRE_FILE_LLM_AUTHORITY;
  const envFile = args.consentEnvFile ?? defaultEnvPath();
  const automatic = args.yes === true && args.llm === undefined;
  let effectiveLlm = args.llm;
  let consentIO = stdConsentIO();
  if (automatic) {
    const avail = subscriptionAvailability();
    if (avail.claudeCode && !avail.codexCli) effectiveLlm = 'claude-code';
    else if (avail.codexCli && !avail.claudeCode) effectiveLlm = 'codex-cli';
    else effectiveLlm = undefined; // both or none: never auto-pick, never map to 'none'
    consentIO = { ...consentIO, isTTY: false }; // --yes never prompts
  }
  try {
    const consent = await maybeOfferSubscriptionProvider(consentIO, effectiveLlm, envFile, {
      automatic,
      preFileLlmAuthority: authority,
    });
    if (consent) summary.push(consent);
  } catch (err) {
    if (err instanceof LlmAuthorityConflictError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    summary.push(`llm: consent SKIPPED (${message.split('\n')[0]})`);
  }

  // 11b. local-embeddings consent — separate try/catch so an embeddings
  // failure is never reported as an llm-consent failure.
  try {
    const effectiveEmbeddings = args.embeddings ?? (args.yes === true ? 'local' : undefined);
    const emb = await maybeOfferLocalEmbeddings(consentIO, effectiveEmbeddings, envFile);
    if (emb) summary.push(emb);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    summary.push(`embeddings: consent SKIPPED (${message.split('\n')[0]})`);
  }

  // 12. Post-verify — init trusts nothing it just wrote. Failure exits
  // non-zero (via the throw below); files stay in place — fix and re-run.
  const { verifyProject, formatVerification } = await import('./verify.js');
  const verification = await verifyProject(args.slug, {
    sharedSkills: args.sharedSkillsVerification ?? 'required',
  });
  summary.push(`verify: ${verification.ok ? 'PASS' : 'FAIL — details below'}`);

  // 13. Summary.
  if (args.printSummary !== false) {
    console.log([
      `mai init '${args.slug}' complete.`,
      ``,
      ...summary.map((s) => `  • ${s}`),
      ``,
      `Next:`,
      ...initNextSteps(args.slug, Boolean(args.postgres)),
    ].filter((l) => l !== undefined).join('\n'));
  }

  if (!verification.ok) {
    if (args.printSummary !== false) console.error('\n' + formatVerification(verification));
    throw new Error(`post-init verification FAILED for '${args.slug}' — see report above.`);
  }

  return {
    slug: args.slug,
    root: productRoot,
    repos: finalRepos,
    harnesses: finalHarnesses,
    summary,
    verification,
  };
  });
}
