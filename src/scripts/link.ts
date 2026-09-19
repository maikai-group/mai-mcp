// mai link — the TARGET project's opt-in half of a cross-project share
// (plan 31). Updates the config authority (projects.metadata.linked_projects),
// then rewrites MAI_LINKED_PROJECTS in every registered repo's harness env by
// applying the capture adapters' own planned env changes. CLI-only surface:
// no agent-facing tool, no slug params anywhere near the MCP layer.
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { diffLines } from 'diff';
import { getPool } from '../db.js';
import { updateRepoManagedFile } from '../repo-managed-write.js';
import { planRepoUpgrade } from './upgrade.js';
import { linkedProjectsForSlug } from '../shares.js';
import { withProjectProjectionLock } from '../project-projection-lock.js';
import { readExpectation, verifyRepo, type RepoHarnessExpectation } from './verify.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
/** Planned-change labels the env refresh may apply. The label filter is a
 * NARROWING, not the safety mechanism: the codex-labelled change regenerates
 * the whole managed block (codex.ts planUpgrade), so applyEnvChanges below
 * adds the upgrade-grade guards — legacy refusal, rendered diff, confirmation. */
const ENV_LABELS = [
  (label: string): boolean => label === '.mcp.json mai-mcp entry refresh',
  (label: string): boolean => label.startsWith('.codex/config.toml mai block'),
];

export type PlannedEnvChange = import('../capture/adapter.js').PlannedChange & {
  /** Exact whole-file preimage reviewed by the operator. null = absent. */
  preimage: string | null;
};
export interface PlannedEnvGuard {
  /** Every required link-bearing harness file gets a reviewed preimage, even
   * when its adapter correctly plans no change. */
  file: string;
  preimage: string | null;
}
export interface PlannedEnvRepo {
  repo: string;
  changes: PlannedEnvChange[];
  guards: PlannedEnvGuard[];
  legacy: boolean;
}

async function readPreimage(file: string): Promise<string | null> {
  return fs.readFile(file, 'utf8').catch(() => null);
}

function stalePlan(file: string): Error {
  return new Error(`${file} changed after review — refusing the stale link plan; re-run mai link`);
}

function registeredRepos(metadata: Record<string, unknown> | null, legacyPath: string | null): string[] {
  const raw = metadata?.repos;
  if (raw !== undefined && (!Array.isArray(raw) || raw.some((repo) => typeof repo !== 'string'))) {
    throw new Error(`metadata.repos is malformed — re-run mai init to repair it`);
  }
  const stored = Array.isArray(raw) ? raw.filter((repo): repo is string => typeof repo === 'string') : [];
  return stored.length > 0 ? stored : legacyPath === null ? [] : [legacyPath];
}

/** SQL jsonb parameter preserving absent (SQL NULL) vs explicit JSON null. */
function jsonPreimage(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

/** Plan the env changes for one repo — NO writes, no prompts. Legacy-extent
 * blocks are flagged, never rewritten here: heuristic block boundaries need
 * `mai upgrade`'s reviewed migration path, never a side-door write. */
export async function planEnvChanges(
  repo: string,
  slug: string,
  linkedProjects: readonly string[],
  requiredFiles: readonly string[] = []
): Promise<PlannedEnvRepo> {
  // Read every required file before AND after adapter planning. This makes a
  // no-op file part of the reviewed snapshot and also rejects an edit racing
  // the planner itself.
  const before = new Map<string, string | null>();
  for (const file of requiredFiles) before.set(file, await readPreimage(file));
  const all = await planRepoUpgrade(repo, slug, { linkedProjects });
  for (const file of requiredFiles) {
    if (await readPreimage(file) !== before.get(file)) throw stalePlan(file);
  }
  const relevant = all.filter((c) => ENV_LABELS.some((match) => match(c.label)));
  const changes = relevant.map((c): PlannedEnvChange => {
    if (c.preimage === undefined) {
      throw new Error(`Planner omitted the full-file preimage for ${c.file} — refusing an unsafe link apply`);
    }
    return { ...c, preimage: c.preimage };
  });
  // Planned change files also join the fleet guard, even if a stale registry
  // failed to declare that harness. This prevents a late per-file rejection
  // after an earlier repo was already written.
  for (const change of changes) {
    if (await readPreimage(change.file) !== change.preimage) throw stalePlan(change.file);
  }
  const guards = requiredFiles.map((file): PlannedEnvGuard => ({
    file,
    preimage: before.get(file) ?? null,
  }));
  for (const change of changes) {
    const guard = guards.find((candidate) => candidate.file === change.file);
    if (guard !== undefined) {
      if (guard.preimage !== change.preimage) throw stalePlan(change.file);
    } else {
      guards.push({ file: change.file, preimage: change.preimage });
    }
  }
  return { repo, changes, guards, legacy: changes.some((c) => c.legacy) };
}

/** Reject any edit between planning/confirmation and apply before the first
 * mutation. writeEnvChanges repeats the comparison inside the managed-write
 * transform to close the remaining per-file race. */
export async function assertEnvPreimages(plannedRepos: readonly PlannedEnvRepo[]): Promise<void> {
  for (const planned of plannedRepos) {
    for (const guard of planned.guards) {
      if (await readPreimage(guard.file) !== guard.preimage) throw stalePlan(guard.file);
    }
  }
}

/** Validate the whole reviewed fleet after apply, including files for which
 * the adapter planned no change. */
export async function assertEnvEndState(plannedRepos: readonly PlannedEnvRepo[]): Promise<void> {
  for (const planned of plannedRepos) {
    for (const guard of planned.guards) {
      const change = planned.changes.find((candidate) => candidate.file === guard.file);
      const expected = change?.newContent ?? guard.preimage;
      if (await readPreimage(guard.file) !== expected) throw stalePlan(guard.file);
    }
  }
}

/** Write one repo's already-planned-and-confirmed env changes. */
export async function writeEnvChanges(planned: PlannedEnvRepo): Promise<string[]> {
  const lines: string[] = [];
  for (const c of planned.changes) {
    const rel = path.relative(planned.repo, c.file);
    const result = await updateRepoManagedFile(planned.repo, rel, (cur) => {
      if (cur !== c.preimage) throw stalePlan(c.file);
      return cur === c.newContent ? null : c.newContent;
    });
    lines.push(`${planned.repo}: ${rel} ${result}`);
  }
  return lines;
}

/** A registered repo is not enough: mutation requires every persisted
 * link-bearing harness expectation to be present and parseable. Generic-only
 * capture has no MCP server env, so it cannot satisfy the runtime key. */
async function assertLinkWiring(
  repo: string,
  slug: string,
  expectation: RepoHarnessExpectation | undefined,
  declaredLinks: readonly string[]
): Promise<string[]> {
  const required = expectation === undefined
    ? ['.mcp.json']
    : [
        ...(expectation.harnesses.includes('claude-code') ? ['.mcp.json'] : []),
        ...(expectation.harnesses.includes('codex') ? ['.codex/config.toml'] : []),
      ];
  if (required.length === 0) {
    throw new Error(`Repo '${repo}' has no expected link-bearing harness — re-run mai init with claude-code or codex`);
  }
  // Presence/parseability preflight deliberately ignores link parity: a prior
  // fail-closed partial removal is exactly the drift this command must repair.
  const verification = await verifyRepo(repo, slug, expectation, repo, declaredLinks, false);
  const failed = required.flatMap((name) => {
    const check = verification.checks.find((candidate) => candidate.name === name);
    return check?.ok ? [] : [`${name}: ${check?.detail ?? 'missing verification result'}`];
  });
  if (failed.length > 0) {
    throw new Error(`Repo '${repo}' is not ready for link env updates (${failed.join('; ')}) — re-run mai init to repair it`);
  }
  return required.map((name) => path.join(repo, name));
}

export interface EnvRefreshResult { lines: string[]; refusedLegacy: boolean }

/** Init-mode env refresh for one repo: plan + write silently (init just wrote
 * canonical current-version blocks and its post-verify gate validates the end
 * state), but legacy blocks are still refused loudly. */
export async function applyEnvChanges(
  repo: string, slug: string, linkedProjects: readonly string[]
): Promise<EnvRefreshResult> {
  const planned = await planEnvChanges(repo, slug, linkedProjects);
  if (planned.legacy) {
    return {
      lines: [`${repo}: REFUSED (legacy block, heuristic extent) — run: mai upgrade ${slug}`],
      refusedLegacy: true,
    };
  }
  if (planned.changes.length === 0) return { lines: [`${repo}: env already current`], refusedLegacy: false };
  return { lines: await writeEnvChanges(planned), refusedLegacy: false };
}

export interface LinkArgs {
  targetSlug: string;
  withSlug?: string;
  removeSlug?: string;
  yes?: boolean;
  /** Test seam (the init consentIO precedent): confirmation prompt override.
   * Production default is the readline prompt below. */
  confirm?: (question: string) => Promise<boolean>;
  /** Test-only interleaving seam after confirmation and before the preimage
   * guard. Production has no callback here. */
  beforeApply?: () => Promise<void>;
  /** Test-only seam after the metadata CAS while its project-row lock is still
   * held and before the first filesystem write. Production has no callback. */
  afterMetadataUpdate?: () => Promise<void>;
}

export async function runLink(args: LinkArgs): Promise<string> {
  if (!SLUG_RE.test(args.targetSlug)) throw new Error(`invalid slug '${args.targetSlug}'`);

  // Read-only status does its ordinary row read and takes no projection lock.
  if (args.withSlug === undefined && args.removeSlug === undefined) {
    const db = getPool();
    const row = await db.query<{ metadata: Record<string, unknown> | null; path: string | null }>(
      `SELECT metadata, path FROM projects WHERE slug = $1`, [args.targetSlug]
    );
    if (row.rows.length === 0) throw new Error(`Project not found: ${args.targetSlug}`);
    const repos = registeredRepos(row.rows[0].metadata, row.rows[0].path);
    const current = await linkedProjectsForSlug(args.targetSlug);
    return [
      `# mai link — '${args.targetSlug}'`,
      `declared links: ${current.length > 0 ? current.join(', ') : '(none)'}`,
      `repos: ${repos.join(', ') || '(none registered)'}`,
      `_Deep check (declared vs written env): mai verify ${args.targetSlug}_`,
    ].join('\n');
  }

  // Every mutating path enters the cross-process, slug-keyed projection lock
  // BEFORE its first project/metadata read, so the authority it freezes cannot
  // be overtaken by a concurrent init/upgrade/link projection.
  return withProjectProjectionLock(args.targetSlug, async () => runLinkMutation(args));
}

async function runLinkMutation(args: LinkArgs): Promise<string> {
  const db = getPool();
  const row = await db.query<{ id: string; metadata: Record<string, unknown> | null; path: string | null }>(
    `SELECT id, metadata, path FROM projects WHERE slug = $1`, [args.targetSlug]
  );
  if (row.rows.length === 0) throw new Error(`Project not found: ${args.targetSlug}`);
  // Freeze the complete repo/harness registry from ONE project-row read. The
  // apply CAS below compares every field that determines the planned fleet.
  const repos = registeredRepos(row.rows[0].metadata, row.rows[0].path);
  const current = await linkedProjectsForSlug(args.targetSlug);

  if (repos.length === 0) {
    throw new Error(`Project '${args.targetSlug}' has no registered repos — run mai init before changing links`);
  }
  if (args.withSlug !== undefined && args.removeSlug !== undefined) {
    throw new Error('pass --with OR --remove, not both');
  }

  let next: string[];
  const isRemoval = args.removeSlug !== undefined;
  if (args.withSlug !== undefined) {
    if (!SLUG_RE.test(args.withSlug)) throw new Error(`invalid slug '${args.withSlug}'`);
    if (args.withSlug === args.targetSlug) throw new Error('a project cannot link itself');
    const src = await db.query(`SELECT 1 FROM projects WHERE slug = $1`, [args.withSlug]);
    if (src.rows.length === 0) throw new Error(`Project not found: ${args.withSlug}`);
    next = [...new Set([...current, args.withSlug])].sort();
  } else {
    next = current.filter((s) => s !== args.removeSlug);
    if (next.length === current.length) {
      return `'${args.targetSlug}' has no link to '${args.removeSlug}' — nothing to remove.`;
    }
  }

  const { expectation, failures: expectationFailures } = readExpectation(row.rows[0].metadata);
  if (expectationFailures.length > 0) {
    throw new Error(`Project '${args.targetSlug}' has malformed harness metadata — re-run mai init to repair it`);
  }
  const requiredFiles = new Map<string, string[]>();
  for (const repo of repos) {
    requiredFiles.set(repo, await assertLinkWiring(repo, args.targetSlug, expectation, current));
  }

  // ---- PLAN EVERYTHING FIRST — no mutation of any kind until the whole
  // operation is planned, legacy-clean, and confirmed (pass-2 B3). ----
  const plannedRepos: PlannedEnvRepo[] = [];
  for (const repo of repos) {
    plannedRepos.push(await planEnvChanges(
      repo, args.targetSlug, next, requiredFiles.get(repo) ?? []
    ));
  }
  const legacyRepos = plannedRepos.filter((p) => p.legacy).map((p) => p.repo);
  if (legacyRepos.length > 0) {
    // Abort BEFORE any write — a legacy block anywhere means the operation
    // cannot complete coherently, and a half-linked fleet is the failure mode.
    // Throw so cmdLink/runCli exits nonzero; an ABORTED mutation is never green.
    throw new Error([
      `ABORTED — legacy managed block(s) in: ${legacyRepos.join(', ')}`,
      `run: mai upgrade ${args.targetSlug}  (reviewed legacy migration), then re-run mai link. Nothing was changed.`,
    ].join('\n'));
  }
  const withChanges = plannedRepos.filter((p) => p.changes.length > 0);
  if (!args.yes && withChanges.length > 0) {
    for (const p of withChanges) {
      for (const c of p.changes) {
        process.stdout.write(`\n--- ${c.label} (${c.file}) ---\n`);
        for (const part of diffLines(c.before, c.after)) {
          const prefix = part.added ? '+ ' : part.removed ? '- ' : '  ';
          for (const line of part.value.replace(/\n$/, '').split('\n')) process.stdout.write(prefix + line + '\n');
        }
      }
    }
    const question = `Apply ${withChanges.reduce((n, p) => n + p.changes.length, 0)} env change(s) across ${withChanges.length} repo(s) AND update declared links? [y/N] `;
    const confirm = args.confirm ?? (async (q: string): Promise<boolean> => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question(q)).trim().toLowerCase();
      rl.close();
      return answer === 'y' || answer === 'yes';
    });
    if (!(await confirm(question))) return 'cancelled — nothing was changed.';
  }
  if (args.beforeApply !== undefined) await args.beforeApply();
  await assertEnvPreimages(plannedRepos);

  // Serialize the complete metadata + filesystem apply on the project row.
  // A concurrent link or repo/harness registry mutation waits until this
  // operation has either committed a revalidated end state or rolled back.
  const client = await db.connect();
  let transactionSettled = false;
  const updateMetadata = async (): Promise<void> => {
    const updated = await client.query<{ id: string }>(
      `UPDATE projects SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{linked_projects}', $2::jsonb)
        WHERE id = $1
          AND COALESCE(metadata->'linked_projects', '[]'::jsonb) = $3::jsonb
          AND metadata->'repos' IS NOT DISTINCT FROM $4::jsonb
          AND metadata->'capture_harnesses' IS NOT DISTINCT FROM $5::jsonb
          AND metadata->'generic_rules_file' IS NOT DISTINCT FROM $6::jsonb
          AND path IS NOT DISTINCT FROM $7::text
        RETURNING id`,
      [
        row.rows[0].id, JSON.stringify(next), JSON.stringify(current),
        jsonPreimage(row.rows[0].metadata?.repos),
        jsonPreimage(row.rows[0].metadata?.capture_harnesses),
        jsonPreimage(row.rows[0].metadata?.generic_rules_file),
        row.rows[0].path,
      ]
    );
    if (updated.rows.length === 0) {
      throw new Error(`Declared links or repo/harness registry changed after review — refusing the stale metadata update; re-run mai link`);
    }
  };
  const lines: string[] = [];
  try {
    await client.query('BEGIN');
    const locked = await client.query<{ id: string }>(
      `SELECT id FROM projects
        WHERE id = $1
          AND COALESCE(metadata->'linked_projects', '[]'::jsonb) = $2::jsonb
          AND metadata->'repos' IS NOT DISTINCT FROM $3::jsonb
          AND metadata->'capture_harnesses' IS NOT DISTINCT FROM $4::jsonb
          AND metadata->'generic_rules_file' IS NOT DISTINCT FROM $5::jsonb
          AND path IS NOT DISTINCT FROM $6::text
        FOR UPDATE`,
      [
        row.rows[0].id, JSON.stringify(current),
        jsonPreimage(row.rows[0].metadata?.repos),
        jsonPreimage(row.rows[0].metadata?.capture_harnesses),
        jsonPreimage(row.rows[0].metadata?.generic_rules_file),
        row.rows[0].path,
      ]
    );
    if (locked.rows.length === 0) {
      throw new Error(`Declared links or repo/harness registry changed after review — refusing the stale metadata update; re-run mai link`);
    }
    // The lock may have waited. Recheck every reviewed file, including no-op
    // harnesses, before entering the filesystem mutation window.
    await assertEnvPreimages(plannedRepos);

    // ---- DIRECTION-SPECIFIC ORDERING (pass-2 B3). Addition: metadata first,
    // then env — an env-write failure commits declared-without-written, which
    // is FAIL-CLOSED (no access) and verify-visible. Removal: env first in EVERY
    // repo, metadata only after all succeed — the reverse order could declare
    // the link gone while a stale env still grants the old runtime permission. ----
    if (!isRemoval) {
      await updateMetadata();
      if (args.afterMetadataUpdate !== undefined) await args.afterMetadataUpdate();
      lines.push(`declared links for '${args.targetSlug}': ${next.join(', ')}`);
      try {
        for (const p of plannedRepos) {
          lines.push(...(p.changes.length > 0 ? await writeEnvChanges(p) : [`${p.repo}: env already current`]));
        }
        await assertEnvEndState(plannedRepos);
      } catch (err) {
        // Preserve the declared source-of-truth on addition failure. This is
        // intentionally fail-closed and gives verify a durable drift signal.
        await client.query('COMMIT');
        transactionSettled = true;
        throw new Error([
          ...lines,
          `⚠ env addition FAILED: ${err instanceof Error ? err.message : String(err)}`,
          `declared links UPDATED but env is incomplete — access stays fail-closed. Fix the repo and re-run.`
        ].join('\n'));
      }
    } else {
      const written: string[] = [];
      try {
        for (const p of plannedRepos) {
          written.push(...(p.changes.length > 0 ? await writeEnvChanges(p) : [`${p.repo}: env already current`]));
        }
        await assertEnvEndState(plannedRepos);
      } catch (err) {
        await client.query('ROLLBACK');
        transactionSettled = true;
        throw new Error([
          ...written,
          `⚠ env removal FAILED mid-fleet: ${err instanceof Error ? err.message : String(err)}`,
          `declared links UNCHANGED (still include '${args.removeSlug}') — the declaration stays accurate while any repo still grants it. Fix the repo and re-run.`,
        ].join('\n'));
      }
      await updateMetadata();
      lines.push(...written, `declared links for '${args.targetSlug}': ${next.length > 0 ? next.join(', ') : '(none)'}`);
    }
    await client.query('COMMIT');
    transactionSettled = true;
  } catch (err) {
    if (!transactionSettled) await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  lines.push(`_Restart MCP servers in the repos so the new env loads. Verify: mai verify ${args.targetSlug}_`);
  return lines.join('\n');
}
