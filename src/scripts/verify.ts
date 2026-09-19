// mai verify — post-onboarding wiring checks. The repo list comes from the DB
// (projects.metadata.repos): verify checks what IS registered, never what the
// caller claims. No agent-facing surface — CLI + init only (pinning untouched).
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getPool } from '../db.js';
import { MAI_ROOT } from '../paths.js';
import { findManagedBlock, loadTemplate } from './managed-block.js';
import {
  CODEX_SAFE_READ_TOOLS,
  MCP_MARKER,
  findCodexBlock,
  findCodexToolPolicySections,
} from '../capture/codex.js';
import { validateRulesFileName } from './init.js';
import { MAI_HOOKS, MAI_HOOK_DELEGATES, readCodexNotify, readManagedHookCommand } from '../hook-wiring.js';
import { tomlString } from '../command-encoding.js';
import type { SkillsIO } from './skills.js';
import type { BuildInfo } from '../build-info.js';

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

/** Plan 15 Task 3: persisted harness expectations. `undefined` expectation =
 * legacy row → today's compatibility behavior (Claude required, Codex/AGENTS
 * marker-triggered) until the next successful init writes explicit keys. */
export interface RepoHarnessExpectation {
  harnesses: string[];
  genericRulesFile: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function linkedProjectsFromMetadata(metadata: Record<string, unknown> | null): string[] {
  return isRecord(metadata) && Array.isArray(metadata.linked_projects)
    ? metadata.linked_projects.filter((v): v is string => typeof v === 'string')
    : [];
}

export interface RepoVerification {
  repo: string;
  ok: boolean;
  checks: CheckResult[];
}

export interface ProjectVerification {
  slug: string;
  ok: boolean;
  shared: CheckResult[];
  repos: RepoVerification[];
  smoke?: CheckResult;
}

const SERVER_ENTRY = path.join(MAI_ROOT, 'build', 'index.js');
const CLAUDE_MD_MARKER = 'MEMORY BRAIN (mai-mcp)';

async function readTextOrNull(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false
  );
}

interface HookCmd {
  type?: string;
  command?: string;
}
interface HookEntry {
  hooks?: HookCmd[];
}

function hookCommands(hooks: Record<string, unknown>, event: string): string[] {
  const entries = (hooks[event] ?? []) as HookEntry[];
  return entries.flatMap((e) => (e.hooks ?? []).map((h) => h.command ?? ''));
}

/** Canonical generated values only; this is not a general TOML parser. */
export function managedCodexEnvMatches(
  managed: string | null, key: string, expected: string | undefined,
): boolean {
  if (managed === null || !/^MAI_[A-Z_]+$/.test(key)) return false;
  let inEnv = false;
  let envTables = 0;
  const assignments: string[] = [];
  for (const raw of managed.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inEnv = line === '[mcp_servers.mai-mcp.env]';
      if (inEnv) envTables++;
      continue;
    }
    if (inEnv && new RegExp(`^${key}\\s*=`).test(line)) assignments.push(line);
  }
  if (envTables !== 1) return false;
  return expected === undefined ? assignments.length === 0
    : assignments.length === 1 && assignments[0] === `${key} = ${tomlString(expected)}`;
}

interface McpServerEntry {
  args?: string[];
  env?: Record<string, string>;
}

/** Pure-FS checks for one repo (the unit tests' surface — no DB). With an
 * explicit expectation, validates every AND ONLY expected adapter contract —
 * missing expected files fail even when no marker remains. Without one
 * (legacy row), keeps the compatibility behavior: Claude required,
 * Codex/AGENTS verified only when their managed marker is present. */
export async function verifyRepo(
  repoPath: string,
  slug: string,
  expectation?: RepoHarnessExpectation,
  expectedRoot: string = repoPath,
  linkedProjects: readonly string[] = [],
  checkLinkedProjects: boolean = true
): Promise<RepoVerification> {
  const wantLinked = linkedProjects.length > 0
    ? [...linkedProjects].sort().join(',') : undefined;
  const checks: CheckResult[] = [];
  const claudeExpected = expectation === undefined || expectation.harnesses.includes('claude-code');
  const codexExpected = expectation !== undefined && expectation.harnesses.includes('codex');
  const genericExpected = expectation !== undefined && expectation.harnesses.includes('generic');

  if (claudeExpected) {
    // .mcp.json — mai-mcp entry, slug, live server path, matching root.
    const mcp = await readJson(path.join(repoPath, '.mcp.json'));
    if (!mcp) {
      checks.push({ name: '.mcp.json', ok: false, detail: 'missing or unparseable' });
    } else {
      const serversRaw: unknown = mcp.mcpServers;
      const serverRaw: unknown = isRecord(serversRaw) ? serversRaw['mai-mcp'] : undefined;
      if (!isRecord(serverRaw)) {
        checks.push({ name: '.mcp.json', ok: false, detail: 'no mcpServers["mai-mcp"] entry' });
      } else {
        const problems: string[] = [];
        const args = Array.isArray(serverRaw.args) ? serverRaw.args : [];
        const entry = typeof args[0] === 'string' ? args[0] : '';
        const env = isRecord(serverRaw.env) ? serverRaw.env : {};
        const envSlug = typeof env.MAI_PROJECT_SLUG === 'string' ? env.MAI_PROJECT_SLUG : undefined;
        const envRoot = typeof env.MAI_PROJECT_ROOT === 'string' ? env.MAI_PROJECT_ROOT : undefined;
        const envLinked = typeof env.MAI_LINKED_PROJECTS === 'string' ? env.MAI_LINKED_PROJECTS : undefined;
        if (envSlug !== slug) {
          problems.push(`MAI_PROJECT_SLUG '${envSlug ?? '(unset)'}' ≠ '${slug}'`);
        }
        if (!(await exists(entry))) problems.push(`server entry missing on disk: ${entry || '(none)'}`);
        if (envRoot !== expectedRoot) {
          problems.push(`MAI_PROJECT_ROOT '${envRoot ?? '(unset)'}' ≠ '${expectedRoot}'`);
        }
        if (checkLinkedProjects && envLinked !== wantLinked) {
          problems.push(`MAI_LINKED_PROJECTS '${envLinked ?? '(unset)'}' ≠ '${wantLinked ?? '(unset)'}'`);
        }
        checks.push(
          problems.length > 0 ? { name: '.mcp.json', ok: false, detail: problems.join('; ') } : { name: '.mcp.json', ok: true }
        );
      }
    }

    // .claude/settings.json — all mai hooks, slug inline on SessionEnd + SessionStart.
    const settings = await readJson(path.join(repoPath, '.claude', 'settings.json'));
    if (!settings) {
      checks.push({ name: 'hooks', ok: false, detail: '.claude/settings.json missing or unparseable' });
    } else {
      const hooks = isRecord(settings.hooks) ? settings.hooks : {};
      const problems: string[] = [];
      for (const descriptor of MAI_HOOKS) {
        const recognized = hookCommands(hooks, descriptor.event).flatMap(command => {
          const parsed = readManagedHookCommand(command);
          return parsed?.mode === descriptor.mode ? [parsed] : [];
        });
        const current = recognized.filter(command => !command.legacy);
        const valid = current.some(command => !descriptor.projectScoped || command.project === slug);
        if (valid) continue;
        if (recognized.some(command => command.legacy)) {
          problems.push(`${descriptor.event} hook is a legacy Bash command — run mai upgrade`);
        } else if (recognized.length > 0 && descriptor.projectScoped) {
          problems.push(`${descriptor.event} hook lacks --project ${slug}`);
        } else {
          problems.push(`no mai-mcp ${descriptor.event} hook`);
        }
      }
      checks.push(problems.length > 0 ? { name: 'hooks', ok: false, detail: problems.join('; ') } : { name: 'hooks', ok: true });
    }

    checks.push(await markerFileCheck(repoPath, 'CLAUDE.md', 'memory-brain-block.md', true));
  }

  // Codex wiring. Explicit expectation: required outright. Legacy: only when
  // the managed marker is present.
  const codexRaw = await readTextOrNull(path.join(repoPath, '.codex', 'config.toml'));
  const codexMarkerPresent = codexRaw !== null && codexRaw.includes(MCP_MARKER);
  if (codexExpected && !codexMarkerPresent) {
    checks.push({
      name: '.codex/config.toml',
      ok: false,
      detail: 'missing expected codex wiring (file or managed marker absent) — re-run mai init --harness codex',
    });
  }
  if (codexMarkerPresent && (expectation === undefined || codexExpected) && codexRaw !== null) {
    const problems: string[] = [];
    const reports: string[] = [];
    const managed = findCodexBlock(codexRaw);
    if (!managedCodexEnvMatches(managed?.text ?? null, 'MAI_PROJECT_SLUG', slug)) problems.push(`MAI_PROJECT_SLUG ≠ "${slug}"`);
    if (!managedCodexEnvMatches(managed?.text ?? null, 'MAI_PROJECT_ROOT', expectedRoot)) problems.push(`MAI_PROJECT_ROOT ≠ "${expectedRoot}"`);
    const versioned = /^# \/mai-mcp-block v(\d+)$/m.exec(codexRaw);
    if (checkLinkedProjects && !managedCodexEnvMatches(managed?.text ?? null, 'MAI_LINKED_PROJECTS', wantLinked)) {
      problems.push('MAI_LINKED_PROJECTS does not match expected managed value');
    }
    const policies = findCodexToolPolicySections(codexRaw);
    const managedTools = managed === null
      ? []
      : policies.filter((policy) => policy.start >= managed.start && policy.end <= managed.end);
    if (managedTools.length > 0) {
      reports.push('approval overrides inside managed block — run mai upgrade');
    } else {
      const configured = CODEX_SAFE_READ_TOOLS.map((tool) => {
        const mode = policies.find((policy) => policy.tool === tool)?.mode;
        return mode === undefined || mode === null ? `${tool}=default` : `${tool}=${mode}`;
      });
      reports.push(
        policies.some((policy) => CODEX_SAFE_READ_TOOLS.some((tool) => tool === policy.tool))
          ? `safe-read approvals: ${configured.join(', ')}`
          : 'safe-read approvals: Codex defaults (project overrides absent)'
      );
    }
    if (!versioned) reports.unshift('legacy block (no version marker) — run mai upgrade');
    checks.push(
      problems.length > 0
        ? { name: '.codex/config.toml', ok: false, detail: problems.join('; ') }
        : {
            name: '.codex/config.toml',
            ok: true,
            detail: reports.join('; '),
          }
    );
  }

  // AGENTS.md / generic rules file.
  if (expectation === undefined) {
    // Legacy: checked only when the file exists with our marker.
    const agentsMd = await readTextOrNull(path.join(repoPath, 'AGENTS.md'));
    if (agentsMd !== null && agentsMd.includes(CLAUDE_MD_MARKER)) {
      checks.push(await markerFileCheck(repoPath, 'AGENTS.md', 'memory-brain-block-agents.md', true));
    }
  } else {
    if (codexExpected) {
      checks.push(await markerFileCheck(repoPath, 'AGENTS.md', 'memory-brain-block-agents.md', true));
    }
    if (genericExpected) {
      const stored = expectation.genericRulesFile;
      if (stored === null) {
        checks.push({
          name: 'generic rules file',
          ok: false,
          detail: 'metadata.generic_rules_file is missing while generic is expected — re-run mai init --harness generic --rules-file <name>',
        });
      } else {
        let safe: string | null = null;
        try {
          safe = validateRulesFileName(stored);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          checks.push({
            name: 'generic rules file',
            ok: false,
            detail: `${message} — re-run mai init --harness generic --rules-file <safe-name> to repair the stored value`,
          });
        }
        if (safe !== null && !(safe === 'AGENTS.md' && codexExpected)) {
          checks.push(await markerFileCheck(repoPath, safe, 'memory-brain-block-agents.md', true));
        }
      }
    }
  }

  return { repo: repoPath, ok: checks.every((c) => c.ok), checks };
}

/** One managed rules file: exactly one marker; staleness reported, never a
 * failure. `required` makes a missing file FAIL (explicit expectations). */
async function markerFileCheck(
  repoPath: string,
  fileName: string,
  templateName: string,
  required: boolean
): Promise<CheckResult> {
  const content = await readTextOrNull(path.join(repoPath, fileName));
  if (content === null) {
    return required
      ? { name: fileName, ok: false, detail: 'missing' }
      : { name: fileName, ok: true, detail: 'absent (not expected)' };
  }
  const count = content.split(CLAUDE_MD_MARKER).length - 1;
  if (count !== 1) {
    return { name: fileName, ok: false, detail: `brain-block marker appears ${count}× (want exactly 1)` };
  }
  const block = findManagedBlock(content);
  const { version: tpl } = await loadTemplate(templateName);
  const v = block?.version ?? null;
  const detail =
    v === null
      ? `legacy block (no version sentinel) — template is v${tpl}; run mai upgrade`
      : v < tpl
        ? `block v${v} < template v${tpl} — run mai upgrade`
        : undefined;
  return { name: fileName, ok: true, detail };
}

/** Boot the server pinned to the slug, require an MCP initialize response. */
async function smokeTest(slug: string, root: string): Promise<CheckResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [SERVER_ENTRY], {
      env: { ...process.env, MAI_PROJECT_SLUG: slug, MAI_PROJECT_ROOT: root },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    const settle = (result: CheckResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };
    const timer = setTimeout(
      () => settle({ name: 'smoke', ok: false, detail: 'timeout (10s) waiting for initialize response' }),
      10_000
    );
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      if (buf.includes('"serverInfo"')) settle({ name: 'smoke', ok: true });
    });
    child.on('error', (err: Error) => settle({ name: 'smoke', ok: false, detail: err.message }));
    child.on('exit', (code: number | null) =>
      settle({ name: 'smoke', ok: false, detail: `server exited (${String(code)}) before responding` })
    );
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mai-verify', version: '0' } },
      }) + '\n'
    );
  });
}

const KNOWN_HARNESSES = ['claude-code', 'codex', 'generic'];

/** Narrow persisted expectation keys without casts. Malformed values become a
 * FAIL check with a repair instruction — they never default to passing. */
export function readExpectation(metadata: Record<string, unknown> | null): {
  expectation: RepoHarnessExpectation | undefined;
  failures: CheckResult[];
} {
  if (!isRecord(metadata) || !('capture_harnesses' in metadata)) {
    return { expectation: undefined, failures: [] };
  }
  const failures: CheckResult[] = [];
  const raw: unknown = metadata.capture_harnesses;
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string' || !KNOWN_HARNESSES.includes(v))) {
    failures.push({
      name: 'metadata',
      ok: false,
      detail: `metadata.capture_harnesses is malformed (${JSON.stringify(raw)}) — re-run mai init to repair`,
    });
    return { expectation: undefined, failures };
  }
  const harnesses = raw.filter((v): v is string => typeof v === 'string');
  let genericRulesFile: string | null = null;
  if ('generic_rules_file' in metadata) {
    const value: unknown = metadata.generic_rules_file;
    if (typeof value !== 'string') {
      failures.push({
        name: 'metadata',
        ok: false,
        detail: `metadata.generic_rules_file is malformed (${JSON.stringify(value)}) — re-run mai init to repair`,
      });
      return { expectation: undefined, failures };
    }
    genericRulesFile = value;
  }
  return { expectation: { harnesses, genericRulesFile }, failures };
}

/** Project-level, report-only Codex notify state (Plan 15 Task 3): global
 * notify targets operator-owned $CODEX_HOME, not a selected repo, so it can
 * never make verification fail — emitted exactly once per project. */
async function codexNotifyCheck(): Promise<CheckResult> {
  const { codexHome } = await import('../capture/codex.js');
  const home = codexHome();
  if (!(await exists(home))) {
    return {
      name: 'codex-notify',
      ok: true,
      detail: 'CODEX_HOME not found — create it and rerun mai init to add optional end-of-turn ingest',
    };
  }
  const raw = (await readTextOrNull(path.join(home, 'config.toml'))) ?? '';
  const setting = readCodexNotify(raw);
  if (setting.kind === 'managed') {
    return setting.legacy
      ? { name: 'codex-notify', ok: true, detail: 'legacy Codex notify — rerun mai init with --harness codex to migrate' }
      : { name: 'codex-notify', ok: true };
  }
  if (setting.kind === 'foreign') {
    return {
      name: 'codex-notify',
      ok: true,
      detail: 'foreign Codex notify preserved — chain hooks/codex-notify-chain.sh manually if end-of-turn ingest is desired',
    };
  }
  return {
    name: 'codex-notify',
    ok: true,
    detail: 'Codex notify not wired — rerun mai init to add optional end-of-turn ingest',
  };
}

/** Project-independent shipped skill/reviewer-agent state (Plan 15 Task 3,
 * Task 2 primitives). Drift and partial installs FAIL; stale passes with the
 * upgrade hint; an entirely missing group passes with the install hint. */
async function skillsSharedChecks(skillsIO?: SkillsIO): Promise<CheckResult[]> {
  const { runSkills } = await import('./skills.js');
  const status = skillsIO === undefined
    ? runSkills({ action: 'status', target: 'all' })
    : runSkills({ action: 'status', target: 'all' }, skillsIO);
  const out: CheckResult[] = [];
  for (const group of [...new Set(status.items.map((item) => item.group))]) {
    const items = status.items.filter((item) => item.group === group);
    const drifted = items.filter((item) => item.state === 'drifted');
    const missing = items.filter((item) => item.state === 'missing');
    const stale = items.filter((item) => item.state === 'stale');
    if (drifted.length > 0) {
      out.push({
        name: group,
        ok: false,
        detail: `${drifted.length} drifted — review local edits, then mai skills install --force`,
      });
    } else if (missing.length === items.length) {
      out.push({ name: group, ok: true, detail: 'not installed — mai skills install' });
    } else if (missing.length > 0) {
      out.push({
        name: group,
        ok: false,
        detail: `partially installed (${missing.length} missing) — mai skills install`,
      });
    } else if (stale.length > 0) {
      out.push({ name: group, ok: true, detail: `${stale.length} stale — mai skills upgrade` });
    } else {
      out.push({ name: group, ok: true });
    }
  }
  return out;
}

/** Build-identity shared check (Plan 15 Task 6). Never deferrable. Malformed
 * or missing build info FAILS; a known SHA behind HEAD is a PASS-WITH-HINT
 * (spec §6 report-only contract, authority 564f7a66 disposition) so a
 * docs-only commit cannot turn advanced `mai init` into an onboarding
 * failure; matching or release-'unknown' passes with its fingerprint. */
export function buildIdentityCheck(
  info: BuildInfo | null,
  status: { fingerprint: string; stale: boolean; detail?: string }
): CheckResult {
  if (info === null) {
    return { name: 'build', ok: false, detail: 'build identity missing or malformed — run npm run build' };
  }
  if (status.stale) {
    return { name: 'build', ok: true, detail: `build is behind source — run npm run build (${status.fingerprint})` };
  }
  return { name: 'build', ok: true, detail: status.fingerprint };
}

/** Full project verification: registered repos + persisted harness
 * expectations from the DB, shared hook scripts, shipped skills state
 * (deferrable ONLY by setup's internal pre-Skills call), and optional smoke. */
/** Plan 31: declared-link integrity — the DB-side parts of spec §5.1's link
 * report (the per-repo env comparison is FS-side in verifyRepo). Exported so
 * link-config.test.ts can exercise renamed/deleted declared slugs without
 * standing up a fully-wired repo fixture. */
export async function linkSharedChecks(
  slug: string,
  metadata: Record<string, unknown> | null
): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const linkedProjects = linkedProjectsFromMetadata(metadata);
  for (const linkedSlug of linkedProjects) {
    const src = await getPool().query(`SELECT 1 FROM projects WHERE slug = $1`, [linkedSlug]);
    out.push({
      name: `link:${linkedSlug}`,
      ok: src.rows.length > 0,
      detail: src.rows.length > 0 ? undefined : `declared link '${linkedSlug}' matches no project (renamed or deleted?) — references are dark until mai link is re-run`,
    });
  }
  if (linkedProjects.length > 0) {
    const me = await getPool().query<{ id: string }>(`SELECT id FROM projects WHERE slug = $1`, [slug]);
    const grants = await getPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM project_shares s JOIN projects p ON p.id = s.source_project_id
        WHERE s.target_project_id = $1 AND s.status = 'active' AND p.slug = ANY($2::text[])`,
      [me.rows[0].id, linkedProjects]
    );
    out.push({ name: 'shares', ok: true, detail: `${grants.rows[0].n} active incoming grant(s) under the declared links` });
  }
  return out;
}

export async function verifyProject(
  slug: string,
  opts: { smoke?: boolean; sharedSkills?: 'required' | 'deferred'; skillsIO?: SkillsIO } = {}
): Promise<ProjectVerification> {
  const row = await getPool().query<{ metadata: Record<string, unknown> | null; path: string | null }>(
    `SELECT metadata, path FROM projects WHERE slug = $1`,
    [slug]
  );
  if (row.rows.length === 0) throw new Error(`Project not found: ${slug}`);
  const metadata = row.rows[0].metadata;
  const linkedProjects = linkedProjectsFromMetadata(metadata);
  const storedRepos = isRecord(metadata) && Array.isArray(metadata.repos)
    ? metadata.repos.filter((r): r is string => typeof r === 'string')
    : [];
  const repos = storedRepos.length > 0 ? storedRepos : row.rows[0].path ? [row.rows[0].path] : [];
  if (repos.length === 0) {
    throw new Error(`Project '${slug}' has no registered repos (projects.metadata.repos) — re-run mai init.`);
  }
  const { expectation, failures } = readExpectation(metadata);

  const shared: CheckResult[] = [...failures];
  if (MAI_HOOK_DELEGATES.length !== 6 || new Set(MAI_HOOK_DELEGATES).size !== 6) {
    shared.push({ name: 'hook-inventory', ok: false, detail: 'expected six unique hook delegates' });
  }
  for (const script of MAI_HOOK_DELEGATES) {
    const p = path.join(MAI_ROOT, 'hooks', script);
    const ok = await exists(p);
    shared.push({ name: `hooks/${script}`, ok, detail: ok ? undefined : `missing: ${p}` });
  }
  if (expectation !== undefined && expectation.harnesses.includes('codex')) {
    shared.push(await codexNotifyCheck());
  }
  if (opts.sharedSkills !== 'deferred') {
    shared.push(...(await skillsSharedChecks(opts.skillsIO)));
  }
  // Build identity ALWAYS runs — deferral can never reach it.
  {
    const { readBuildInfo, sourceBuildStatus } = await import('../build-info.js');
    const info = await readBuildInfo();
    const status = info === null ? { fingerprint: 'unknown', stale: false } : await sourceBuildStatus(info);
    shared.push(buildIdentityCheck(info, status));
  }
  shared.push(...(await linkSharedChecks(slug, metadata)));

  const repoResults: RepoVerification[] = [];
  for (const repo of repos) {
    repoResults.push(await verifyRepo(repo, slug, expectation, repo, linkedProjects));
  }

  const smoke = opts.smoke ? await smokeTest(slug, row.rows[0].path ?? repos[0]) : undefined;
  const ok = shared.every((c) => c.ok) && repoResults.every((r) => r.ok) && (smoke?.ok ?? true);
  return { slug, ok, shared, repos: repoResults, smoke };
}

/** Human-readable report (CLI + init summary). */
export function formatVerification(v: ProjectVerification): string {
  const lines: string[] = [`# mai verify — '${v.slug}': ${v.ok ? 'PASS' : 'FAIL'}`, ''];
  for (const c of v.shared) {
    lines.push(`- ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  for (const r of v.repos) {
    lines.push(``, `${r.ok ? '✅' : '❌'} ${r.repo}`);
    for (const c of r.checks) {
      lines.push(`  - ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    }
  }
  if (v.smoke) {
    lines.push(``, `- ${v.smoke.ok ? '✅' : '❌'} smoke (stdio initialize)${v.smoke.detail ? ` — ${v.smoke.detail}` : ''}`);
  }
  return lines.join('\n');
}
