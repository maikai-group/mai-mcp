#!/usr/bin/env node
// Docs sweep for the PINNED project (env-only, iron rule 2): hash tracked
// plan/spec markdown, re-chunk exactly the changed set, sweep chunks of
// deleted docs. Rides the SAME dual-harness ingest chain as transcripts
// (Claude Code SessionEnd hook / Codex notify) — no watcher, no daemon, no
// new hook (spec §3; watcher rejected per decision 1a4765b0: its only edge is
// edits with no session running, which the next session's sweep catches
// anyway). Covers hand edits and plans never registered via mai_plan.
// Direct-invocation entry mirrors ingest-codex.ts: hook-safe, always exits 0.
import '../env.js';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Dirent } from 'node:fs';
import { getPool, getProjectId, getProjectRepos } from '../db.js';
import { requirePinnedSlug } from '../env.js';
import { finishAndExit } from '../exit.js';
import { rechunkDoc, deleteDocChunks, type DocKind } from '../doc-chunks.js';
import { projectRootReal, resolveUnderRoot } from '../plans.js';

/** Conventional doc dirs (spec §2) — checked under EVERY registered root where
 * they exist; deliberately NO per-project configuration knob in v1. */
export const CONVENTIONAL_DOC_DIRS: ReadonlyArray<{ dir: string; kind: DocKind }> = [
  { dir: 'docs/superpowers/plans', kind: 'plan' },
  { dir: 'docs/superpowers/specs', kind: 'spec' },
  { dir: 'docs/plans', kind: 'plan' },
  { dir: 'docs/specs', kind: 'spec' },
];

/** Filename families that are NEVER auto-ingested (spec §2: reviews and
 * findings are first-class tracker records — plan 16 — not doc chunks).
 * Tokens are delimited by `-`/`_`/`.`/start/end on the lowercased stem:
 *   • a `review` token anywhere  → `-review`, `-review-pass-3`
 *   • a TRAILING `finding(s)` token → `capture-spike-findings`
 * Deliberately does NOT match `plan-16-findings-tracker` or
 * `plan-findings-tracker-design` — mid-stem "findings" names the subject, not
 * the genre, and both are real implementation docs in this repo. */
export const EXCLUDED_DOC_STEM = /(?:^|[-_.])review(?:[-_.]|$)|(?:^|[-_.])findings?$/;

/** The sweep's inclusion contract, ordered (plan 20 ambiguity 7):
 * (1) registered tracker identity wins — a file in the plans table always
 *     ingests, because mai_plan registration chunks it anyway (Task 3) and the
 *     sweep must not fight the register path;
 * (2) otherwise the filename contract decides. */
export function isIngestableDoc(fileName: string, registered: boolean): boolean {
  if (!fileName.endsWith('.md')) return false;
  if (registered) return true;
  return !EXCLUDED_DOC_STEM.test(fileName.slice(0, -3).toLowerCase());
}

interface DocId {
  repoRoot: string;
  path: string;
}
// NUL separator: a path may legally contain any byte except NUL, so this is
// the one delimiter that cannot forge a collision between two identities.
const idKey = (d: DocId): string => `${d.repoRoot}\u0000${d.path}`;
// Directory identity is compared with path.dirname(storedFilePath). At the
// project root, docIdentity(root) yields '' while path.dirname('PLAN.md')
// yields '.', so normalize that one representation here (finding eeadd2bf).
const directoryKey = (d: DocId): string =>
  idKey({ repoRoot: d.repoRoot, path: d.path === '' ? '.' : d.path });

/** Stored identity for one physical doc (finding 2481fa65). A pure function of
 * the ABSOLUTE realpath — never of which root discovered it — so a file
 * reachable from two registered roots yields exactly ONE row set. Inside the
 * project root: project-root-relative path, repo_root = the project root
 * (byte-identical to single-root behaviour, and joins plans.path). Outside it:
 * relative to its own registered root, with that root recorded. */
function docIdentity(abs: string, projectRoot: string | null, discoveredUnder: string): DocId {
  if (projectRoot) {
    const rel = path.relative(projectRoot, abs);
    if (rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)) {
      return { repoRoot: projectRoot, path: rel };
    }
  }
  return { repoRoot: discoveredUnder, path: path.relative(discoveredUnder, abs) };
}

async function realRoot(p: string): Promise<string> {
  return await fsp.realpath(path.resolve(p)).catch(() => path.resolve(p));
}

export async function runDocsSweep(): Promise<string> {
  requirePinnedSlug();
  const pool = getPool();
  const projectId = await getProjectId();

  // Roots = the umbrella product root UNION every registered repo (spec §2,
  // "in every registered repo"). The union is load-bearing in BOTH directions
  // and is the same reconciliation decision 1a4765b0 just made for Codex
  // rollout scanning: getProjectRepos returns metadata.repos when populated —
  // which on multi-repo umbrella-class projects EXCLUDES projects.path —
  // and falls back to [projects.path] only when repos is empty. Roots are
  // realpath'd and deduped, so a repo that IS the project root collapses.
  const projectRoot = await projectRootReal(projectId);
  const roots: string[] = [];
  for (const r of [...(projectRoot ? [projectRoot] : []), ...(await getProjectRepos(projectId))]) {
    const real = await realRoot(r);
    if (!roots.includes(real)) roots.push(real);
  }
  if (roots.length === 0) return 'docs sweep: project has no registered root — nothing to scan.';

  const plans = await pool.query<{ id: string; path: string }>(
    `SELECT id, path FROM plans WHERE project_id = $1`, [projectId]);
  // Canonicalize EVERY stored tracker path before tracker precedence OR scan
  // shape. This heals sweep behavior even before an old alias row is next
  // touched by mai_plan (finding 09f1f43f).
  const canonicalPlans: Array<{ id: string; path: string }> = [];
  for (const p of plans.rows) {
    let canonicalPath = p.path;
    if (projectRoot) {
      const abs = await resolveUnderRoot(projectRoot, p.path);
      if (abs !== null) canonicalPath = docIdentity(abs, projectRoot, projectRoot).path;
    }
    canonicalPlans.push({ id: p.id, path: canonicalPath });
  }
  canonicalPlans.sort((a, b) => a.id.localeCompare(b.id));
  const planIdByPath = new Map<string, string>();
  for (const p of canonicalPlans) {
    if (!planIdByPath.has(p.path)) planIdByPath.set(p.path, p.id);
  }
  /** Tracker paths are PROJECT-root-relative. Root qualification is
   * load-bearing (finding ec3abe2d): an outside repo can carry the same
   * relative path without being the tracked plan. One helper owns discovery
   * AND deletion semantics so classifier precedence cannot drift. */
  const planIdFor = (d: DocId): string | null =>
    projectRoot !== null && d.repoRoot === projectRoot
      ? planIdByPath.get(d.path) ?? null
      : null;

  // Scan set (spec §2): (a) the conventional defaults under EVERY root where
  // they exist; (b) every directory that contains a registered plan's path,
  // resolved against the PROJECT root — that is what plans.path is relative to,
  // and it is how consumer variants with a custom docs/plans layout arrive.
  // Duplicate (root, dir) pairs are harmless: identity dedup collapses them.
  type ScanEntry = { root: string; dir: string; kind: DocKind; onlyName?: string };
  const scan: ScanEntry[] = [];
  for (const root of roots) {
    for (const { dir, kind } of CONVENTIONAL_DOC_DIRS) scan.push({ root, dir, kind });
  }
  if (projectRoot) {
    for (const p of canonicalPlans) {
      const d = path.dirname(p.path);
      // `.` is a real scan identity, but NOT a broad plan corpus: spec §2
      // excludes arbitrary root Markdown. Target only the registered basename
      // while preserving its lifecycle (findings eeadd2bf/ed9b7c52).
      if (d === '') continue;
      scan.push({
        root: projectRoot,
        dir: d,
        kind: path.basename(d) === 'specs' ? 'spec' : 'plan',
        onlyName: d === '.' ? path.basename(p.path) : undefined,
      });
    }
  }

  let seen = 0; // docs that PASSED the classifier (excluded files are not "seen")
  let chunked = 0;
  let unchanged = 0;
  let failed = 0;
  let sweptDocs = 0;
  const seenIds = new Set<string>();
  // Identity of every broad directory / targeted file eligible under the
  // CURRENT roots + scan set (findings b1e0bf97/ed9b7c52). Add before readdir
  // so a transient read failure does not purge otherwise-valid rows.
  // docIdentity deliberately collapses a nested registered root into the
  // project-root identity, so these sets also cover nested deregistration.
  const eligibleDirIds = new Set<string>();
  const eligibleFileIds = new Set<string>(); // targeted root-level registered plans
  const unreadableDirIds = new Set<string>(); // transient errors preserve prior rows
  for (const { root, dir, kind: dirKind, onlyName } of scan) {
    // Same containment + symlink check mai_plan applies, per root.
    const absDir = await resolveUnderRoot(root, dir);
    if (absDir === null) continue; // escapes this root — never scanned
    const dirKey = directoryKey(docIdentity(absDir, projectRoot, root));
    if (onlyName === undefined) {
      eligibleDirIds.add(dirKey); // every ingestable file in a broad directory
    } else {
      const target = await resolveUnderRoot(root, path.join(dir, onlyName));
      if (target !== null) eligibleFileIds.add(idKey(docIdentity(target, projectRoot, root)));
    }
    let entries: Dirent[] | null = null;
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      // Missing dir = genuinely empty. Any other read failure may be transient
      // (permissions/I/O): preserve its prior rows instead of interpreting
      // "could not list" as "all docs deleted".
      const missing = err instanceof Error && 'code' in err && err.code === 'ENOENT';
      if (!missing) unreadableDirIds.add(dirKey);
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      if (onlyName !== undefined && e.name !== onlyName) continue;
      const abs = await resolveUnderRoot(root, path.join(dir, e.name)); // per-file (symlinks)
      if (abs === null) continue;
      const id = docIdentity(abs, projectRoot, root);
      const planId = planIdFor(id);
      if (!isIngestableDoc(e.name, planId !== null)) continue; // spec §2 exclusions
      const key = idKey(id);
      if (seenIds.has(key)) continue;
      seenIds.add(key);
      seen++;
      // Kind per FILE with tracker identity winning over the directory's kind
      // (finding abdf0cd3): a registered plan filed under a specs dir stays a
      // plan on the changed AND the unchanged path.
      const fileKind: DocKind = planId ? 'plan' : dirKind;
      try {
        const r = await rechunkDoc({
          projectId, repoRoot: id.repoRoot, path: id.path, absPath: abs, kind: fileKind, planId,
        });
        if (r.status === 'chunked') chunked++;
        else unchanged++;
      } catch (err) {
        failed++;
        console.error(
          `mai-docs-sweep: FAILED ${id.repoRoot}/${id.path}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  // Deleted / no-longer-eligible docs (spec §4): tracked chunks whose file no
  // longer exists, no longer resolves inside its recorded root, or no longer
  // passes the classifier (a doc renamed into the review family) are swept.
  // Derived data, safe to drop; an unresolvable path can never be re-verified,
  // so it counts as gone.
  const tracked = await pool.query<{ repo_root: string; path: string }>(
    `SELECT DISTINCT repo_root, path FROM doc_chunks WHERE project_id = $1`, [projectId]);
  for (const t of tracked.rows) {
    const id = { repoRoot: t.repo_root, path: t.path };
    if (seenIds.has(idKey(id))) continue;
    const parentKey = directoryKey({ repoRoot: t.repo_root, path: path.dirname(t.path) });
    if (unreadableDirIds.has(parentKey)) continue; // explicit transient-error policy
    // No longer under any CURRENT broad directory OR targeted-file entry:
    // remove even when the old on-disk file still exists (repo deregistration
    // and fix-merge-3's accidental root README chunks). Parent-dir identity,
    // not roots.includes(repo_root), is required for nested repos, whose
    // stored identity intentionally collapses to the project root.
    let drop = !eligibleFileIds.has(idKey(id)) && !eligibleDirIds.has(parentKey);
    const abs = await resolveUnderRoot(t.repo_root, t.path);
    if (!drop && abs === null) {
      drop = true;
    } else if (!drop && abs !== null) {
      try {
        await fsp.access(abs);
      } catch {
        drop = true;
      }
      if (!drop && !isIngestableDoc(path.basename(t.path), planIdFor(id) !== null)) drop = true;
    }
    if (drop) {
      await deleteDocChunks(projectId, t.repo_root, t.path);
      sweptDocs++;
    }
  }
  return (
    `docs sweep: ${seen} doc(s) seen, ${chunked} re-chunked, ${unchanged} unchanged, ` +
    `${failed} failed, ${sweptDocs} deleted doc(s) swept`
  );
}

// Direct-invocation entry (the hooks run `node build/scripts/docs-sweep.js`).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    console.error(await runDocsSweep());
  } catch (err) {
    console.error(
      `mai-docs-sweep: FAILED (session continues unaffected): ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    await finishAndExit(0); // hook-safe: always zero (the ingest-codex.ts contract)
  }
}
