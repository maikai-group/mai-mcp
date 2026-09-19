// mai upgrade — refresh mai-owned config in a project's registered repos to
// the current templates (the frozen-install fix). Detection-driven: each
// capture adapter reports whether its wiring is installed and plans its own
// changes; this runner only renders diffs, confirms, and writes. Legacy blocks
// (no version sentinel) have heuristic extents — their diffs are labelled
// LEGACY MIGRATION and applying is always diff+confirm (decision b0fc1969);
// --yes exists for fleet runs AFTER a --dry-run review. CLI-only surface:
// no agent-facing tool, no slug params anywhere near the MCP layer.
//
// AMENDMENT A9 (plan 27, finding 7df2eebf): diff+confirm governs CONFIG. It
// does NOT govern the graduated-rules block, which is machine-owned and whose
// only source of truth is the DB. Every non-dry-run invocation refreshes that
// projection — with or without --yes, and even when nothing was pending —
// because a stale machine block is a bug, not a user edit worth confirming
// (spec §3.3's self-healing boundary). --dry-run remains strictly read-only.
// So `mai upgrade --all` is never a guaranteed no-write command; only
// `--dry-run` is.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { diffLines } from 'diff';
import { withProjectProjectionLocks } from '../project-projection-lock.js';
import { updateRepoManagedFile } from '../repo-managed-write.js';
import { getPool } from '../db.js';
import { getCaptureAdapter, listCaptureAdapters, type PlannedChange } from '../capture/adapter.js';
import {
  readExpectation,
  verifyRepo,
  type CheckResult,
} from './verify.js';

export interface UpgradeArgs {
  slugs: string[];
  dryRun: boolean;
  yes: boolean;
  agentId?: string;
  llm?: 'claude-code' | 'codex-cli' | 'none';
  embeddings?: 'local' | 'none';
  /** Test seam: override the .env the consent flow reads/appends (pass-4 W4). */
  consentEnvFile?: string;
  /** Test seam: runs after confirmation/planning, immediately before writes. */
  beforeApply?: () => Promise<void>;
  /** Test-only seam (plan 31): runs after each locked project's authoritative
   * metadata read, while the projection locks are still held. */
  afterProjectionRead?: (slug: string) => Promise<void>;
}

function diffValueLines(value: string): string[] {
  const lines = value.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Compact multi-hunk line diff. Unchanged regions are summarized so user
 * content between separated managed edits is never mislabeled as -/+ text. */
export function renderDiff(before: string, after: string): string {
  if (before === after) return '(no textual change)';
  const lines: string[] = [];
  for (const change of diffLines(before, after)) {
    const changedLines = diffValueLines(change.value);
    if (!change.added && !change.removed) {
      const count = change.count ?? changedLines.length;
      if (count > 0) lines.push(`… ${count} unchanged line(s)`);
      continue;
    }
    const prefix = change.removed ? '- ' : '+ ';
    for (const line of changedLines) lines.push(`${prefix}${line}`);
  }
  return lines.length > 0 ? lines.join('\n') : '(no textual change)';
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** Plan all changes for one repo across every installed adapter. Exported for
 * tests. Dedupes by target file (codex + generic can both own AGENTS.md). */
export async function planRepoUpgrade(
  repo: string,
  slug: string,
  opts: { agentId?: string; graduatedRulesBlock?: string; linkedProjects?: readonly string[] } = {}
): Promise<PlannedChange[]> {
  const seen = new Set<string>();
  const changes: PlannedChange[] = [];
  for (const harness of listCaptureAdapters()) {
    const adapter = getCaptureAdapter(harness);
    const status = await adapter.detect(repo);
    if (!status.installed) continue;
    for (const c of await adapter.planUpgrade(repo, slug, {
      agentId: opts.agentId,
      graduatedRulesBlock: opts.graduatedRulesBlock,
      linkedProjects: opts.linkedProjects,
    })) {
      if (seen.has(c.file)) continue;
      seen.add(c.file);
      changes.push(c);
    }
  }
  return changes;
}

async function hasInstalledCaptureAdapter(repo: string): Promise<boolean> {
  for (const harness of listCaptureAdapters()) {
    if ((await getCaptureAdapter(harness).detect(repo)).installed) return true;
  }
  return false;
}

/** Verify the complete proposed repo state without touching the repo. A change
 * targeting the same file as a failed check is not evidence that it repairs
 * that check (for example, a graduated-rules edit can leave duplicate brain
 * blocks intact). */
async function verifyPlannedRepo(
  repo: string,
  slug: string,
  expectation: import('./verify.js').RepoHarnessExpectation | undefined,
  changes: PlannedChange[],
  linkedProjects: readonly string[] = []
): Promise<CheckResult[]> {
  const overlay = await fs.mkdtemp(path.join(os.tmpdir(), 'mai-upgrade-preflight-'));
  const relativeFiles = new Set([
    '.mcp.json',
    path.join('.claude', 'settings.json'),
    'CLAUDE.md',
    path.join('.codex', 'config.toml'),
    'AGENTS.md',
  ]);
  if (expectation?.genericRulesFile) relativeFiles.add(expectation.genericRulesFile);
  const byFile = new Map(changes.map((change) => [path.resolve(change.file), change.newContent]));
  try {
    for (const relative of relativeFiles) {
      const source = path.join(repo, relative);
      const projected = byFile.get(path.resolve(source));
      let content = projected;
      if (content === undefined) {
        try {
          content = await fs.readFile(source, 'utf8');
        } catch (err) {
          if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') continue;
          throw err;
        }
      }
      const destination = path.join(overlay, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, content, 'utf8');
    }
    const projected = await verifyRepo(overlay, slug, expectation, repo, linkedProjects);
    return projected.checks.filter((check) => !check.ok);
  } finally {
    await fs.rm(overlay, { recursive: true, force: true });
  }
}

function incompleteRepoMessage(
  repo: string,
  failures: CheckResult[]
): string {
  const failed = failures
    .map((failure) => `${failure.name}${failure.detail ? ` (${failure.detail})` : ''}`)
    .join('; ');
  return `  ❌ ${repo} — incomplete wiring: ${failed}`;
}

export async function runUpgrade(args: UpgradeArgs): Promise<string> {
  // Plan 31: one cross-process, slug-keyed projection lock per target slug,
  // acquired in the helper's sorted order (the only allowed multi-project
  // order) and held across authority-read → plan → confirm → write → final
  // verify. It deliberately spans confirmation: releasing after rendering
  // would make the confirmed projection stale again.
  return withProjectProjectionLocks(args.slugs, async (): Promise<string> => {
  const pool = getPool();
  const report: string[] = [];
  const pending: Array<{ repo: string; change: PlannedChange }> = [];
  const verifyTargets: Array<{
    repo: string; slug: string;
    expectation: import('./verify.js').RepoHarnessExpectation | undefined;
    linkedProjects: readonly string[];
    installedAdapter: boolean;
  }> = [];
  const refreshProjectIds = new Set<string>();

  for (const slug of args.slugs) {
    const row = await pool.query<{ id: string; metadata: Record<string, unknown> | null; path: string | null }>(
      `SELECT id, metadata, path FROM projects WHERE slug = $1`,
      [slug]
    );
    if (row.rows.length === 0) throw new Error(`Project not found: ${slug}`);
    refreshProjectIds.add(row.rows[0].id);
    const metadata = row.rows[0].metadata;
    const repos = Array.isArray(metadata?.repos)
      ? metadata.repos.filter((repo): repo is string => typeof repo === 'string')
      : row.rows[0].path ? [row.rows[0].path] : [];
    if (args.afterProjectionRead !== undefined) await args.afterProjectionRead(slug);
    const linkedProjects = Array.isArray(metadata?.linked_projects)
      ? metadata.linked_projects.filter((v): v is string => typeof v === 'string')
      : [];
    const { expectation, failures: metadataFailures } = readExpectation(metadata);
    // Plan 27: ONE render per slug — every repo's planned graduated block is
    // byte-identical by construction (decision cd9e4009's single-renderer rule).
    const { graduatedRules, renderGraduatedRulesBlock } = await import('../rules-render.js');
    const graduatedRulesBlock = renderGraduatedRulesBlock(await graduatedRules(row.rows[0].id));
    report.push(`# ${slug} (${repos.length} repo(s))`);
    const incomplete: string[] = [];
    if (metadataFailures.length > 0) {
      incomplete.push(incompleteRepoMessage('(project metadata)', metadataFailures));
    }
    for (const repo of repos) {
      const installedAdapter = await hasInstalledCaptureAdapter(repo);
      verifyTargets.push({ repo, slug, expectation, linkedProjects, installedAdapter });
      const changes = await planRepoUpgrade(repo, slug, { agentId: args.agentId, graduatedRulesBlock, linkedProjects });
      const verification = installedAdapter ? await verifyRepo(repo, slug, expectation, repo, linkedProjects) : null;
      const uncovered = verification === null || verification.ok
        ? []
        : await verifyPlannedRepo(repo, slug, expectation, changes, linkedProjects);
      if (uncovered.length > 0) {
        incomplete.push(incompleteRepoMessage(repo, uncovered));
        if (changes.length === 0) continue;
      }
      if (changes.length === 0) {
        // AMENDMENT A8 (finding 3428b7eb): "current" once implied "untouched",
        // which the graduated-rules projection below made false — it writes any
        // registered marker regardless of adapter detection. Say what is
        // actually current: the config. The refresh reports itself separately.
        report.push(
          installedAdapter
            ? `  ✅ ${repo} — config current`
            : `  ℹ️ ${repo} — no capture-adapter config detected`
        );
        continue;
      }
      report.push(`  📝 ${repo}`);
      for (const c of changes) {
        const flag = c.legacy ? '  ⚠ LEGACY MIGRATION (heuristic block extent — review this diff)' : '';
        report.push('', `    ${path.relative(repo, c.file)} — ${c.label}${flag}`);
        report.push(
          renderDiff(c.before, c.after)
            .split('\n')
            .map((l) => `      ${l}`)
            .join('\n')
        );
        pending.push({ repo, change: c });
      }
    }
    if (incomplete.length > 0) {
      const root = row.rows[0].path ?? repos[0];
      const repoFlags = repos.map((repo) => `--repo ${repo}`).join(' ');
      const harnessFlags = expectation?.harnesses.map((harness) => `--harness ${harness}`).join(' ') ?? '--harness claude-code';
      report.push(
        ...incomplete,
        `     Repair with mai init ${slug} --root ${root} ${repoFlags} ${harnessFlags}`,
        ''
      );
    }
    report.push('');
  }

  const incompleteCount = report.filter((line) => line.includes(' — incomplete wiring:')).length;
  if (incompleteCount > 0) {
    throw new Error([
      ...report,
      `Upgrade stopped before writing: ${incompleteCount} repo/project contract(s) are incomplete.`,
      'mai upgrade refreshes existing wiring; mai init installs or repairs missing wiring.',
    ].join('\n'));
  }

  // The pre-confirmation render exists to show a meaningful diff, but it is
  // never the final projection authority — the current-DB writer below is.
  if (args.dryRun) {
    if (pending.length === 0) {
      return [...report, 'Everything is current — nothing to upgrade.'].join('\n');
    }
    return [
      ...report,
      `${pending.length} pending change(s). Re-run without --dry-run to apply (add --yes to skip the prompt).`,
    ].join('\n');
  }

  // Consent can write the checkout .env and local embeddings can download a
  // model. Both belong after the complete side-effect-free wiring preflight;
  // --dry-run returns above and therefore remains strictly read-only.
  try {
    const { maybeOfferSubscriptionProvider, stdConsentIO } = await import('./llm-consent.js');
    const io = stdConsentIO();
    const consent = await maybeOfferSubscriptionProvider(
      args.yes ? { ...io, isTTY: false } : io,
      args.llm,
      args.consentEnvFile
    );
    if (consent) console.log(consent);
  } catch (err) {
    console.log(`llm: consent SKIPPED (${(err as Error).message.split('\n')[0]})`);
  }

  try {
    const { maybeOfferLocalEmbeddings, stdConsentIO } = await import('./llm-consent.js');
    const io = stdConsentIO();
    const emb = await maybeOfferLocalEmbeddings(
      args.yes ? { ...io, isTTY: false } : io,
      args.embeddings,
      args.consentEnvFile
    );
    if (emb) console.log(emb);
  } catch (err) {
    console.log(`embeddings: consent SKIPPED (${(err as Error).message.split('\n')[0]})`);
  }

  if (pending.length > 0 && !args.yes) {
    console.log(report.join('\n'));
    const ok = await confirm(`Apply ${pending.length} change(s)?`);
    if (!ok) {
      return 'Aborted — no files written. (Non-interactive shell? Review with --dry-run, then re-run with --yes.)';
    }
    report.length = 0; // diffs already on screen; return only the outcome
  }

  await args.beforeApply?.();
  // Exact managed writes, not raw fs.writeFile: each change re-compares the
  // whole-file preimage it was planned against, so an edit that landed after
  // planning/confirmation is refused instead of silently overwritten.
  for (const { repo, change } of pending) {
    await fs.mkdir(path.dirname(change.file), { recursive: true });
    await updateRepoManagedFile(repo, path.relative(repo, change.file), (cur) => {
      if (cur !== change.preimage) {
        throw new Error(`${change.file} changed after review — refusing the stale upgrade plan; re-run mai upgrade`);
      }
      return cur === change.newContent ? null : change.newContent;
    });
  }
  // Validate every locked repo's real end state before the projection locks are
  // released. A mismatch throws and can never print success.
  for (const target of verifyTargets) {
    // Same predicate as the pre-check above: a repo with no installed capture
    // adapter receives no adapter changes, so there is no write to validate.
    if (!target.installedAdapter) continue;
    const verification = await verifyRepo(
      target.repo, target.slug, target.expectation, target.repo, target.linkedProjects
    );
    if (!verification.ok) {
      throw new Error(incompleteRepoMessage(target.repo, verification.checks.filter((c) => !c.ok)));
    }
  }
  // Fail-closed: if this cannot lock/query/write, runUpgrade throws and must
  // not print success. Every projection writer shares this one protocol.
  //
  // AMENDMENT A12 (finding b9386a9c): the failure stays fatal, but the fleet
  // finishes first. `--all` puts every registered slug in refreshProjectIds, so
  // a bare loop let one unreadable CLAUDE.md in project 3 of 16 strand projects
  // 4..16 — after their config writes had already landed. Collect per-project
  // failures, refresh everyone who can be refreshed, then throw once naming the
  // count. Nothing is lost either way (the projection is DB-derived), but the
  // operator now learns the whole state from one run.
  const { writeGraduatedRulesBlocks } = await import('../rules-render.js');
  const refreshed: string[] = [];
  const failures: unknown[] = [];
  for (const projectId of refreshProjectIds) {
    try {
      refreshed.push(...await writeGraduatedRulesBlocks(projectId));
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `graduated-rules refresh failed for ${failures.length} of ${refreshProjectIds.size} project(s)`
    );
  }
  if (pending.length === 0) {
    return [
      ...report,
      `Everything is current — graduated rules refreshed in ${refreshed.length} file(s).`,
    ].join('\n');
  }
  // AMENDMENT A8 (finding 3428b7eb): the count was computed and discarded here,
  // so a run that wrote N config changes plus M instruction files reported only
  // N. The writer's return values are already human report lines; surface them.
  report.push(
    refreshed.length > 0
      ? `Applied ${pending.length} change(s); graduated rules refreshed in ${refreshed.length} file(s): ${refreshed.join(', ')}.`
      : `Applied ${pending.length} change(s).`
  );
  report.push(
    `Next: ${[...new Set(args.slugs)].map((s) => `mai verify ${s}`).join(' && ')}`
  );
  return report.join('\n');
  });
}
