// Ideas/roadmap board (spec 2026-08-06 §A). Per-project boards + one global
// board (project_id IS NULL). Agents park ideas and make evidence-backed
// moves; curation (prioritize/reorder/plan/drop) is the operator's, via the
// web surface. The wall stands: scope is 'project' (pinned) or 'global' —
// never another project.
import { getPool, getProjectId } from './db.js';
import { budgetPage, budgetRows, headlineField, pageBudget, type ReadBudget } from './read-budget.js';
import type { PoolClient } from 'pg';

export type IdeaStatus = 'idea' | 'planned' | 'building' | 'shipped' | 'dropped';
export type IdeaPriority = 'now' | 'next' | 'later' | 'someday';
export type IdeaScope = 'project' | 'global' | 'both';
export const IDEA_STATUSES: IdeaStatus[] = ['idea', 'planned', 'building', 'shipped', 'dropped'];
export const IDEA_PRIORITIES: IdeaPriority[] = ['now', 'next', 'later', 'someday'];
export const IDEA_SCOPES: IdeaScope[] = ['project', 'global', 'both'];
export const IDEA_PRIORITY_RANK = {
  now: 0,
  next: 1,
  later: 2,
  someday: 3,
} as const satisfies Record<IdeaPriority, number>;

const IDEA_PRIORITY_SQL = `CASE priority
  WHEN 'now' THEN 0
  WHEN 'next' THEN 1
  WHEN 'later' THEN 2
  WHEN 'someday' THEN 3
  ELSE 4 END`;

const IDEA_ROW_COLUMNS = [
  'id', 'project_id', 'title', 'detail', 'status', 'priority',
  'sort_order', 'source', 'evidence', 'created_at', 'updated_at',
] as const;

function ideaRowProjection(alias?: string): string {
  return IDEA_ROW_COLUMNS.map((column) => alias ? `${alias}.${column}` : column).join(', ');
}

export interface IdeaRow {
  id: string; project_id: string | null; title: string; detail: string | null;
  status: IdeaStatus; priority: IdeaPriority; sort_order: number;
  source: string; evidence: string | null; created_at: string; updated_at: string;
}

interface IdeaDbRow extends Omit<IdeaRow, 'created_at' | 'updated_at'> { created_at: Date; updated_at: Date }
interface IdeaOrderDbRow {
  id: string;
  project_id: string | null;
  status: IdeaStatus;
  priority: IdeaPriority;
  sort_order: number;
  created_at: Date;
}

type BandPlacement = 'prepend' | 'append';
interface IdeaBand {
  projectId: string | null;
  status: IdeaStatus;
  priority: IdeaPriority;
}

type IdeaBandTestStage = 'before-band-locks' | 'after-first-band-lock' | 'before-target-row-locks';
type IdeaBandTestHook = (
  stage: IdeaBandTestStage,
  detail: { keys: readonly string[]; band?: IdeaBand },
) => Promise<void>;

let ideaBandTestHook: IdeaBandTestHook | undefined;

export function setIdeaBandTestHookForTests(hook?: IdeaBandTestHook): void {
  ideaBandTestHook = hook;
}

function ideaBandKey(band: IdeaBand): string {
  return `idea-band-v1:${band.projectId ?? 'global'}:${band.status}:${band.priority}`;
}

async function lockIdeaBands(client: PoolClient, bands: readonly IdeaBand[]): Promise<void> {
  const keys = [...new Set(bands.map(ideaBandKey))].sort((a, b) => a.localeCompare(b));
  await ideaBandTestHook?.('before-band-locks', { keys });
  for (const [index, key] of keys.entries()) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
    if (index === 0) await ideaBandTestHook?.('after-first-band-lock', { keys });
  }
}

async function bandEdgeRankLocked(
  client: PoolClient,
  band: IdeaBand,
  placement: BandPlacement,
  excludingId?: string,
): Promise<number> {
  await ideaBandTestHook?.('before-target-row-locks', { keys: [ideaBandKey(band)], band });
  const rows = await client.query<{ sort_order: number }>(
    `SELECT sort_order FROM ideas
     WHERE project_id IS NOT DISTINCT FROM $1::uuid
       AND status = $2::text
       AND priority = $3::text
       AND ($4::uuid IS NULL OR id <> $4::uuid)
     ORDER BY id FOR UPDATE`,
    [band.projectId, band.status, band.priority, excludingId ?? null],
  );
  const ranks = rows.rows.map((row) => Number(row.sort_order));
  if (ranks.length === 0) return 1000;
  return placement === 'prepend'
    ? Math.min(...ranks) - 1000
    : Math.max(...ranks) + 1000;
}

const IDENTITY_DRIFT = Symbol('idea identity drift');

async function runIdeaWriteWithRetry<T>(
  operation: (client: PoolClient) => Promise<T | typeof IDENTITY_DRIFT>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      if (result === IDENTITY_DRIFT) {
        await client.query('ROLLBACK');
        continue;
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  throw new Error('board changed while moving the idea — reload and try again');
}

function sameBandIdentity(a: IdeaOrderDbRow, b: IdeaOrderDbRow): boolean {
  return a.project_id === b.project_id && a.status === b.status && a.priority === b.priority;
}
const toRow = (r: IdeaDbRow): IdeaRow => ({
  ...r,
  sort_order: Number(r.sort_order),
  created_at: new Date(r.created_at).toISOString(),
  updated_at: new Date(r.updated_at).toISOString(),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IdeaAddArgs {
  title: string; detail?: string; priority?: IdeaPriority;
  scope?: 'project' | 'global'; source?: 'user' | 'agent-inferred';
}

/** Add against the PINNED project (the MCP path — no slug parameter exists). */
export async function ideaAdd(args: IdeaAddArgs): Promise<IdeaRow> {
  return ideaAddForProject(args, await getProjectId());
}

/**
 * Add against an explicitly selected project — the web surface only, where the
 * operator picks the project via ?project=. One INSERT, two entry points.
 */
export async function ideaAddForProject(args: IdeaAddArgs, projectIdForScope: string): Promise<IdeaRow> {
  const title = (args.title ?? '').trim();
  if (!title) throw new Error('idea title is required');
  if (title.length > 200) throw new Error('idea title exceeds 200 chars — put detail in the detail field');
  if (args.priority !== undefined && !IDEA_PRIORITIES.includes(args.priority)) throw new Error('invalid priority');
  const priority = args.priority ?? 'someday';
  const projectId = args.scope === 'global' ? null : projectIdForScope;
  const band: IdeaBand = { projectId, status: 'idea', priority };
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await lockIdeaBands(client, [band]);
    const sortOrder = await bandEdgeRankLocked(client, band, 'append');
    const r = await client.query<IdeaDbRow>(
      `INSERT INTO ideas (project_id, title, detail, priority, source, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${ideaRowProjection()}`,
      [projectId, title, args.detail ?? null, priority, args.source ?? 'agent-inferred', sortOrder],
    );
    await client.query('COMMIT');
    return toRow(r.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function ideasBoard(args?: {
  scope?: IdeaScope; includeClosed?: boolean; projectIdOverride?: string;
}): Promise<IdeaRow[]> {
  const scope = args?.scope ?? 'both';
  const projectId = args?.projectIdOverride ?? (await getProjectId());
  const db = getPool();
  const where: string[] = [];
  const params: (string | null)[] = [];
  if (scope === 'project') { params.push(projectId); where.push(`project_id = $${params.length}`); }
  else if (scope === 'global') { where.push(`project_id IS NULL`); }
  else { params.push(projectId); where.push(`(project_id = $${params.length} OR project_id IS NULL)`); }
  if (!args?.includeClosed) where.push(`status NOT IN ('shipped', 'dropped')`);
  const r = await db.query<IdeaDbRow>(
    `SELECT ${ideaRowProjection()} FROM ideas WHERE ${where.join(' AND ')}
     ORDER BY status, ${IDEA_PRIORITY_SQL},
       CASE WHEN project_id IS NULL THEN 1 ELSE 0 END,
       sort_order, created_at, id`,
    params
  );
  return r.rows.map(toRow);
}

export interface IdeasReadArgs {
  idea?: string;
  scope?: IdeaScope;
  includeClosed?: boolean;
  projectIdOverride?: string;
  budget?: ReadBudget;
}

function ideaDetailMarkdown(row: IdeaRow): string {
  return [
    '# Roadmap idea',
    '',
    `- ID: \`${row.id}\``,
    `- Title: ${row.title}`,
    `- Scope: ${row.project_id === null ? 'global' : 'project'}`,
    `- Status: ${row.status}`,
    `- Priority: ${row.priority}`,
    `- Source: ${row.source}`,
    `- Created: ${row.created_at}`,
    `- Updated: ${row.updated_at}`,
    '',
    '## Detail',
    '',
    row.detail ?? '_No detail recorded._',
    '',
    '## Evidence',
    '',
    row.evidence ?? '_No evidence recorded._',
  ].join('\n');
}

/** Read either the ordinary board or one exact, project-walled UUID. */
export async function ideasReadMarkdown(args: IdeasReadArgs = {}): Promise<string> {
  if (args.idea === undefined) {
    return ideasBoardMarkdown(args.scope ?? 'both', args.includeClosed === true, args.projectIdOverride);
  }
  const match = /^((?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})|(?:[0-9a-f]{8}))(?::([1-9]\d*))?$/i
    .exec(args.idea);
  if (!match) {
    throw new Error(`idea_id must be a UUID or 8-character prefix, optionally followed by :part, got: ${JSON.stringify(args.idea)}`);
  }
  if (args.scope !== undefined || args.includeClosed !== undefined) {
    throw new Error('idea_id is exclusive with scope and include_closed — it selects exactly one card');
  }
  const selector = match[1];
  const part = match[2] === undefined ? 1 : Number(match[2]);
  const projectId = args.projectIdOverride ?? (await getProjectId());
  const idPredicate = UUID_RE.test(selector) ? 'id = $1::uuid' : 'left(id::text, 8) = lower($1)';
  const result = await getPool().query<IdeaDbRow>(
    `SELECT ${ideaRowProjection()} FROM ideas
     WHERE ${idPredicate} AND (project_id = $2 OR project_id IS NULL)
     ORDER BY id LIMIT 2`,
    [selector, projectId],
  );
  if (!result.rows[0]) throw new Error(`roadmap idea \`${selector}\` not found in this project or the global board`);
  if (result.rows.length > 1) throw new Error(`roadmap idea prefix \`${selector}\` is ambiguous; use the full UUID`);
  const ideaId = result.rows[0].id;
  const complete = ideaDetailMarkdown(toRow(result.rows[0]));
  if (args.budget === undefined) {
    if (part > 1) throw new Error(`Idea part ${part} exceeds 1`);
    return complete;
  }
  return budgetPage(
    pageBudget(), `idea ${ideaId}`, complete, part, 'idea',
    (next) => `call mai_ideas with idea_id:"${ideaId}:${next}"`,
  ).text;
}

/** Agent move: evidence-required, whitelisted transitions only (spec R2). */
const AGENT_TRANSITIONS: Record<string, IdeaStatus> = { building: 'planned', shipped: 'building' }; // to → required-from

export async function ideaAgentMove(args: { ideaId: string; to: 'building' | 'shipped'; evidence: string }): Promise<IdeaRow> {
  if (!UUID_RE.test(args.ideaId)) throw new Error('idea_id must be a UUID (find it via mai_ideas)');
  const evidence = (args.evidence ?? '').trim();
  if (!evidence) throw new Error('evidence is required for agent moves — cite the plan/commit/decision');
  const requiredFrom = AGENT_TRANSITIONS[args.to];
  if (!requiredFrom) throw new Error(`agents may only move to building or shipped`);
  return runIdeaWriteWithRetry(async (client) => {
    const candidate = await client.query<IdeaOrderDbRow>(
      `SELECT id, project_id, status, priority, sort_order, created_at
       FROM ideas WHERE id = $1`,
      [args.ideaId],
    );
    const candidateRow = candidate.rows[0];
    if (!candidateRow || candidateRow.status !== requiredFrom) {
      throw new Error(`move rejected: idea not found or not in '${requiredFrom}' (agents may only move ${requiredFrom}→${args.to}; other moves are the operator's, via the dashboard)`);
    }
    const sourceBand: IdeaBand = {
      projectId: candidateRow.project_id,
      status: candidateRow.status,
      priority: candidateRow.priority,
    };
    const targetBand: IdeaBand = { ...sourceBand, status: args.to };
    await lockIdeaBands(client, [sourceBand, targetBand]);
    const locked = await client.query<IdeaOrderDbRow>(
      `SELECT id, project_id, status, priority, sort_order, created_at
       FROM ideas WHERE id = $1 FOR UPDATE`,
      [args.ideaId],
    );
    const lockedRow = locked.rows[0];
    if (!lockedRow || lockedRow.status !== requiredFrom) {
      if (lockedRow && !sameBandIdentity(candidateRow, lockedRow)) return IDENTITY_DRIFT;
      throw new Error(`move rejected: idea not found or not in '${requiredFrom}' (agents may only move ${requiredFrom}→${args.to}; other moves are the operator's, via the dashboard)`);
    }
    if (!sameBandIdentity(candidateRow, lockedRow)) return IDENTITY_DRIFT;
    const sortOrder = await bandEdgeRankLocked(client, targetBand, 'prepend', lockedRow.id);
    const r = await client.query<IdeaDbRow>(
      `UPDATE ideas SET status = $2::text,
          evidence = COALESCE(evidence || E'\\n', '') || $3,
          sort_order = $4,
          updated_at = NOW()
       WHERE id = $1 AND status = $5
       RETURNING ${ideaRowProjection()}`,
      [args.ideaId, args.to, evidence, sortOrder, requiredFrom],
    );
    if (r.rows.length === 0) return IDENTITY_DRIFT;
    return toRow(r.rows[0]);
  });
}

/** Operator move (web surface only — full transitions + priority + reorder). */
export async function ideaOperatorMove(args: {
  ideaId: string; status?: IdeaStatus; priority?: IdeaPriority; sortOrder?: number;
}): Promise<IdeaRow> {
  if (!UUID_RE.test(args.ideaId)) throw new Error('invalid idea id');
  if (args.status && !IDEA_STATUSES.includes(args.status)) throw new Error('invalid status');
  if (args.priority && !IDEA_PRIORITIES.includes(args.priority)) throw new Error('invalid priority');
  if (args.status === undefined && args.priority === undefined && args.sortOrder === undefined)
    throw new Error('nothing to change');
  return runIdeaWriteWithRetry(async (client) => {
    const candidate = await client.query<IdeaOrderDbRow>(
      `SELECT id, project_id, status, priority, sort_order, created_at
       FROM ideas WHERE id = $1`,
      [args.ideaId],
    );
    const candidateRow = candidate.rows[0];
    if (!candidateRow) throw new Error('idea not found');
    const sourceBand: IdeaBand = {
      projectId: candidateRow.project_id,
      status: candidateRow.status,
      priority: candidateRow.priority,
    };
    const requestedTargetBand: IdeaBand = {
      projectId: candidateRow.project_id,
      status: args.status ?? candidateRow.status,
      priority: args.priority ?? candidateRow.priority,
    };
    await lockIdeaBands(client, [sourceBand, requestedTargetBand]);
    const locked = await client.query<IdeaOrderDbRow>(
      `SELECT id, project_id, status, priority, sort_order, created_at
       FROM ideas WHERE id = $1 FOR UPDATE`,
      [args.ideaId],
    );
    const lockedRow = locked.rows[0];
    if (!lockedRow) throw new Error('idea not found');
    if (!sameBandIdentity(candidateRow, lockedRow)) return IDENTITY_DRIFT;
    const targetBand: IdeaBand = {
      projectId: lockedRow.project_id,
      status: args.status ?? lockedRow.status,
      priority: args.priority ?? lockedRow.priority,
    };
    const bandChanged = ideaBandKey(sourceBand) !== ideaBandKey(targetBand);
    const sortOrder = args.sortOrder ?? (
      bandChanged
        ? await bandEdgeRankLocked(client, targetBand, 'prepend', lockedRow.id)
        : Number(lockedRow.sort_order)
    );
    const r = await client.query<IdeaDbRow>(
      `UPDATE ideas SET
          status = $2::text,
          priority = $3::text,
          sort_order = $4,
          updated_at = NOW()
       WHERE id = $1
       RETURNING ${ideaRowProjection()}`,
      [args.ideaId, targetBand.status, targetBand.priority, sortOrder],
    );
    if (r.rows.length === 0) return IDENTITY_DRIFT;
    return toRow(r.rows[0]);
  });
}

/**
 * Operator edit (web surface only) — title/detail/priority + scope re-home.
 * Scope targets are the viewing project or the global board, never another
 * project (the wall stands). Status never changes here — that is move/reorder.
 * The WHERE guard is the reorder path's visibility rule: only a card on the
 * board the operator is viewing (their project's or the global board).
 */
export async function ideaOperatorUpdate(args: {
  ideaId: string;
  title?: string;
  detail?: string | null; // null clears (stored NULL); undefined = no change
  priority?: IdeaPriority;
  scope?: 'project' | 'global';
  projectId: string;
}): Promise<IdeaRow> {
  if (!UUID_RE.test(args.ideaId)) throw new Error('invalid idea id');
  let title: string | undefined;
  if (args.title !== undefined) {
    title = args.title.trim();
    if (!title) throw new Error('idea title is required');
    if (title.length > 200) throw new Error('idea title exceeds 200 chars — put detail in the detail field');
  }
  if (args.priority !== undefined && !IDEA_PRIORITIES.includes(args.priority))
    throw new Error('invalid priority');
  if (args.scope !== undefined && args.scope !== 'project' && args.scope !== 'global')
    throw new Error('invalid scope');
  if (title === undefined && args.detail === undefined && args.priority === undefined && args.scope === undefined)
    throw new Error('nothing to change');

  const setDetail = args.detail !== undefined;
  const detailValue = args.detail ?? null;
  return runIdeaWriteWithRetry(async (client) => {
    const candidate = await client.query<IdeaOrderDbRow>(
      `SELECT id, project_id, status, priority, sort_order, created_at
       FROM ideas
       WHERE id = $1 AND (project_id = $2::uuid OR project_id IS NULL)`,
      [args.ideaId, args.projectId],
    );
    const candidateRow = candidate.rows[0];
    if (!candidateRow) throw new Error('idea not found in the selected project scope');
    const sourceBand: IdeaBand = {
      projectId: candidateRow.project_id,
      status: candidateRow.status,
      priority: candidateRow.priority,
    };
    const requestedTargetBand: IdeaBand = {
      projectId: args.scope === undefined
        ? candidateRow.project_id
        : args.scope === 'global' ? null : args.projectId,
      status: candidateRow.status,
      priority: args.priority ?? candidateRow.priority,
    };
    await lockIdeaBands(client, [sourceBand, requestedTargetBand]);
    const locked = await client.query<IdeaOrderDbRow>(
      `SELECT id, project_id, status, priority, sort_order, created_at
       FROM ideas WHERE id = $1 FOR UPDATE`,
      [args.ideaId],
    );
    const lockedRow = locked.rows[0];
    if (!lockedRow) throw new Error('idea not found in the selected project scope');
    if (!sameBandIdentity(candidateRow, lockedRow)) return IDENTITY_DRIFT;
    if (lockedRow.project_id !== null && lockedRow.project_id !== args.projectId) {
      throw new Error('idea not found in the selected project scope');
    }
    const targetBand: IdeaBand = {
      projectId: args.scope === undefined
        ? lockedRow.project_id
        : args.scope === 'global' ? null : args.projectId,
      status: lockedRow.status,
      priority: args.priority ?? lockedRow.priority,
    };
    const bandChanged = ideaBandKey(sourceBand) !== ideaBandKey(targetBand);
    const sortOrder = bandChanged
      ? await bandEdgeRankLocked(client, targetBand, 'prepend', lockedRow.id)
      : Number(lockedRow.sort_order);
    const r = await client.query<IdeaDbRow>(
      `UPDATE ideas SET
          title = COALESCE($2::text, title),
          detail = CASE WHEN $3::boolean THEN $4::text ELSE detail END,
          priority = $5::text,
          project_id = $6::uuid,
          sort_order = $7,
          updated_at = NOW()
       WHERE id = $1
       RETURNING ${ideaRowProjection()}`,
      [
        args.ideaId,
        title ?? null,
        setDetail,
        detailValue,
        targetBand.priority,
        targetBand.projectId,
        sortOrder,
      ],
    );
    if (r.rows.length === 0) return IDENTITY_DRIFT;
    return toRow(r.rows[0]);
  });
}

/**
 * Operator reorder (web surface only). The browser sends the complete visible
 * target column; the transaction locks and validates that exact set before it
 * assigns fresh spaced ranks. This makes tied/exhausted fractional ranks
 * deterministic and rejects stale concurrent views instead of losing a move.
 */
export async function ideaOperatorReorder(args: {
  ideaId: string;
  status: IdeaStatus;
  scope: IdeaScope;
  includeClosed: boolean;
  expectedIds: string[];
  orderedIds: string[];
  projectId: string;
}): Promise<IdeaRow> {
  if (!UUID_RE.test(args.ideaId)) throw new Error('invalid idea id');
  if (!IDEA_STATUSES.includes(args.status)) throw new Error('invalid status');
  if (!IDEA_SCOPES.includes(args.scope)) throw new Error('invalid scope');
  if (args.orderedIds.length === 0 || args.orderedIds.length > 1000)
    throw new Error('ordered_ids must contain 1–1000 idea ids');
  if (args.expectedIds.length > 1000) throw new Error('expected_ids must contain at most 1000 idea ids');
  if (args.expectedIds.some((id) => !UUID_RE.test(id))) throw new Error('expected_ids must contain UUIDs');
  if (args.orderedIds.some((id) => !UUID_RE.test(id))) throw new Error('ordered_ids must contain UUIDs');
  if (new Set(args.expectedIds).size !== args.expectedIds.length)
    throw new Error('expected_ids must not contain duplicates');
  if (new Set(args.orderedIds).size !== args.orderedIds.length)
    throw new Error('ordered_ids must not contain duplicates');
  if (!args.orderedIds.includes(args.ideaId)) throw new Error('ordered_ids must include idea_id');

  const scopeSql = args.scope === 'project'
    ? 'project_id = $1::uuid'
    : args.scope === 'global'
      ? '(project_id IS NULL AND $1::uuid IS NOT NULL)'
      : '(project_id = $1::uuid OR project_id IS NULL)';
  return runIdeaWriteWithRetry(async (client) => {
    const candidate = await client.query<IdeaOrderDbRow>(
      `SELECT id, project_id, status, priority, sort_order, created_at
       FROM ideas
       WHERE id = $2::uuid AND (${scopeSql})
         AND ($3::boolean OR status NOT IN ('shipped', 'dropped'))`,
      [args.projectId, args.ideaId, args.includeClosed],
    );
    const candidateRow = candidate.rows[0];
    if (!candidateRow) throw new Error('idea not found in the selected project scope');
    const sourceBand: IdeaBand = {
      projectId: candidateRow.project_id,
      status: candidateRow.status,
      priority: candidateRow.priority,
    };
    const targetBand: IdeaBand = {
      projectId: candidateRow.project_id,
      status: args.status,
      priority: candidateRow.priority,
    };
    await lockIdeaBands(client, [sourceBand, targetBand]);
    const locked = await client.query<IdeaOrderDbRow>(
      `SELECT id, project_id, status, priority, sort_order, created_at
       FROM ideas
       WHERE id = $2::uuid AND (${scopeSql})
         AND ($3::boolean OR status NOT IN ('shipped', 'dropped'))
       FOR UPDATE`,
      [args.projectId, args.ideaId, args.includeClosed],
    );
    const lockedRow = locked.rows[0];
    if (!lockedRow) throw new Error('idea not found in the selected project scope');
    if (!sameBandIdentity(candidateRow, lockedRow)) return IDENTITY_DRIFT;

    await ideaBandTestHook?.('before-target-row-locks', {
      keys: [ideaBandKey(targetBand)],
      band: targetBand,
    });
    const target = await client.query<IdeaOrderDbRow>(
      `SELECT id, project_id, status, priority, sort_order, created_at
       FROM ideas
       WHERE project_id IS NOT DISTINCT FROM $1::uuid
         AND status = $2::text
         AND priority = $3::text
       ORDER BY id FOR UPDATE`,
      [lockedRow.project_id, args.status, lockedRow.priority],
    );
    const currentTargetIds = [...target.rows]
      .sort((a, b) =>
        Number(a.sort_order) - Number(b.sort_order) ||
        a.created_at.getTime() - b.created_at.getTime() ||
        a.id.localeCompare(b.id)
      )
      .map((row) => row.id);
    if (
      currentTargetIds.length !== args.expectedIds.length ||
      currentTargetIds.some((id, index) => id !== args.expectedIds[index])
    ) {
      throw new Error('board changed while moving the idea — reload and try again');
    }
    const actualIds = new Set(currentTargetIds);
    actualIds.add(lockedRow.id);
    if (
      actualIds.size !== args.orderedIds.length ||
      args.orderedIds.some((id) => !actualIds.has(id))
    ) {
      throw new Error('ordered_ids must exactly describe the target project priority band');
    }

    const updated = await client.query<IdeaDbRow>(
      `WITH desired AS (
         SELECT id, ordinality * 1000.0 AS sort_order
         FROM unnest($1::uuid[]) WITH ORDINALITY AS ordered(id, ordinality)
       )
       UPDATE ideas AS idea SET
         status = CASE WHEN idea.id = $2 THEN $3::text ELSE idea.status END,
         sort_order = desired.sort_order,
         updated_at = CASE
           WHEN idea.id = $2 OR idea.sort_order IS DISTINCT FROM desired.sort_order THEN NOW()
           ELSE idea.updated_at
         END
       FROM desired
       WHERE idea.id = desired.id
       RETURNING ${ideaRowProjection('idea')}`,
      [args.orderedIds, args.ideaId, args.status],
    );
    const moved = updated.rows.find((row) => row.id === args.ideaId);
    if (!moved) return IDENTITY_DRIFT;
    return toRow(moved);
  });
}

/** mai_ideas output — the board as markdown, grouped by status. */
export async function ideasBoardMarkdown(
  scope: IdeaScope = 'both', includeClosed = false, projectIdOverride?: string,
): Promise<string> {
  const rows = await ideasBoard({ scope, includeClosed, projectIdOverride });
  if (rows.length === 0) return 'Roadmap is empty — park ideas with mai_idea.';
  const lines: string[] = ['# Roadmap board', ''];
  for (const status of IDEA_STATUSES) {
    const col = rows.filter((r) => r.status === status);
    if (col.length === 0) continue;
    lines.push(`## ${status} (${col.length})`);
    for (const r of col) {
      const where = r.project_id === null ? 'global' : 'project';
      lines.push(`- \`${r.id}\` [${r.priority}·${where}] ${r.title}`);
      if (r.detail) lines.push(`  ${r.detail.split('\n')[0].slice(0, 160)}`);
    }
    lines.push('');
  }
  lines.push('_Park ideas with mai_idea. Evidence-backed moves (planned→building at plan start, building→shipped at completion) via mai_idea_move; curation is the operator\'s._');
  return lines.join('\n');
}

const IDEAS_NARROWING = 'use mai_ideas for the full roadmap';

/** Prime slice: in-flight (building) + committed-now items, project + global,
 * cap 6. `charBudget` is the prime envelope's 400-character ceiling (plan 38);
 * omitting it returns today's bytes exactly. */
export async function primeIdeasSection(
  projectId: string, charBudget?: number,
): Promise<string | null> {
  const db = getPool();
  const r = await db.query<IdeaDbRow>(
    `SELECT ${ideaRowProjection()} FROM ideas
     WHERE (project_id = $1 OR project_id IS NULL)
       AND (status = 'building' OR (status = 'planned' AND priority = 'now'))
     ORDER BY CASE status WHEN 'building' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END,
       ${IDEA_PRIORITY_SQL},
       CASE WHEN project_id IS NULL THEN 1 ELSE 0 END,
       sort_order, created_at, id
     LIMIT 6`,
    [projectId]
  );
  if (r.rows.length === 0) return null;
  const row = (i: IdeaDbRow): string =>
    `- [${i.status}${i.project_id === null ? '·global' : ''}] ${i.title} (\`${i.id}\`)`;
  const renderFull = (rows: readonly IdeaDbRow[]): string =>
    [`## Roadmap — in flight`, '', ...rows.map(row), '',
      `_Full board: mai_ideas. Ship it? mai_idea_move with evidence._`].join('\n');
  if (charBudget === undefined) return renderFull(r.rows);
  return budgetRows(
    { fullRows: r.rows.length, charBudget }, r.rows, renderFull,
    (i) => `- [${i.status}${i.project_id === null ? '·global' : ''}] ${headlineField(i.title, 120)}`,
    `## Roadmap — in flight`, 'idea', IDEAS_NARROWING,
  );
}
