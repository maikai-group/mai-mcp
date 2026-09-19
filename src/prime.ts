import { renderWorkflowHint } from './workflow-routing.js';
import { getPool, getProjectId, loadProjectGraphRoots } from './db.js';
import { PROJECT_SLUG } from './env.js';
import { preparePrimeTopics, type TopicEntry } from './topics.js';
import { prepareTimeline, timeline, unifiedSearchSections } from './decisions.js';
import { coordination } from './coordination/index.js';
import { graphFindForTask } from './graph/query.js';
import {
  readGraphFreshness,
  renderCodePrimeEnvelopeLine,
  renderCodePrimeLine,
  renderDbSchemaCompactClause,
  renderDbSchemaPrimeEnvelopeLine,
  renderDbSchemaPrimeLine,
  type GraphFreshness,
} from './graph/freshness.js';
import { primeFactsSection } from './facts.js';
import { primeIdeasSection } from './ideas.js';
import { preparePrimeSharedSection } from './shares.js';
import { primeCurationSection } from './curation.js';
import { planLifecycleSection } from './git/plan-lifecycle.js';
import { buildRestartBanner } from './build-info.js';
import { coordinationIdentity, currentChatIdentity } from './session-identity.js';
import {
  budgetRows, budgetSections, headlineField, MCP_READ_NARROWING,
  type ReadBudget, type ReadSection,
} from './read-budget.js';
import {
  allocatePrimeBudget, demandCapPrimeMinimum, preparePrimeSource, renderPrimeAllocation,
  type PrimeRenderedAllocation, type PrimeSourceKey, type PreparedPrimeSource,
} from './prime-budget.js';

interface PrimeRootState {
  repos: string[];
  repairDiagnostic: string | null;
}

async function primeRootState(projectId: string): Promise<PrimeRootState> {
  try {
    return { repos: (await loadProjectGraphRoots(projectId)).repos, repairDiagnostic: null };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 600);
    if (!/Repair with: mai init|Invalid registered graph path|Project metadata\./.test(message)) throw error;
    return { repos: [], repairDiagnostic: message };
  }
}

function primeFreshnessLines(
  freshness: GraphFreshness | null,
  repairDiagnostic: string | null,
  envelope: boolean,
): [string, string] {
  if (repairDiagnostic !== null) return [`_Graph root repair required: ${repairDiagnostic}_`, ''];
  if (freshness === null) throw new Error('prime freshness unavailable without a repair diagnostic');
  return envelope
    ? [renderCodePrimeEnvelopeLine(freshness.code), renderDbSchemaPrimeEnvelopeLine(freshness.db)]
    : [renderCodePrimeLine(freshness.code), renderDbSchemaPrimeLine(freshness.db)];
}

/** The exact ceilings the composed fixed envelope is held to (plan 38 R7). */
export const PRIME_HEADER_MAX = 204;
export const PRIME_ENVELOPE_MAX = 2_538;
export const PRIME_FACTS_MAX = 200;
export const PRIME_IDEAS_MAX = 400;
export const PRIME_LIFECYCLE_MAX = 300;
export const PRIME_AGENT_ID_DISPLAY_MAX = 120;
export const PRIME_CODEX_PROFILE_DISPLAY_MAX = 64;
/** Both identity fields may consist entirely of JSON-escaped characters. */
export const PRIME_IDENTITY_LINE_MAX = 472;
/** A slug of at most 48 chars is byte-complete; longer legal slugs keep their
 * first 24 and last 23 characters around one ellipsis. The database value is
 * never mutated — this is a display identity, not a claim of completeness. */
export const PRIME_SLUG_DISPLAY_MAX = 48;
/** The task label lives inside the ALLOCATED search prefix, not the envelope. */
export const PRIME_TASK_LABEL_MAX = 240;

/** Explicit session identity supplied by the harness/profile. This is an alias,
 * not a claim that mai can inspect the authenticated ChatGPT account. */
export function renderPrimeIdentityLine(env: NodeJS.ProcessEnv = process.env): string {
  const safeField = (value: string, max: number): string =>
    headlineField(
      value
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, '�')
        .replace(/[\ud800-\udfff]/g, '�'),
      max,
    );
  const identity = safeField(coordinationIdentity(env), PRIME_AGENT_ID_DISPLAY_MAX);
  const profile = env.MAI_CODEX_PROFILE
    ? safeField(env.MAI_CODEX_PROFILE, PRIME_CODEX_PROFILE_DISPLAY_MAX)
    : null;
  const source = currentChatIdentity() ? 'chat attribution; not a live message route'
    : env.MAI_AGENT_ID ? 'configured by MAI_AGENT_ID' : 'MAI_AGENT_ID is not configured';
  return `**Session identity:** ${JSON.stringify(identity)}${profile ? ` · Codex profile ${JSON.stringify(profile)}` : ''} (${source}; alias only, not verified login)`;
}

const TOPICS_PREFIX = '\n\n---\n\n';
const TIMELINE_PREFIX = '\n\n---\n\n## Recent activity (handoff from prior sessions)\n\n';
const BOARD_PREFIX = '\n\n---\n\n';
const CLAIMS_PREFIX = '\n\n---\n\n';
const SHARED_PREFIX = '\n\n---\n\n';
const GRAPH_PREFIX = '\n\n---\n\n## Structure (graph) relevant to the task\n\n';
const SEARCH_RECOVERY_MINIMUM = '_mai_search for prior decisions and lessons._';
const GRAPH_RECOVERY_MINIMUM = '_mai_graph_find for structure matches._';
const NO_TOPICS_LEGACY = '_No topics matched (or none authored yet) — see mai_topics._';
// Every character here is FIXED envelope (plan 38 R7): the pointer names the
// wave-2 tools without the parentheticals their own descriptions already carry,
// because the worst-case envelope must stay at or below PRIME_ENVELOPE_MAX.
const STRUCTURE_POINTER =
  `_Structure questions (what calls what, schemas): mai_graph_find / mai_graph_neighbors / mai_graph_trace / mai_graph_impact / mai_graph_query / mai_graph_dead_code. History/decisions: mai_search. Before writing memories: you already hold read tokens from this prime._`;
const CAPTURE_REMINDER =
  `_Before closing this session: sweep for decisions/lessons future agents will need and record them (mai_remember / mai_lesson_add) — skip trivia, approvals, and dupes; consider whether any durable fact should become a topic; mai_report for the day's digest._`;

/** Fit `text` into `room` characters, marking any shortening. */
function fitField(text: string, room: number): string {
  if (room <= 0) return '';
  return text.length <= room ? text : `${text.slice(0, Math.max(0, room - 1))}…`;
}

/** Bounded slug identity — head + tail around one ellipsis past 48 characters. */
export function boundedPrimeSlug(slug: string): string {
  if (slug.length <= PRIME_SLUG_DISPLAY_MAX) return slug;
  return `${slug.slice(0, 24)}…${slug.slice(-23)}`;
}

/**
 * The identity header, at most `PRIME_HEADER_MAX` characters. The loaded-topic
 * count and the bounded slug always survive; project name/description, the
 * joined repository list and the joined topic labels are fitted in that order.
 */
export function renderPrimeHeader(input: {
  slug: string;
  name: string | null;
  description: string | null;
  repos: readonly string[];
  topics: readonly string[];
  mode: 'summary' | 'full';
}): string {
  const head = `# mai-prime — project '${boundedPrimeSlug(input.slug)}'`;
  const loadedPrefix = `Loaded ${input.topics.length} topic(s) (${input.mode}): `;
  const skeleton = `${head}\n\n****\nRepos: \n\n${loadedPrefix}`;
  let room = PRIME_HEADER_MAX - skeleton.length;

  const named = headlineField(input.name ?? input.slug, PRIME_TASK_LABEL_MAX);
  const described = input.description ? ` — ${headlineField(input.description, PRIME_TASK_LABEL_MAX)}` : '';
  const identity = fitField(`${named}${described}`, room);
  room -= identity.length;
  const repos = fitField(input.repos.join(', ') || '(none recorded)', room);
  room -= repos.length;
  const labels = fitField(input.topics.join(', ') || '—', room);

  return `${head}\n\n**${identity}**\nRepos: ${repos}\n\n${loadedPrefix}${labels}`;
}

/** The structural shape task-prime renders from. `graphFindForTask`'s row type
 * is module-private in graph/query.ts, and exporting it is outside this plan's
 * file map, so the seam is structural — the compiler still checks every field. */
interface PrimeGraphHit {
  id: string;
  kind: string;
  name: string;
  qualified_name: string | null;
  file_path: string | null;
  line: number | null;
}

/** The graph rows exactly as task-prime has always rendered them. */
function graphFullRows(hits: readonly PrimeGraphHit[]): string {
  if (hits.length === 0) return '_No graph nodes match the task — explore with mai_graph_find._';
  return hits
    .map((n) => {
      const loc = n.file_path ? ` — ${n.file_path}${n.line ? `:${n.line}` : ''}` : '';
      return `- [${n.kind}] ${n.qualified_name ?? n.name}${loc}\n  id: ${n.id}`;
    })
    .join('\n');
}

function graphHeadlineRow(n: PrimeGraphHit): string {
  return `- [${n.kind}] ${headlineField(n.qualified_name ?? n.name, 120)}\n  id: ${n.id}`;
}

/** One ordered document: a plain string is a FIXED envelope fragment; a
 * `{ source }` ref is an allocated source whose own prefix and heading ride
 * inside its demand. The ref is an object on purpose — a source key is itself a
 * string, so a `typeof` discrimination would silently charge the key's own
 * characters to the envelope. */
export type PrimeDocumentPiece = string | { source: PrimeSourceKey };
export const primeSourceRef = (source: PrimeSourceKey): PrimeDocumentPiece => ({ source });

export interface BudgetedPrimeResult {
  text: string;
  envelopeChars: number;
  allocation: PrimeRenderedAllocation;
}

/**
 * The production composition seam (plan 38): measure the fixed envelope,
 * allocate what remains, render every source once, redistribute the actual
 * residual once, and concatenate the RETURNED fragments. Pure — every producer
 * has already run.
 */
export function composeBudgetedPrime(input: {
  budget: ReadBudget;
  document: readonly PrimeDocumentPiece[];
  sources: readonly PreparedPrimeSource[];
  workflowHint?: string;
}): BudgetedPrimeResult {
  const keys = new Set<PrimeSourceKey>(input.sources.map((s) => s.key));
  let envelopeChars = input.document
    .reduce((sum, piece) => sum + (typeof piece === 'string' ? piece.length : 0), 0);
  if (envelopeChars > PRIME_ENVELOPE_MAX) {
    throw new Error(`prime envelope invariant failed: ${envelopeChars} > ${PRIME_ENVELOPE_MAX}`);
  }
  const suffix = input.workflowHint ? `\n\n${input.workflowHint}` : '';
  const minimumChars = input.sources.reduce((sum, source) => sum + source.minimum.length, 0);
  const hintFits = envelopeChars + suffix.length <= PRIME_ENVELOPE_MAX
    && envelopeChars + suffix.length + minimumChars <= input.budget.charBudget;
  const document = hintFits && suffix ? [...input.document, suffix] : input.document;
  if (hintFits) envelopeChars += suffix.length;
  const allocation = allocatePrimeBudget(input.budget.charBudget, envelopeChars, input.sources);
  const rendered = renderPrimeAllocation(allocation, input.sources);
  const text = document
    .map((piece) => {
      if (typeof piece === 'string') return piece;
      if (!keys.has(piece.source)) {
        throw new Error(`prime document references unprepared source ${piece.source}`);
      }
      return rendered.fragments.get(piece.source) ?? '';
    })
    .join('');
  if (text.length > input.budget.charBudget) {
    throw new Error(`prime budget invariant failed: ${text.length} > ${input.budget.charBudget}`);
  }
  return { text, envelopeChars, allocation: rendered };
}

/**
 * mai_prime — the one-call session start (spec §5).
 * Composition: project overview → matched topics (summary) → 7-day timeline →
 * task-relevant decisions+lessons. The unifiedSearch call mints write-gate
 * read tokens, so a primed session can already write with citations.
 * Plan 4c appends the structure-graph section: top graph hits for the task +
 * a one-line freshness warning (mai-graph replaced Graphify at parity).
 *
 * `budget` is supplied by the MCP dispatch alone (plan 38). Without it the
 * existing composition stays byte-identical for unmatched tasks; matched tasks
 * append an optional workflow hint. With it, every source is prepared once and allocated an exact share so the
 * finished body already fits and the finalizer has nothing to blind-cut.
 */
export async function prime(
  taskDescription: string,
  mode: 'summary' | 'full',
  budget?: ReadBudget,
): Promise<string> {
  // Plan 15 Task 6: surface a stale RUNNING build exactly once, at the top.
  const restartBanner = await buildRestartBanner(undefined, undefined, budget !== undefined);
  const pool = getPool();
  const projectId = await getProjectId();
  const project = await pool.query<{
    name: string | null;
    description: string | null;
    path: string | null;
    metadata: { repos?: string[] };
  }>(`SELECT name, description, path, metadata FROM projects WHERE id = $1`, [projectId]);
  const p = project.rows[0];
  const rootState = await primeRootState(projectId);
  const repos = rootState.repos;

  const [
    preparedTopics, preparedTimeline, searchSections, graphHits, freshness,
    coordPrepared, factsBlock, ideasBlock, preparedShared, lifecycleBlock, curationLine,
  ] = await Promise.all([
    preparePrimeTopics(taskDescription, mode),
    prepareTimeline(7, 25),
    unifiedSearchSections({ query: taskDescription, kind: 'all', limit: 8, includeShares: false }),
    graphFindForTask({ task: taskDescription, limit: 5, projectId }),
    rootState.repairDiagnostic === null ? readGraphFreshness(projectId) : Promise.resolve(null),
    coordination.primePreparedSections(projectId),
    primeFactsSection(budget === undefined ? undefined : PRIME_FACTS_MAX),
    primeIdeasSection(projectId, budget === undefined ? undefined : PRIME_IDEAS_MAX),
    preparePrimeSharedSection(projectId),
    planLifecycleSection(projectId, budget === undefined ? undefined : PRIME_LIFECYCLE_MAX),
    // Operator signal, task-scoped prime ONLY. Deliberately NOT in
    // primeStartup(), which context-budget.test.ts pins under 1,500 chars —
    // and where an operator signal does not belong anyway (spec §5.2).
    primeCurationSection(projectId, budget !== undefined),
  ]);

  const topicLabels = preparedTopics.topics.map((t: TopicEntry) => t.topic);
  const workflowHint = renderWorkflowHint(taskDescription);

  if (budget === undefined) {
    const topicBlock = preparedTopics.topics.length > 0 ? preparedTopics.full : NO_TOPICS_LEGACY;
    const searchBlock = budgetSections(undefined, searchSections, 'result', MCP_READ_NARROWING.mai_search);
    const coordSections = [coordPrepared.board.full, coordPrepared.claims.full].filter(Boolean);
    const sharedBlock = preparedShared.legacyFull;
    const body = [
      `# mai-prime — project '${PROJECT_SLUG}'`,
      renderPrimeIdentityLine(),
      '',
      `**${p.name ?? PROJECT_SLUG}**${p.description ? ` — ${p.description}` : ''}`,
      `Repos: ${repos.join(', ') || '(none recorded)'}`,
      '',
      `Loaded ${preparedTopics.topics.length} topic(s) (${mode}): ${topicLabels.join(', ') || '—'}`,
      '',
      '---',
      '',
      topicBlock,
      '',
      '---',
      '',
      `## Recent activity (handoff from prior sessions)`,
      '',
      preparedTimeline.full,
      '',
      ...coordSections.flatMap((s) => ['---', '', s, '']),
      ...(factsBlock ? ['---', '', factsBlock, ''] : []),
      ...(ideasBlock ? ['---', '', ideasBlock, ''] : []),
      ...(sharedBlock ? ['---', '', sharedBlock, ''] : []),
      ...(lifecycleBlock ? ['---', '', lifecycleBlock, ''] : []),
      ...(curationLine ? [curationLine, ''] : []),
      '---',
      '',
      `## Prior decisions + lessons relevant to: "${taskDescription}"`,
      '',
      searchBlock,
      '',
      '---',
      '',
      `## Structure (graph) relevant to the task`,
      '',
      graphFullRows(graphHits),
      '',
      ...primeFreshnessLines(freshness, rootState.repairDiagnostic, false),
      '',
      '---',
      '',
      STRUCTURE_POINTER,
      '',
      CAPTURE_REMINDER,
      ...(workflowHint ? ['', workflowHint] : []),
    ].join('\n');
    return restartBanner === null ? body : `${restartBanner}\n${body}`;
  }

  // ----- budgeted composition (MCP dispatch only) -----
  const searchFull = budgetSections(undefined, searchSections, 'result', MCP_READ_NARROWING.mai_search);
  const searchMinimum = demandCapPrimeMinimum(searchFull, SEARCH_RECOVERY_MINIMUM);
  const preparedSearch = {
    minimum: searchMinimum,
    full: searchFull,
    render: (charBudget?: number): string =>
      budgetSections(
        charBudget === undefined ? undefined : { fullRows: countSectionRows(searchSections), charBudget },
        searchSections, 'result', MCP_READ_NARROWING.mai_search, searchMinimum,
      ),
  };

  const graphFull = graphFullRows(graphHits);
  const graphMinimum = demandCapPrimeMinimum(graphFull, GRAPH_RECOVERY_MINIMUM);
  const preparedGraph = {
    minimum: graphMinimum,
    full: graphFull,
    render: (charBudget?: number): string =>
      graphHits.length === 0
        ? (charBudget === undefined || charBudget >= graphFull.length ? graphFull : graphMinimum)
        : budgetRows(
            charBudget === undefined ? undefined : { fullRows: graphHits.length, charBudget },
            graphHits, graphFullRows, graphHeadlineRow, '', 'node',
            MCP_READ_NARROWING.mai_graph_find, graphMinimum,
          ),
  };

  const taskLabel = headlineField(taskDescription, PRIME_TASK_LABEL_MAX);
  const sources: PreparedPrimeSource[] = [
    preparePrimeSource('search', `\n\n---\n\n## Prior decisions + lessons relevant to: "${taskLabel}"\n\n`, preparedSearch),
    preparePrimeSource('topics', TOPICS_PREFIX, preparedTopics),
    preparePrimeSource('board', BOARD_PREFIX, coordPrepared.board),
    preparePrimeSource('claims', CLAIMS_PREFIX, coordPrepared.claims),
    preparePrimeSource('graph', GRAPH_PREFIX, preparedGraph),
    preparePrimeSource('shared', SHARED_PREFIX, preparedShared),
    preparePrimeSource('timeline', TIMELINE_PREFIX, preparedTimeline),
  ];

  const header = renderPrimeHeader({
    slug: PROJECT_SLUG, name: p.name, description: p.description,
    repos, topics: topicLabels, mode,
  });
  const document: PrimeDocumentPiece[] = [
    restartBanner === null ? '' : `${restartBanner}\n`,
    header,
    `\n${renderPrimeIdentityLine()}`,
    primeSourceRef('topics'),
    primeSourceRef('timeline'),
    primeSourceRef('board'),
    primeSourceRef('claims'),
    factsBlock ? `\n\n---\n\n${factsBlock}` : '',
    ideasBlock ? `\n\n---\n\n${ideasBlock}` : '',
    primeSourceRef('shared'),
    lifecycleBlock ? `\n\n---\n\n${lifecycleBlock}` : '',
    curationLine ? `\n\n${curationLine}` : '',
    primeSourceRef('search'),
    primeSourceRef('graph'),
    `\n\n${primeFreshnessLines(freshness, rootState.repairDiagnostic, true).filter(Boolean).join('\n')}`,
    `\n\n---\n\n${STRUCTURE_POINTER}\n\n${CAPTURE_REMINDER}`,
  ];
  return composeBudgetedPrime({ budget, document, sources, workflowHint }).text;
}

/** Total prepared rows across search sections — the row count prime fits on. */
function countSectionRows(sections: readonly ReadSection[]): number {
  return sections.reduce((sum, section) => sum + section.fullRows.length, 0);
}

/**
 * Startup briefing — auto-injected by the SessionStart hook. The hook runs as a
 * SEPARATE short-lived process, so this does NOT mint the agent's write token
 * (that is PID-keyed to the MCP server) and has no task yet. Its job is purely
 * to guarantee every session OPENS aware the brain + structure graph exist and
 * how to use them — the adoption gap a passive nudge didn't close.
 *
 * MAI_PRIME_STARTUP controls verbosity: 'compact' (the default — a budgeted
 * headline view under 1,500 chars) / 'full' (the original briefing) / 'off'
 * (nothing). The full mai_prime("<task>") output is unchanged either way — this
 * only slims the auto-injected hook path.
 */
export async function primeStartup(): Promise<string> {
  const mode = process.env.MAI_PRIME_STARTUP ?? 'compact';
  if (mode === 'off') return '';
  if (mode === 'full') return primeStartupFull();
  return primeStartupCompact();
}

/** Budgeted headline view (< 1,500 chars): repos, recent-activity count,
 * coordination counts, graph freshness, and the mai_prime call-to-action. */
async function primeStartupCompact(): Promise<string> {
  const restartBanner = await buildRestartBanner();
  const pool = getPool();
  const projectId = await getProjectId();
  const rootState = await primeRootState(projectId);
  const repos = rootState.repos;

  const [sessions, freshness, coordCounts] = await Promise.all([
    pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM code_sessions WHERE project_id = $1 AND started_at > now() - interval '7 days'
         AND (metadata->>'superseded_by_segmentation') IS DISTINCT FROM 'true'`,
      [projectId]
    ),
    rootState.repairDiagnostic === null ? readGraphFreshness(projectId) : Promise.resolve(null),
    coordination.primeCounts(projectId),
  ]);

  const recent = Number(sessions.rows[0]?.n ?? 0);
  const activityLine =
    recent > 0 ? `${recent} session(s) in the last 7 days.` : 'No recent events.';
  const graphLine = rootState.repairDiagnostic !== null
    ? `Graph root repair required: ${rootState.repairDiagnostic}`
    : (() => {
      if (freshness === null) throw new Error('startup freshness unavailable');
      const codeClause = freshness.code.total === 0
        ? 'Graph: not built yet — run mai graph build'
        : `Graph: ${freshness.code.stale}/${freshness.code.total} nodes stale${
            freshness.code.method === 'whole-graph' ? ' (unverified)' : ''}`;
      const schemaClause = renderDbSchemaCompactClause(freshness.db);
      return schemaClause === null ? `${codeClause}.` : `${codeClause}; ${schemaClause}.`;
    })();

  const body = [
    `# mai brain — project '${PROJECT_SLUG}' (${repos.length} repo(s))`,
    activityLine,
    ...(coordCounts ? [coordCounts] : []),
    graphLine,
    `This is a headline view. Call mai_prime("<what you're about to do>") for prior`,
    `decisions, lessons, and structure hits — it also unlocks brain writes.`,
  ].join('\n');
  // Compact stays under its 1,500-char pin even with the maximum banner.
  return restartBanner === null ? body : `${restartBanner}\n${body}`;
}

/** The original full startup briefing (MAI_PRIME_STARTUP=full). */
async function primeStartupFull(): Promise<string> {
  const pool = getPool();
  const projectId = await getProjectId();
  const project = await pool.query<{
    name: string | null;
    description: string | null;
    path: string | null;
    metadata: { repos?: string[] } | null;
  }>(`SELECT name, description, path, metadata FROM projects WHERE id = $1`, [projectId]);
  const p = project.rows[0];
  const rootState = await primeRootState(projectId);
  const repos = rootState.repos;

  const [timelineBlock, freshness, coordSections] = await Promise.all([
    timeline(7, 15),
    rootState.repairDiagnostic === null ? readGraphFreshness(projectId) : Promise.resolve(null),
    coordination.primeSections(projectId),
  ]);

  const [codeLine, schemaLine] = primeFreshnessLines(freshness, rootState.repairDiagnostic, false);

  return [
    `# mai-mcp startup briefing — project '${PROJECT_SLUG}'`,
    '',
    `**${p?.name ?? PROJECT_SLUG}**${p?.description ? ` — ${p.description}` : ''}`,
    `Repos: ${repos.join(', ') || '(none recorded)'}`,
    '',
    `## Recent activity (handoff from prior sessions)`,
    '',
    timelineBlock,
    '',
    codeLine,
    schemaLine,
    '',
    ...coordSections.flatMap((s) => [s, '']),
    `## Use the brain — don't rediscover what it already knows`,
    `- **Structure & schema questions → the graph, not grep.** \`mai_graph_find\` (use \`kind:'table'\` for schema) locates files/functions/routes/tables; \`mai_graph_neighbors\` shows what connects (a table's columns + the code touching it); \`mai_graph_impact\` shows what breaks if you change it (incl. FK-dependent tables); \`mai_graph_trace\` shows how code reaches a table; \`mai_graph_query\` runs one bounded multi-hop query and \`mai_graph_dead_code\` lists conservative candidates (never proof). The full live DB schema is already in the graph.`,
    `- **Decisions & lessons → \`mai_search\`** before any non-trivial choice — you may be contradicting a past decision.`,
    `- **Brain writes are SHORT.** A decision/lesson is a one-sentence headline; rationale goes in \`reasoning\`/\`context\`, not the headline. A full execution report (branches, commits, gates, pending work) is a \`mai_progress\` milestone, NOT a \`mai_remember\` description — cramming it in blows the char limit and loops.`,
    '',
    `_This briefing is read-only context — it did NOT mint your write token. For task-relevant decisions/lessons + the structure hits for what you're about to do, AND to unlock brain writes, call \`mai_prime("<what you're about to do>")\` now._`,
    '',
    `_mai = me + AI. Be water: sessions are the ever-changing flow; this brain is the riverbed the flow leaves behind — and the riverbed shapes every flow that follows._`,
  ].join('\n');
}
