// DB-schema freshness (plan 28; design 2026-08-12-graph-polish-design.md §6).
//
// The graph has TWO independent freshness axes and used to report one number for
// both. Code nodes count stale when their defining source differs from extraction
// or cannot be verified. Schema nodes have no file_path at all (every `db` row:
// file_path IS NULL), so they fall outside every starts_with(file_path, repo || '/')
// staleness query — see the note at src/graph/update.ts:196-197. Net effect:
// mai_prime could print "source verified" while the schema layer had not been
// introspected for months. This module reports the second axis, honestly, from
// columns that already exist (graph_nodes.extracted_by / extracted_at). No
// migration.
//
// URL RULE (decision 8c86dbbe; the standing rule at the top of db-url.ts): the
// dev-DB URL is consumed as a BOOLEAN ONLY. Nothing in this file returns,
// renders, logs or stores it — the resolver's result is compared inline and
// discarded. src/__tests__/graph-freshness.test.ts asserts that structurally.
import { getPool, getProjectId, loadProjectGraphRoots } from '../db.js';
import { resolveConsumerGraphDbUrl } from './db-url.js';
import { projectStaleness, type StalenessMethod } from './staleness.js';
import { SourceEvidence } from './source-evidence.js';

/**
 * `fresh` means "introspected during the most recent extraction pass", NOT
 * "matches the live database right now" — proving the latter would need a
 * connection on every status call (deliberately out of scope). Every render
 * therefore carries the `as of` timestamp.
 *
 * `stale.lastExtracted` is nullable because graph_nodes.extracted_at is
 * nullable (db/schema.sql:442). `fresh` is not: a freshness claim without a
 * timestamp is the dishonesty this module exists to remove.
 */
export type DbSchemaState =
  | { state: 'not-configured' }
  | { state: 'never-extracted' }
  | {
      state: 'stale';
      reason: 'no-url' | 'behind-code';
      tables: number;
      nodes: number;
      lastExtracted: Date | null;
    }
  | { state: 'fresh'; tables: number; nodes: number; lastExtracted: Date };

/** Code-axis counts: stale or unverified defining source under registered roots. */
export interface GraphStaleCounts {
  total: number;
  stale: number;
  /** How the count was produced — a whole-graph fallback may never be
   * presented with the authority of a per-file count (plan 46, decision 2). */
  method: StalenessMethod;
}

/** Both axes in one value. Consumed by prime today; by the plan-29 banner next. */
export interface GraphFreshness {
  code: GraphStaleCounts;
  db: DbSchemaState;
}

/** Plain inputs — no DB, no env. Exported so the classifier is table-testable. */
export interface DbSchemaInputs {
  dbNodes: number;
  dbTables: number;
  dbLastExtracted: Date | null;
  codeLastExtracted: Date | null;
  urlConfigured: boolean;
}

/**
 * Pure and total. `behind-code` is EVIDENCE, not a clock heuristic: a code
 * extraction newer than the last introspection proves an update ran that
 * skipped the schema layer. There is deliberately no "N days old" rule.
 */
export function classifyDbSchema(i: DbSchemaInputs): DbSchemaState {
  if (i.dbNodes <= 0) {
    return i.urlConfigured ? { state: 'never-extracted' } : { state: 'not-configured' };
  }
  const counts = { tables: i.dbTables, nodes: i.dbNodes };
  if (!i.urlConfigured) {
    // Schema nodes exist but no URL resolves now: every `mai graph update` is
    // skipping the schema layer, whatever the timestamps say.
    return { state: 'stale', reason: 'no-url', ...counts, lastExtracted: i.dbLastExtracted };
  }
  if (i.dbLastExtracted === null) {
    // Rows with no recorded extraction time: no evidence the last pass touched
    // them. Report conservatively rather than claim freshness. Unreachable
    // while both writers stamp NOW() (engine.ts:152-160, :336-344).
    return { state: 'stale', reason: 'behind-code', ...counts, lastExtracted: null };
  }
  if (
    i.codeLastExtracted !== null &&
    i.codeLastExtracted.getTime() > i.dbLastExtracted.getTime()
  ) {
    return { state: 'stale', reason: 'behind-code', ...counts, lastExtracted: i.dbLastExtracted };
  }
  return { state: 'fresh', ...counts, lastExtracted: i.dbLastExtracted };
}

interface FreshnessRow {
  db_nodes: string;
  db_tables: string;
  db_last: Date | null;
  code_last: Date | null;
}

/** Both axes' timestamps and the schema counts in ONE query on graph_nodes. */
export async function readDbSchemaState(projectId: string): Promise<DbSchemaState> {
  const r = await getPool().query<FreshnessRow>(
    `SELECT COUNT(*) FILTER (WHERE extracted_by = 'db')::text AS db_nodes,
            COUNT(*) FILTER (WHERE extracted_by = 'db' AND kind = 'table')::text AS db_tables,
            MAX(extracted_at) FILTER (WHERE extracted_by = 'db') AS db_last,
            MAX(extracted_at) FILTER (WHERE extracted_by <> 'db') AS code_last
     FROM graph_nodes
     WHERE project_id = $1`,
    [projectId]
  );
  const row = r.rows[0];
  return classifyDbSchema({
    dbNodes: Number(row?.db_nodes ?? '0'),
    dbTables: Number(row?.db_tables ?? '0'),
    dbLastExtracted: row?.db_last ?? null,
    codeLastExtracted: row?.code_last ?? null,
    urlConfigured: await isGraphDbUrlConfigured(projectId),
  });
}

/**
 * Boolean only — see the URL RULE at the top of this file.
 *
 * The two halves are scoped differently, on purpose:
 *  - `process.env.MAI_GRAPH_DB_URL` is PROCESS-scoped and belongs to the pinned
 *    project, so it is only evidence when the project asked about IS the pinned
 *    one. Attributing it to another project would be the same category error
 *    cli.ts:600-609 guards against.
 *  - `resolveConsumerGraphDbUrl(projectId)` is PROJECT-scoped by construction —
 *    it reads that project's own path/repos (db-url.ts:24-31) — so it is valid
 *    evidence for any project, pinned or not.
 *
 * This deliberately does NOT copy cli.ts:610's `&& isPinned` guard on the
 * resolver. That guard governs which URL is safe to *introspect with*; this
 * function answers "does this project have a URL configured", and a project's
 * own .env answers that truthfully no matter which session is asking. What the
 * pinning DOES change is the refresh instruction, so `renderDbSchemaSection`
 * carries it — see REFRESH_INSTRUCTION.
 */
async function isGraphDbUrlConfigured(projectId: string): Promise<boolean> {
  if ((process.env.MAI_GRAPH_DB_URL ?? '').trim() !== '' && (await isPinnedProject(projectId))) {
    return true;
  }
  return (await resolveConsumerGraphDbUrl(projectId)) !== undefined;
}

/** getProjectId() throws on an unseeded pinned slug (src/db.ts:101-106); a
 * status read must not start throwing because of that, and an unresolvable
 * pinned project cannot own the env URL anyway. */
async function isPinnedProject(projectId: string): Promise<boolean> {
  try {
    return (await getProjectId()) === projectId;
  } catch {
    return false;
  }
}

/** Numeric code-axis staleness. Delegates to the single producer in
 * staleness.ts — see R3: this function and query.ts's graphStale must never be
 * able to disagree, which they could while each held its own SQL. */
export async function graphStaleCounts(projectId: string): Promise<GraphStaleCounts> {
  const { repos, excludes } = await loadProjectGraphRoots(projectId);
  const perRepo = await projectStaleness(projectId, repos, new SourceEvidence(repos, excludes));
  return {
    total: perRepo.reduce((n, r) => n + r.total, 0),
    stale: perRepo.reduce((n, r) => n + r.stale, 0),
    // An aggregate may not claim more certainty than its weakest member: one
    // repo on the fallback makes the whole number a fallback number.
    method: perRepo.some((r) => r.method === 'whole-graph') ? 'whole-graph' : 'per-file',
  };
}

/** Both axes for prime. */
export async function readGraphFreshness(projectId: string): Promise<GraphFreshness> {
  const [code, db] = await Promise.all([
    graphStaleCounts(projectId),
    readDbSchemaState(projectId),
  ]);
  return { code, db };
}

function asOf(d: Date | null): string {
  return d === null ? 'unknown' : new Date(d).toISOString().slice(0, 16).replace('T', ' ');
}

/** prime's code-axis line. Explicitly scoped `(code)` so it can never be read
 * as a claim about the schema layer — all three prime variants share it. */
export function renderCodePrimeLine(code: GraphStaleCounts): string {
  if (code.total === 0) return `_Graph (code): not built yet — run mai graph build._`;
  if (code.stale > 0) {
    // The wording must match the method. Saying "files changed" on a whole-graph
    // fallback would be a false statement about nodes we could not check.
    return code.method === 'per-file'
      ? `_Graph (code): ${code.stale}/${code.total} nodes whose source differs from extraction — refresh with mai graph update._`
      : `_Graph (code): ${code.stale}/${code.total} nodes with stale or unverified source — refresh with mai graph update._`;
  }
  return `_Graph (code): ${code.total} nodes, source verified._`;
}

/** The exact maxima of the BUDGETED envelope lines: 999999/999999 stale code,
 * and 999999 tables behind code. ONE authority for composer and fixtures. */
export const CODE_FRESHNESS_LINE_MAX = 55;
export const DB_SCHEMA_FRESHNESS_LINE_MAX = 83;

/**
 * Bounded count display (plan 38). Exact through 999,999; `≥1M` above that; `?`
 * for anything that is not a non-negative safe integer. State decisions still
 * use the RAW validated count, never this token.
 */
function boundedCount(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) return '?';
  return n >= 1_000_000 ? '≥1M' : String(n);
}

/** Budgeted-only canonical minute: 16 characters for an ordinary timestamp, 19
 * for an accepted expanded-year one. Deliberately not `asOf`'s fixed-index
 * slice, which assumes the ordinary width. */
function boundedMinute(d: Date | null): string {
  if (d === null) return 'unknown';
  return new Date(d).toISOString().slice(0, -8).replace('T', ' ');
}

/** prime's code-axis line, ENVELOPE form: same three states, bounded width. */
export function renderCodePrimeEnvelopeLine(code: GraphStaleCounts): string {
  if (code.total === 0) return `_Graph (code): not built — mai graph build._`;
  if (code.stale > 0) {
    return `_Graph (code): ${boundedCount(code.stale)}/${boundedCount(code.total)} stale — mai graph update._`;
  }
  return `_Graph (code): ${boundedCount(code.total)} nodes, source verified._`;
}

/** prime's schema-axis line, ENVELOPE form: all five states keep their action
 * and honesty boundary; only the wording is compact. */
export function renderDbSchemaPrimeEnvelopeLine(db: DbSchemaState): string {
  const core = ((): string => {
    switch (db.state) {
      case 'not-configured':
        return `not configured; kind:'table' returns none`;
      case 'never-extracted':
        return `never extracted — mai graph update`;
      case 'stale':
        return db.reason === 'no-url'
          ? `${boundedCount(db.tables)} tables, STALE (no URL); answers may be incomplete`
          : `${boundedCount(db.tables)} tables, STALE (behind code); answers may be incomplete`;
      case 'fresh':
        return `${boundedCount(db.tables)} tables, fresh as of ${boundedMinute(db.lastExtracted)}; not live`;
    }
  })();
  return `_Graph (db schema): ${core}._`;
}

/** prime's schema-axis line. Rendered for EVERY state — silence is what caused
 * the bug this plan fixes. */
export function renderDbSchemaPrimeLine(db: DbSchemaState): string {
  switch (db.state) {
    case 'not-configured':
      return `_Graph (db schema): not configured — no MAI_GRAPH_DB_URL for this project; kind:'table' questions will find nothing._`;
    case 'never-extracted':
      return `_Graph (db schema): configured but never extracted — run mai graph update._`;
    case 'stale':
      return db.reason === 'no-url'
        ? `_Graph (db schema): ${db.tables} tables as of ${asOf(db.lastExtracted)} — STALE: no MAI_GRAPH_DB_URL resolvable, so mai graph update is skipping the schema layer. Schema answers may be missing or wrong._`
        : `_Graph (db schema): ${db.tables} tables as of ${asOf(db.lastExtracted)} — STALE: a newer code extraction ran without a schema refresh. Schema answers may be missing or wrong._`;
    case 'fresh':
      return `_Graph (db schema): ${db.tables} tables, schema pass ${asOf(db.lastExtracted)} (as of that pass — not a live comparison)._`;
  }
}

/** Compact-briefing clause. `null` when fresh: the compact path is pinned under
 * 1,500 chars, and a fresh schema is the state that needs no words. */
export function renderDbSchemaCompactClause(db: DbSchemaState): string | null {
  switch (db.state) {
    case 'fresh':
      return null;
    case 'not-configured':
      return 'db schema: not configured';
    case 'never-extracted':
      return 'db schema: never extracted';
    case 'stale':
      return db.reason === 'no-url'
        ? 'db schema: stale (no MAI_GRAPH_DB_URL)'
        : 'db schema: stale (behind code)';
  }
}

/**
 * `graphStale` is the ONE freshness surface that can report on a project other
 * than the pinned one (`mai graph stale --project S` at cli.ts:652;
 * `/api/graph/stale?project=S` at web-server.ts:295, whose `project(url)` helper
 * resolves any slug — web-server.ts:140-146). For those projects `mai graph
 * update` will not resolve the project's own .env, because cli.ts:610 gates that
 * resolution on the pinned slug. Telling such an operator to "run mai graph
 * update" without saying where from is advice that silently does nothing, so
 * every refresh instruction in this section names the requirement. prime's lines
 * do not: prime has no project parameter (iron rule 2) and is always pinned.
 */
const REFRESH_INSTRUCTION =
  'run `mai graph update` from a session pinned to this project, or `mai graph build --project <slug> --db-url <dev-db-url>` from anywhere.';

/** The `## DB schema` block for graphStale — every state, including
 * not-configured, and including projects with no repos recorded. */
export function renderDbSchemaSection(db: DbSchemaState): string[] {
  const lines = ['## DB schema'];
  if (db.state === 'not-configured') {
    lines.push(
      `- state: NOT CONFIGURED — no MAI_GRAPH_DB_URL resolvable for this project, so no schema has ever been introspected; kind:'table' questions will find nothing.`,
      `- fix: set MAI_GRAPH_DB_URL in the project's own gitignored .env, then ${REFRESH_INSTRUCTION}`
    );
    return lines;
  }
  if (db.state === 'never-extracted') {
    lines.push(
      `- state: NEVER EXTRACTED — a dev-DB URL resolves for this project but no schema nodes exist yet.`,
      `- fix: ${REFRESH_INSTRUCTION}`
    );
    return lines;
  }
  lines.push(`- ${db.tables} tables, ${db.nodes} nodes — last introspection ${asOf(db.lastExtracted)}`);
  if (db.state === 'fresh') {
    lines.push(`- state: FRESH as of that introspection — not a live comparison against the database.`);
    return lines;
  }
  if (db.reason === 'no-url') {
    lines.push(
      `- state: STALE — no MAI_GRAPH_DB_URL resolvable from this project's .env, so \`mai graph update\` is skipping the schema layer entirely.`,
      `- fix: set MAI_GRAPH_DB_URL in the project's own gitignored .env, then ${REFRESH_INSTRUCTION}`
    );
    return lines;
  }
  lines.push(
    `- state: STALE — a newer code extraction ran without a schema refresh, so the schema layer is behind the code layer.`,
    `- fix: ${REFRESH_INSTRUCTION}`
  );
  return lines;
}

/** Tone drives the banner's colour; the text is prime's, unchanged. */
export type FreshnessTone = 'ok' | 'warn' | 'info';

export interface FreshnessLine {
  tone: FreshnessTone;
  text: string;
}

export interface FreshnessBannerPayload {
  code: FreshnessLine;
  db: FreshnessLine;
}

/** prime's renderers wrap their sentence in markdown emphasis; the banner is not
 * markdown. Each end is anchored SEPARATELY and deliberately: a sentence with an
 * underscore inside it (MAI_GRAPH_DB_URL) must survive intact, which a global
 * replace would destroy. */
function stripEmphasis(line: string): string {
  return line.replace(/^_/, '').replace(/_$/, '');
}

function codeTone(code: GraphStaleCounts): FreshnessTone {
  if (code.total === 0) return 'info';
  return code.stale > 0 ? 'warn' : 'ok';
}

function dbTone(db: DbSchemaState): FreshnessTone {
  switch (db.state) {
    case 'fresh': return 'ok';
    case 'stale': return 'warn';
    case 'not-configured':
    case 'never-extracted': return 'info';
  }
}

/**
 * The Graph tab's freshness strip (plan 29 R10). Its sentences are DERIVED from
 * renderCodePrimeLine/renderDbSchemaPrimeLine, never restated: the frontend
 * composes no freshness wording at all, so prime and the banner cannot drift.
 * freshness-banner.test.ts asserts that equality for every state.
 */
export function renderFreshnessBanner(f: GraphFreshness): FreshnessBannerPayload {
  return {
    code: { tone: codeTone(f.code), text: stripEmphasis(renderCodePrimeLine(f.code)) },
    db: { tone: dbTone(f.db), text: stripEmphasis(renderDbSchemaPrimeLine(f.db)) },
  };
}
