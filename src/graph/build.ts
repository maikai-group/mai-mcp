import { withGraphWriter } from './writer.js';
// mai graph build orchestrator (spec §4): full extraction across the project's
// repos (projects.metadata.repos) + optional dev-DB introspection, then the
// decisions→file linker. The dev-DB URL is never persisted (locked decision
// 2026-06-11) — it arrives via --postgres or MAI_GRAPH_DB_URL, per invocation.
import { getPool, loadProjectGraphRoots } from '../db.js';
import { runExtractors, sweepOrphanSharedNodes } from './engine.js';
import { behavioralExtractor } from './extractors/behavioral.js';
import { cppExtractor } from './extractors/cpp.js';
import { dbExtractor, dialectOf } from './extractors/db.js';
import { glueExtractor } from './extractors/glue.js';
import { kotlinExtractor } from './extractors/kotlin.js';
import { swiftExtractor } from './extractors/swift.js';
import { phpExtractor } from './extractors/php.js';
import { pythonExtractor } from './extractors/python.js';
import { shellExtractor } from './extractors/shell.js';
import { tier2CsharpExtractor, tier2GoExtractor, tier2JavaExtractor, tier2RustExtractor } from './extractors/tier2-languages.js';
import { tsExtractor } from './extractors/ts.js';
import { ueModuleExtractor } from './extractors/ue-module.js';
import { linkDecisionsToFiles, linkServiceContracts, linkWpTablesToSchema } from './linker.js';

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

export async function runGraphBuild(args: { projectId: string; slug: string; dbUrl?: string }): Promise<string> {
  return withGraphWriter(args.projectId, () => runGraphBuildUnlocked(args));
}

async function runGraphBuildUnlocked(args: { projectId: string; slug: string; dbUrl?: string }): Promise<string> {
  // Scheme validation at the choke point: every URL arrival path (CLI flags,
  // env, consumer .env resolver, SessionEnd script) converges here or on
  // runGraphUpdate. Validating any later would let update.ts's db try/catch
  // convert an unsupported-scheme throw into "- db: skipped" success.
  if (args.dbUrl) dialectOf(args.dbUrl);
  const roots = await loadProjectGraphRoots(args.projectId);
  const repoPaths = roots.repos;
  const excludes = roots.excludes;
  if (repoPaths.length === 0) {
    throw new Error(`project '${args.slug}' has no repos in metadata — onboard it with: mai init ${args.slug} --root <path>`);
  }

  // db first: ts's references_table edges resolve against the table nodes it
  // creates. glue last: it references files/scripts the others emit.
  const codeExtractors = [
    tsExtractor, pythonExtractor, cppExtractor, kotlinExtractor, swiftExtractor,
    phpExtractor, tier2GoExtractor, tier2RustExtractor, tier2JavaExtractor,
    tier2CsharpExtractor, ueModuleExtractor, shellExtractor, glueExtractor,
    behavioralExtractor,
  ];
  const extractors = args.dbUrl ? [dbExtractor, ...codeExtractors] : codeExtractors;
  const summaries = await runExtractors(extractors, {
    projectId: args.projectId,
    repoPaths,
    excludes,
    dbUrl: args.dbUrl,
  });
  const linked = await linkDecisionsToFiles(args.projectId);
  const wpLinked = await linkWpTablesToSchema(args.projectId);
  const swept = await sweepOrphanSharedNodes(args.projectId);
  const serviceLinks = await linkServiceContracts(args.projectId);

  const lines = [`# mai graph build — ${args.slug}`, '', `repos: ${repoPaths.join(', ')}`, ''];
  for (const s of summaries) {
    const hint =
      s.extractor === 'ts' && s.droppedEdges > 0 && !args.dbUrl
        ? ' — re-run with --db-url <dev-db-url> to resolve table references'
        : '';
    const dropped = s.droppedEdges > 0 ? ` (${s.droppedEdges} unresolved edges dropped${hint})` : '';
    lines.push(`- ${s.extractor}: ${s.nodes} nodes, ${s.edges} edges${dropped}${contractSkipSuffix(s)}`);
  }
  lines.push(`- linker: ${linked} new decision→file links`);
  lines.push(`- linker: ${wpLinked} new wp_table→table links`);
  lines.push(`- orphan sweep: ${swept} shared nodes removed`);
  lines.push(`- linker: ${serviceLinks.linked} HTTP calls linked (${serviceLinks.unresolved} unresolved, ${serviceLinks.ambiguous} ambiguous)`);

  // Schema freshness re-stamp (plan 46, R10) — the second of the two dbExtractor
  // producers. build.ts:56 runs db FIRST (its own comment at :48-49 explains why:
  // ts's references_table edges resolve against the table nodes db creates), so
  // all fourteen code extractors stamp extracted_at = NOW() after it and
  // classifyDbSchema reports a just-built schema `behind-code`. This is the
  // command REFRESH_INSTRUCTION (freshness.ts:305) tells operators to run to
  // repair a stale schema, so leaving it broken would break the documented cure.
  //
  // Keyed off the summary rather than off args.dbUrl: the summary is evidence the
  // extractor actually ran under the name 'db' (extractors/db.ts:252).
  if (summaries.some((s) => s.extractor === 'db')) {
    const stamped = await getPool().query(
      `UPDATE graph_nodes SET extracted_at = NOW()
        WHERE project_id = $1 AND extracted_by = 'db'`,
      [args.projectId]
    );
    if ((stamped.rowCount ?? 0) > 0) {
      lines.push(`- freshness: ${stamped.rowCount} schema nodes re-stamped to this pass`);
    }
  }
  return lines.join('\n');
}
