// Graduated-rules rendering (plan 27 §3.3, decision cd9e4009). THE FILE IS A
// PROJECTION: the promoted-rule set lives in curation_candidates (basis
// 'graduate', status 'applied') and nothing exists only in the file — so mai
// upgrade's wholesale block replacement can never destroy a rule (lesson
// 420dbda2 dissolved, not dodged). Every writer — the promote verdict,
// mai init, mai upgrade, the post-verdict re-render — emits THIS module's
// output; a second renderer is the drift this design exists to prevent.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getPool } from './db.js';
import { updateRepoManagedFile } from './repo-managed-write.js';
import {
  findManagedBlock, replaceManagedBlock, planRulesBlockUpgrade, GRADUATED_BLOCK,
} from './scripts/managed-block.js';
import type { PlannedChange } from './capture/adapter.js';
import type { SqlRunner } from './curation.js';

export const GRADUATED_RULES_VERSION = 1;
export const GRADUATED_HEADING = '## GRADUATED RULES (mai-mcp)';
export const GRADUATED_SENTINEL = `<!-- /mai-graduated-rules v${GRADUATED_RULES_VERSION} -->`;
/** Complete Plan 27 render target set. The generic adapter's standard default
 * is AGENTS.md and is therefore refreshable here; configured custom filenames
 * remain excluded because project metadata does not preserve them. */
const RULES_FILES = ['CLAUDE.md', 'AGENTS.md'];

export interface GraduatedRule {
  lessonId: string;
  rule: string;
  relearnedCount: number;
}

/** Applied graduate verdicts whose lesson is still live, project-local only
 * (globals are excluded from graduation end to end — spec §4). DISTINCT ON
 * guards the defense-in-depth case of duplicate applied rows; the outer ORDER
 * BY (earliest promotion first, verdict-id tiebreak) makes renders byte-stable. */
export async function graduatedRules(
  projectId: string,
  exec: SqlRunner = getPool()
): Promise<GraduatedRule[]> {
  const r = await exec.query<{ lesson_id: string; rule: string; relearned_count: number }>(
    `SELECT q.lesson_id, q.rule, q.relearned_count FROM (
       SELECT DISTINCT ON (l.id)
              l.id::text AS lesson_id, l.rule, l.relearned_count,
              cc.resolved_at, cc.id AS cc_id
         FROM curation_candidates cc
         JOIN lessons l ON l.id = cc.target_id
        WHERE cc.project_id = $1 AND cc.target_kind = 'lesson'
          AND cc.basis = 'graduate' AND cc.status = 'applied'
          AND l.project_id = cc.project_id
          AND l.superseded_by IS NULL AND l.retired_at IS NULL
        ORDER BY l.id, cc.resolved_at ASC, cc.id ASC
     ) q ORDER BY q.resolved_at ASC, q.cc_id ASC`,
    [projectId]
  );
  return r.rows.map((row) => ({
    lessonId: row.lesson_id,
    rule: row.rule,
    relearnedCount: Number(row.relearned_count),
  }));
}

/** Deterministic block body. Rule text is whitespace-flattened so a multi-line
 * rule cannot break the list rendering or byte-stability. */
export function renderGraduatedRulesBlock(rules: GraduatedRule[]): string {
  const lines: string[] = [
    GRADUATED_HEADING,
    '',
    '<!-- Machine-rendered from the mai brain (promote verdicts in the review',
    '     dashboard). NEVER hand-edit inside this block — the next render',
    '     overwrites it. Remove a rule with mai curation unpromote. -->',
  ];
  if (rules.length === 0) {
    lines.push('', '_No graduated rules yet — a lesson relearned enough times is proposed in the review queue._');
  } else {
    lines.push('');
    for (const r of rules) {
      const flat = r.rule.replace(/\s+/g, ' ').trim();
      lines.push(`- ${flat} _(lesson ${r.lessonId.slice(0, 8)}, relearned ×${r.relearnedCount})_`);
    }
  }
  lines.push('', GRADUATED_SENTINEL, '');
  return lines.join('\n');
}

/** Render into every registered repo's standard rules files. FILLS existing
 * markers only — creating them is init/upgrade's job (R7); a repo without
 * markers is skipped and heals at the next upgrade. The project advisory lock
 * serializes snapshots/writes across processes; same-directory rename prevents
 * torn readers. `afterSnapshot` is a deterministic concurrency-test seam only.
 * Returns human report lines; [] means nothing needed writing. */
export interface AtomicReplaceFileHandle {
  writeFile(content: string, options: { encoding: 'utf8' }): Promise<void>;
  chmod(mode: number): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface AtomicReplaceDirectoryHandle {
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface AtomicReplaceOps {
  realpath(file: string): Promise<string>;
  stat(file: string): Promise<{ mode: number }>;
  openTemp(file: string, mode: number): Promise<AtomicReplaceFileHandle>;
  openDirectory(dir: string): Promise<AtomicReplaceDirectoryHandle>;
  rename(from: string, to: string): Promise<void>;
  rm(file: string, options: { force: true }): Promise<void>;
}

const DEFAULT_ATOMIC_REPLACE_OPS: AtomicReplaceOps = {
  realpath: (file) => fs.realpath(file),
  stat: (file) => fs.stat(file),
  openTemp: (file, mode) => fs.open(file, 'wx', mode),
  openDirectory: (dir) => fs.open(dir, 'r'),
  rename: (from, to) => fs.rename(from, to),
  rm: (file, options) => fs.rm(file, options),
};

/** Replace one projection atomically and durably. The file is flushed before
 * rename and the containing directory is flushed afterwards, so a successful
 * return means the new name/content pair survives a power loss rather than
 * merely being invisible to concurrent readers. `ops` is a test seam. */
export async function atomicReplace(
  file: string,
  content: string,
  ops: AtomicReplaceOps = DEFAULT_ATOMIC_REPLACE_OPS
): Promise<void> {
  // AMENDMENT A5 (plan 27, finding 5aebbc83, 2026-08-15). Rename replaces the
  // NAME, so renaming over a symlink severs it and leaves the real target
  // stale. Resolve first and write the resolved path — the temp must live in
  // the real target's directory for the rename to stay same-filesystem/atomic.
  const target = await ops.realpath(file);
  const stat = await ops.stat(target);
  const mode = stat.mode & 0o777;
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.mai-${process.pid}-${randomUUID()}.tmp`
  );
  try {
    const handle = await ops.openTemp(temp, mode);
    try {
      await handle.writeFile(content, { encoding: 'utf8' });
      await handle.chmod(mode); // open mode is umask-masked
      await handle.sync();
    } finally {
      await handle.close();
    }
    await ops.rename(temp, target); // same-directory rename is atomic
    const directory = await ops.openDirectory(path.dirname(target));
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await ops.rm(temp, { force: true });
  }
}

function isMissingPathError(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err.code === 'ENOENT' || err.code === 'ENOTDIR')
  );
}

export async function writeGraduatedRulesBlocks(
  projectId: string,
  testHooks: {
    afterSnapshot?: () => Promise<void>;
    /** Plan 15 Task 3: init selects 'repo-contained' (05ec915d boundary);
     * background/healing projections keep today's 'projection' default with
     * atomicReplace's recorded follow-the-target behavior (plan 27). */
    writePolicy?: 'projection' | 'repo-contained';
  } = {}
): Promise<string[]> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // One protocol across processes and every writer. The rules query happens
    // only AFTER the lock, so a waiting writer always observes newer commits.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`mai:graduated-rules:${projectId}`]
    );
    const proj = await client.query<{ path: string | null; metadata: { repos?: string[] } | null }>(
      `SELECT path, metadata FROM projects WHERE id = $1`,
      [projectId]
    );
    if (proj.rows.length === 0) {
      await client.query('COMMIT');
      return [];
    }
    const meta = proj.rows[0].metadata ?? {};
    const repos =
      meta.repos && meta.repos.length > 0
        ? meta.repos
        : proj.rows[0].path
          ? [proj.rows[0].path]
          : [];
    const rendered = renderGraduatedRulesBlock(await graduatedRules(projectId, client));
    await testHooks.afterSnapshot?.();
    const report: string[] = [];
    for (const repo of repos) {
      for (const name of RULES_FILES) {
        const file = path.join(repo, name);
        if (testHooks.writePolicy === 'repo-contained') {
          const status = await updateRepoManagedFile(repo, name, (content) => {
            if (content === null) return null;
            const block = findManagedBlock(content, GRADUATED_BLOCK);
            if (!block || block.text === rendered) return null;
            return replaceManagedBlock(content, block, rendered);
          });
          if (status !== 'unchanged') report.push(`${path.basename(repo)}/${name} updated`);
          continue;
        }
        let content: string;
        try {
          content = await fs.readFile(file, 'utf8');
        } catch (err) {
          if (isMissingPathError(err)) continue;
          throw err;
        }
        const block = findManagedBlock(content, GRADUATED_BLOCK);
        if (!block || block.text === rendered) continue;
        await atomicReplace(file, replaceManagedBlock(content, block, rendered));
        report.push(`${path.basename(repo)}/${name} updated`);
      }
    }
    await client.query('COMMIT');
    return report;
  } catch (err) {
    // AMENDMENT A4 (finding ab5a9f0e): a throwing ROLLBACK must not replace the
    // real failure. Matches the house pattern used by the other verdict writers.
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Idempotent marker install for init (and adapter installs): append the
 * EMPTY render when the file exists and has no graduated block. The file's
 * creation belongs to the brain-block install that runs first. */
export async function installGraduatedRulesBlock(
  repoPath: string,
  fileName: string
): Promise<'installed' | 'unchanged' | 'absent'> {
  // AMENDMENT A3 (finding 4ec6f7a1): only ABSENCE means "nothing to install";
  // any other read failure surfaces (the contained writer throws it). Plan 15
  // Task 3 routes this repo-scoped onboarding write through 05ec915d.
  let absent = false;
  const status = await updateRepoManagedFile(repoPath, fileName, (content) => {
    if (content === null) {
      absent = true;
      return null;
    }
    if (findManagedBlock(content, GRADUATED_BLOCK)) return null;
    const sep = content.endsWith('\n') ? '\n' : '\n\n';
    return content + sep + renderGraduatedRulesBlock([]);
  });
  if (absent) return 'absent';
  return status === 'unchanged' ? 'unchanged' : 'installed';
}

/** Upgrade-side planner: install-or-refresh the graduated block in one file,
 * as a PlannedChange for the diff+confirm runner. Only files already carrying
 * a brain block qualify (the same installed-wiring rule planRulesBlockUpgrade
 * follows); `renderedBlock` comes from the runner, rendered once per slug. */
export async function planGraduatedRulesUpgrade(
  repoPath: string,
  fileName: string,
  renderedBlock: string,
  contentOverride?: string
): Promise<PlannedChange | null> {
  const file = path.join(repoPath, fileName);
  let content = contentOverride;
  if (content === undefined) {
    try { content = await fs.readFile(file, 'utf8'); }
    catch (err) { if (isMissingPathError(err)) return null; throw err; }
  }
  if (!findManagedBlock(content)) return null; // no brain block → not mai-wired
  const block = findManagedBlock(content, GRADUATED_BLOCK);
  if (block) {
    if (block.text === renderedBlock) return null;
    return {
      file,
      label: `${fileName} graduated-rules block refresh`,
      legacy: false,
      before: block.text,
      after: renderedBlock,
      newContent: replaceManagedBlock(content, block, renderedBlock),
      preimage: content,
    };
  }
  const sep = content.endsWith('\n') ? '\n' : '\n\n';
  return {
    file,
    label: `${fileName} graduated-rules block install`,
    legacy: false,
    before: '(no graduated-rules block)',
    after: renderedBlock,
    newContent: content + sep + renderedBlock,
    preimage: content,
  };
}

/** One confirmed write per instruction file. Both transforms are planned
 * sequentially against memory, so neither can overwrite the other. */
export async function planInstructionFileUpgrade(
  repoPath: string,
  fileName: 'CLAUDE.md' | 'AGENTS.md',
  templateName: string,
  renderedBlock: string
): Promise<PlannedChange[]> {
  const file = path.join(repoPath, fileName);
  let original: string;
  try { original = await fs.readFile(file, 'utf8'); }
  catch (err) { if (isMissingPathError(err)) return []; throw err; }
  const brain = await planRulesBlockUpgrade(repoPath, fileName, templateName, original);
  const grad = await planGraduatedRulesUpgrade(
    repoPath, fileName, renderedBlock, brain?.newContent ?? original
  );
  if (brain && grad) {
    return [{
      file,
      label: `${brain.label}; ${grad.label}`,
      legacy: brain.legacy,
      before: original,
      after: grad.newContent,
      newContent: grad.newContent,
      preimage: original,
    }];
  }
  return brain ? [brain] : grad ? [grad] : [];
}
