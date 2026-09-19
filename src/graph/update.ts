import { withGraphWriter } from './writer.js';
// Incremental tracked working-tree source comparison; commits record provenance only.
import path from 'node:path';
import { execBounded } from '../git/repo.js';
import { getPool, loadProjectGraphRoots } from '../db.js';
import { owningRegisteredRepo, readEndpointMetadata, serviceIdentity, SERVICE_IDENTITY_BASENAMES } from './contracts.js';
import { SourceEvidence, validSourceHash } from './source-evidence.js';
import { assessNodeStaleness, type NodeStalenessInput } from './staleness.js';
import { headSha, runExtractor, spliceExtractor, sweepOrphanSharedNodes } from './engine.js';
import { behavioralExtractor } from './extractors/behavioral.js';
import { CPP_EXT, cppExtractor } from './extractors/cpp.js';
import { dbExtractor, dialectOf } from './extractors/db.js';
import { glueExtractor } from './extractors/glue.js';
import { phpExtractor } from './extractors/php.js';
import { PY_EXT, pythonExtractor } from './extractors/python.js';
import { shellExtractor } from './extractors/shell.js';
import { tier2CsharpExtractor, tier2GoExtractor, tier2JavaExtractor, tier2RustExtractor } from './extractors/tier2-languages.js';
import { SOURCE_EXT, tsExtractor } from './extractors/ts.js';
import { ueModuleExtractor } from './extractors/ue-module.js';
import { SPLICE_WALK_EXTENSIONS } from './extension-registry.js';
import { linkDecisionsToFiles, linkServiceContracts, linkWpTablesToSchema } from './linker.js';
import { isExcluded } from './walk.js';
import { KT_EXT } from './extractors/kotlin.js';
import { SWIFT_EXT } from './extractors/swift.js';
import type { GraphExtractor } from './types.js';

function contractSkipSuffix(summary: {
  extractor: string;
  contractSkips: {
    dynamic_http_url: number;
    dynamic_http_method: number;
    dynamic_http_route: number;
    dynamic_event_channel: number;
  };
}): string {
  if (!['ts', 'php', 'python'].includes(summary.extractor)) return '';
  const skips = summary.contractSkips;
  return `; dynamic contracts skipped url=${skips.dynamic_http_url} method=${skips.dynamic_http_method} route=${skips.dynamic_http_route} channel=${skips.dynamic_event_channel}`;
}

/** Registered repos nested under `repo` (an umbrella root registering its
 * sub-repos). Their subtrees belong to THEM — every prefix-scoped query for
 * `repo` must exclude them or a root full-walk deletes the sub-repos' nodes. */
function nestedRepos(repo: string, allRepos: readonly string[]): string[] {
  return allRepos.filter((o) => o !== repo && o.startsWith(repo + path.sep));
}

/** ` AND NOT starts_with(file_path, $N || '/')` per nested repo, params from startIndex. */
function notNestedSql(startIndex: number, nested: readonly string[]): string {
  return nested.map((_, i) => ` AND NOT starts_with(file_path, $${startIndex + i} || '/')`).join('');
}

interface RepoDelta {
  repo: string;
  changed: string[];
  deleted: string[];
  glueTouched: boolean;
  contractIdentityTouched: boolean;
  fullBuildNeeded: boolean;
  mode: 'diff' | 'full-walk' | 'up-to-date' | 'no-git';
  head?: string;
}

interface StoredSource extends NodeStalenessInput {
  file_path: string;
  commit_sha: string | null;
  kind: string;
  metadata: unknown;
}

async function repoDelta(
  projectId: string,
  repo: string,
  excludes: string[],
  nested: string[],
  allRepos: readonly string[],
  source: SourceEvidence,
): Promise<RepoDelta> {
  const tracked = await source.census(repo);
  if (tracked.state !== 'ready') {
    if (tracked.reason === 'non-git') return {
      repo, changed: [], deleted: [], glueTouched: true, contractIdentityTouched: true,
      fullBuildNeeded: false, mode: 'no-git',
    };
    throw new Error(`Graph update source census failed (${tracked.reason ?? 'git'}); graph rows retained. Retry when registered sources are available.`);
  }
  if (tracked.conflicts.size > 0) {
    throw new Error('Graph update has unresolved Git index entries; resolve conflicts before retrying. Graph rows retained.');
  }
  const head = await headSha(repo);
  const stored = await getPool().query<StoredSource>(
    `SELECT file_path, content_hash, extracted_by, commit_sha, kind, metadata
       FROM graph_nodes
      WHERE project_id = $1 AND starts_with(file_path, $2 || '/')${notNestedSql(3, nested)}
      ORDER BY file_path, extracted_by`,
    [projectId, repo, ...nested],
  );
  const byFile = new Map<string, StoredSource[]>();
  for (const row of stored.rows) {
    const rows = byFile.get(row.file_path) ?? [];
    rows.push(row);
    byFile.set(row.file_path, rows);
  }
  const changed = new Set<string>();
  const deleted = new Set<string>();
  for (const file of new Set([...tracked.files, ...byFile.keys()])) {
    if (!SPLICE_WALK_EXTENSIONS.has(path.extname(file))) continue;
    // Match the TS and C++ producers' deliberate non-source exclusions.
    if (file.endsWith('.d.ts') || file.endsWith('.generated.h')) continue;
    if (owningRegisteredRepo(file, allRepos) !== repo) continue;
    if (!tracked.files.has(file) || isExcluded(file, excludes)) {
      if (byFile.has(file)) deleted.add(file);
      continue;
    }
    const mode = SOURCE_EXT.has(path.extname(file)) ? 'typescript' : 'utf8';
    const read = await source.read(file, mode);
    if (read.state === 'removed') {
      if (byFile.has(file)) deleted.add(file);
      continue;
    }
    const previous = byFile.get(file) ?? [];
    if (read.state !== 'verified' || previous.length === 0
      || previous.some((node) => !validSourceHash(node.content_hash) || node.content_hash !== read.hash)) {
      changed.add(file);
    }
  }

  const identity = serviceIdentity(repo);
  // Endpoints are shared, fileless nodes. Their defining serves_route sources
  // establish project/root ownership independently of the stored source rows.
  const endpoints = await getPool().query<{ metadata: unknown }>(
    `SELECT DISTINCT endpoint.metadata
       FROM graph_nodes endpoint
       JOIN graph_edges route ON route.to_node = endpoint.id
         AND route.project_id = endpoint.project_id AND route.relation = 'serves_route'
       JOIN graph_nodes defining ON defining.id = route.from_node
         AND defining.project_id = route.project_id
      WHERE endpoint.project_id = $1 AND endpoint.kind = 'endpoint'
        AND endpoint.extracted_by IN ('ts', 'python')
        AND starts_with(defining.file_path, $2 || '/')
        AND NOT EXISTS (
          SELECT 1 FROM unnest($3::text[]) AS child(root)
          WHERE starts_with(defining.file_path, child.root || '/')
        )`,
    [projectId, repo, nested],
  );
  const aliasesDiffer = endpoints.rows.some((row) => {
    const metadata = readEndpointMetadata(row.metadata);
    return metadata === null || metadata.service_id !== identity.id
      || JSON.stringify(metadata.service_aliases) !== JSON.stringify(identity.aliases);
  });
  // Commit evidence is used only to detect identity-manifest inputs, never to skip source.
  const stamp = stored.rows.find((row) => row.commit_sha !== null)?.commit_sha;
  let manifestTouched = false;
  const manifestChanges = async (base: string | null): Promise<boolean> => {
    const diff = await execBounded('git', ['-C', repo, 'diff', '--name-only', '--no-renames', '-z',
      ...(base === null ? [] : [base]), '--', ...SERVICE_IDENTITY_BASENAMES], { maxBuffer: 64 * 1024 * 1024 });
    return diff.stdout.split('\0').filter(Boolean).some((file) =>
      SERVICE_IDENTITY_BASENAMES.has(path.basename(file)));
  };
  if (stamp !== undefined && stamp !== null) {
    try { manifestTouched = await manifestChanges(stamp); }
    catch { manifestTouched = await manifestChanges(head); }
  } else {
    // Missing provenance is not itself a changed input. HEAD (or the index in
    // an unborn repo) still detects actual current manifest edits; aliases
    // independently detect an edit/update/revert after the diff becomes empty.
    manifestTouched = await manifestChanges(head);
  }
  const fullBuildRows = stored.rows.filter((row) => row.extracted_by === 'kotlin' || row.extracted_by === 'swift');
  const newFullBuildSource = [...tracked.files].some((file) =>
    (KT_EXT.has(path.extname(file)) || SWIFT_EXT.has(path.extname(file)))
    && !isExcluded(file, excludes) && owningRegisteredRepo(file, allRepos) === repo
    && !(byFile.get(file) ?? []).some((row) => row.extracted_by === 'kotlin' || row.extracted_by === 'swift'));
  const fullBuildNeeded = newFullBuildSource
    || (await assessNodeStaleness(fullBuildRows, allRepos, source)).some((v) => v !== 'fresh');
  return {
    repo, changed: [...changed].sort(), deleted: [...deleted].sort(), glueTouched: true,
    contractIdentityTouched: manifestTouched || aliasesDiffer, fullBuildNeeded,
    mode: changed.size + deleted.size > 0 ? 'diff' : 'up-to-date',
    ...(head === null ? {} : { head }),
  };
}

export async function runGraphUpdate(args: { projectId: string; slug: string; dbUrl?: string }): Promise<string> {
  return withGraphWriter(args.projectId, () => runGraphUpdateUnlocked(args));
}

async function runGraphUpdateUnlocked(args: { projectId: string; slug: string; dbUrl?: string }): Promise<string> {
  // Scheme validation at the choke point: every URL arrival path converges here or on runGraphBuild.
  if (args.dbUrl) dialectOf(args.dbUrl);
  const pool = getPool();
  const roots = await loadProjectGraphRoots(args.projectId);
  const repoPaths = roots.repos;
  const excludes = roots.excludes;
  if (repoPaths.length === 0) throw new Error(`project '${args.slug}' has no repos — run mai init first.`);

  const count = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM graph_nodes WHERE project_id = $1`,
    [args.projectId]
  );
  if (Number(count.rows[0].c) === 0) {
    return `No graph yet for '${args.slug}' — run: mai graph build --project ${args.slug}`;
  }

  const source = new SourceEvidence(repoPaths, excludes);
  const deltas: RepoDelta[] = [];
  for (const repo of repoPaths) {
    deltas.push(await repoDelta(
      args.projectId, repo, excludes, nestedRepos(repo, repoPaths), repoPaths, source,
    ));
  }

  const changed = deltas.flatMap((d) => d.changed);
  const deleted = deltas.flatMap((d) => d.deleted);

  const lines = [`# mai graph update — ${args.slug}`, '', 'Source comparison includes tracked working-tree edits.'];
  if (deltas.some((delta) => delta.fullBuildNeeded)) {
    lines.push('- kotlin/swift: stale or unverified source — run mai graph build; incremental update does not refresh these languages.');
  }
  for (const d of deltas) {
    lines.push(`- ${path.basename(d.repo)}: ${d.mode}${d.mode === 'diff' || d.mode === 'full-walk' ? ` (${d.changed.length} changed, ${d.deleted.length} deleted)` : ''}`);
  }

  const partition = (exts: ReadonlySet<string>): { changedFiles: string[]; deletedFiles: string[] } => ({
    changedFiles: changed.filter((f) => exts.has(path.extname(f))),
    deletedFiles: deleted.filter((f) => exts.has(path.extname(f))),
  });

  const contractIdentityTouched = deltas.some((delta) => delta.contractIdentityTouched);
  if (contractIdentityTouched) {
    for (const extractor of [tsExtractor, pythonExtractor]) {
      const summary = await runExtractor(extractor, {
        projectId: args.projectId, repoPaths, excludes,
      });
      lines.push(`- ${summary.extractor}: ${summary.nodes} nodes, ${summary.edges} edges (full re-run — service identity manifest changed)${contractSkipSuffix(summary)}`);
    }
  }

  const splices: Array<[GraphExtractor, ReadonlySet<string>]> = [];
  if (!contractIdentityTouched) {
    splices.push([tsExtractor, SOURCE_EXT], [pythonExtractor, PY_EXT]);
  }
  splices.push([cppExtractor, CPP_EXT]);
  for (const [extractor, exts] of splices) {
    const part = partition(exts);
    if (part.changedFiles.length === 0 && part.deletedFiles.length === 0) continue;
    const s = await spliceExtractor(extractor, {
      projectId: args.projectId,
      repoPaths,
      excludes,
      ...part,
    });
    lines.push(`- ${s.extractor}: ${s.nodes} nodes upserted, ${s.edges} edges, ${s.removedNodes} removed${s.droppedEdges > 0 ? ` (${s.droppedEdges} unresolved dropped)` : ''}${contractSkipSuffix(s)}`);
  }

  // PHP always re-runs fully because cross-file hook edges are not spliceable.
  const php = await runExtractor(phpExtractor, { projectId: args.projectId, repoPaths, excludes });
  lines.push(`- php: ${php.nodes} nodes, ${php.edges} edges (full re-run — cross-file hook edges are not spliceable)${contractSkipSuffix(php)}`);

  // Tier-2 ALWAYS re-runs fully (spec A3): fileless import-module rendezvous
  // nodes are splice-invisible, and at tier-2 cost a full pass is ~free.
  for (const t2 of [tier2GoExtractor, tier2RustExtractor, tier2JavaExtractor, tier2CsharpExtractor]) {
    const r = await runExtractor(t2, { projectId: args.projectId, repoPaths, excludes });
    lines.push(`- ${t2.name}: ${r.nodes} nodes, ${r.edges} edges (full re-run — module labels are not spliceable)`);
  }

  // UE modules are cheap and stay ahead of the late shell/glue/behavioral consumers.
  const um = await runExtractor(ueModuleExtractor, { projectId: args.projectId, repoPaths, excludes });
  lines.push(`- ue-module: ${um.nodes} nodes, ${um.edges} edges (full re-run — module files are few)`);

  // Schema refresh (decision 8c86dbbe): when a per-project dev-DB URL is present
  // (consumer's gitignored .env, sourced by the SessionEnd hook), re-introspect
  // the schema — migrations live outside git so the splice path never sees them.
  // Non-fatal + leak-proof: a bad/expired URL must not break SessionEnd, and we
  // never echo the URL (or pg's URL-bearing error) into the summary or anywhere.
  let schemaRefreshed = false;
  if (args.dbUrl) {
    try {
      const d = await runExtractor(dbExtractor, { projectId: args.projectId, repoPaths, excludes, dbUrl: args.dbUrl });
      schemaRefreshed = true;
      lines.push(`- db: ${d.nodes} nodes, ${d.edges} edges (full re-introspection — schema lives outside git)`);
    } catch {
      lines.push(`- db: skipped (introspection failed — check MAI_GRAPH_DB_URL)`);
    }
  } else {
    lines.push(`- db: skipped (no MAI_GRAPH_DB_URL in this env — schema layer not refreshed)`);
  }

  // Shell must observe the finalized producer graph on EVERY update. A target-
  // only change or identity-manifest refresh can cascade the old incoming edge
  // while leaving the shell source unchanged, so an early splice is incorrect.
  const shell = await runExtractor(shellExtractor, { projectId: args.projectId, repoPaths, excludes });
  lines.push(`- shell: ${shell.nodes} nodes, ${shell.edges} edges (full re-run — target graph finalized)`);

  // Glue and behavioral are unconditional late consumers.
  const g = await runExtractor(glueExtractor, { projectId: args.projectId, repoPaths, excludes });
  lines.push(`- glue: ${g.nodes} nodes, ${g.edges} edges (full re-run — launchd/cron live outside git)`);
  const b = await runExtractor(behavioralExtractor, { projectId: args.projectId, repoPaths, excludes });
  lines.push(`- behavioral: ${b.edges} co-change edges${b.droppedEdges > 0 ? ` (${b.droppedEdges} to vanished files dropped)` : ''}`);

  // Observed Git provenance only. Never change content_hash or extracted_at here.
  let reStamped = 0;
  for (const d of deltas) {
    if (!d.head) continue;
    const nested = nestedRepos(d.repo, repoPaths);
    const r = await pool.query(
      `UPDATE graph_nodes SET commit_sha = $2
       WHERE project_id = $1 AND starts_with(file_path, $3 || '/') AND commit_sha IS DISTINCT FROM $2${notNestedSql(4, nested)}`,
      [args.projectId, d.head, d.repo, ...nested]
    );
    reStamped += r.rowCount ?? 0;
  }
  if (reStamped > 0) lines.push(`- provenance: ${reStamped} nodes recorded at observed HEAD`);

  // Schema freshness re-stamp (plan 46, R10). The db extractor runs at line 229,
  // but shell/glue/behavioral run after it and every runExtractor stamps
  // extracted_at = NOW(). So the moment a schema refresh SUCCEEDS, three code
  // extractors push the code axis past it and classifyDbSchema's `behind-code`
  // rule (freshness.ts:83-88) fires on a schema that was just refreshed —
  // observed on a consumer project with the two timestamps one second apart.
  //
  // Re-stamping here makes the timestamp mean "as of this update's schema pass",
  // which is the question the banner actually answers, and makes the result
  // independent of extractor ordering — the thing that broke it. Mirrors the
  // commit_sha re-stamp directly above. An update that did NOT refresh the
  // schema changes nothing here, so a genuinely stale schema still reports stale.
  if (schemaRefreshed) {
    const s = await pool.query(
      `UPDATE graph_nodes SET extracted_at = NOW()
        WHERE project_id = $1 AND extracted_by = 'db'`,
      [args.projectId]
    );
    if ((s.rowCount ?? 0) > 0) {
      lines.push(`- freshness: ${s.rowCount} schema nodes re-stamped to this pass`);
    }
  }

  const linked = await linkDecisionsToFiles(args.projectId);
  const wpLinked = await linkWpTablesToSchema(args.projectId);
  const swept = await sweepOrphanSharedNodes(args.projectId);
  const serviceLinks = await linkServiceContracts(args.projectId);
  lines.push(
    `- linker: ${linked} new decision→file links`,
    `- linker: ${wpLinked} new wp_table→table links`,
    `- orphan sweep: ${swept} shared nodes removed`,
    `- linker: ${serviceLinks.linked} HTTP calls linked (${serviceLinks.unresolved} unresolved, ${serviceLinks.ambiguous} ambiguous)`,
  );
  return lines.join('\n');
}
