import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import { getPool, getProjectId } from './db.js';
import { budgetSections, budgetText, headlineField, type ReadBudget, type ReadSection } from './read-budget.js';
import { agentIdentity, INSTANCE_SESSION } from './session-identity.js';

export const MY_TASKS_URL = 'http://127.0.0.1:6601/#/tasks';
export function myTasksPlanUrl(planId: string): string {
  return `${MY_TASKS_URL}?plan=${encodeURIComponent(planId)}`;
}

export type OperatorTaskKind = 'blocking' | 'follow_up';
export type OperatorTaskSource = 'plan' | 'ad_hoc';
export type OperatorTaskStatus = 'pending' | 'completed' | 'dismissed';

export interface OperatorChecklistItem {
  key: string;
  kind: OperatorTaskKind;
  title: string;
  instructions: string;
  sort_order: number;
}

export interface OperatorTaskSyncReceipt {
  plan_id: string;
  plan_path: string;
  plan_title: string | null;
  plan_sha: string | null;
  inserted: number;
  existing: number;
  blocking: number;
  follow_up: number;
  url: string;
}

export interface OperatorTaskRow {
  id: string;
  project_id: string;
  plan_id: string | null;
  task_key: string;
  source_kind: OperatorTaskSource;
  kind: OperatorTaskKind;
  title: string;
  instructions: string;
  assigned_by_agent: string;
  assigned_by_session: string;
  sort_order: number;
  status: OperatorTaskStatus;
  resolution_note: string | null;
  resolved_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  plan_title: string | null;
  plan_path: string | null;
  plan_status: string | null;
  plan_sha: string | null;
  plan_updated_at: Date | string | null;
}

export interface OperatorTaskGroup {
  group_key: string;
  group_kind: 'plan' | 'unlinked';
  plan_id: string | null;
  plan_title: string | null;
  plan_path: string | null;
  plan_status: string | null;
  plan_sha: string | null;
  pending_count: number;
  blocking_count: number;
  follow_up_count: number;
  removal_snapshot: string | null;
  tasks: OperatorTaskRow[];
}

export interface OperatorTaskList {
  pending_count: number;
  blocking_count: number;
  follow_up_count: number;
  rows: OperatorTaskRow[];
  groups: OperatorTaskGroup[];
}

export interface OperatorTaskMutationResult {
  task: OperatorTaskRow;
  pending_count: number;
  blocking_count: number;
  follow_up_count: number;
}

export interface OperatorTaskRemoveResult {
  removed_count: number;
}

export type OperatorTaskRemoveTarget =
  | { mode: 'tasks'; taskIds: readonly string[] }
  | { mode: 'group'; groupKey: string; snapshot: string };

export class OperatorTaskNotFoundError extends Error {}
export class OperatorTaskConflictError extends Error {}

type QueryClient = Pool | PoolClient;

interface PlanRecord {
  id: string;
  project_id: string;
  slug: string;
  path: string;
  title: string;
  current_sha: string | null;
  status: string;
}

interface StoredIdentity {
  id: string;
  content_hash: string;
  plan_id: string | null;
  sort_order: number;
  assigned_by_agent: string;
  assigned_by_session: string;
}

interface CountRow {
  pending_count: string;
  blocking_count: string;
  follow_up_count: string;
}

interface RemovalCandidate {
  id: string;
  status: OperatorTaskStatus;
  removed_at: Date | string | null;
  updated_at: Date | string;
}

const PLAN_KEY_RE = /^O[1-9][0-9]*$/;
const AD_HOC_KEY_RE = /^[A-Z][A-Z0-9_-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const TITLE_CONTROL_RE = /[\u0000-\u001f\u007f]/;
const INSTRUCTION_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function copyOwnFields(value: object, keys: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) result[key] = Reflect.get(value, key);
  return result;
}

function exactObject(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new Error(`${label} must be a plain object without symbol properties`);
  }
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) {
    throw new Error(`${label} must contain exactly: ${allowed.join(', ')}`);
  }
  return copyOwnFields(value, keys);
}

function optionalExactObject(
  value: unknown, required: readonly string[], optional: readonly string[], label: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new Error(`${label} must be a plain object without symbol properties`);
  }
  const keys = Object.keys(value);
  const allowed = [...required, ...optional];
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => !allowed.includes(key))) {
    throw new Error(`${label} has missing or unexpected fields`);
  }
  return copyOwnFields(value, keys);
}

function requiredString(record: Readonly<Record<string, unknown>>, key: string, max: number, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new Error(`${label}.${key} must be a non-blank string of at most ${max} characters`);
  }
  return value;
}

function normalizeItem(value: unknown, index: number, planSource: boolean): OperatorChecklistItem {
  const item = exactObject(value, ['key', 'kind', 'title', 'instructions'], `task ${index + 1}`);
  const key = requiredString(item, 'key', 64, `task ${index + 1}`);
  const kind = requiredString(item, 'kind', 9, `task ${index + 1}`);
  const title = requiredString(item, 'title', 300, `task ${index + 1}`);
  const instructions = requiredString(item, 'instructions', 4000, `task ${index + 1}`);
  const keyPattern = planSource ? PLAN_KEY_RE : AD_HOC_KEY_RE;
  if (!keyPattern.test(key)) throw new Error(`task ${index + 1}.key is invalid`);
  if (kind !== 'blocking' && kind !== 'follow-up') {
    throw new Error(`task ${index + 1}.kind must be blocking or follow-up`);
  }
  if (TITLE_CONTROL_RE.test(title)) throw new Error(`task ${index + 1}.title contains a control character`);
  if (INSTRUCTION_CONTROL_RE.test(instructions)) {
    throw new Error(`task ${index + 1}.instructions contains a forbidden control character`);
  }
  return {
    key,
    kind: kind === 'blocking' ? 'blocking' : 'follow_up',
    title,
    instructions,
    sort_order: index,
  };
}

export function parseOperatorChecklist(markdown: string): OperatorChecklistItem[] {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const headings: number[] = [];
  const matchingFences: number[] = [];
  let checklistHeadingLike = 0;
  let checklistFenceLike = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^ {0,3}##[ \t]+Operator Checklist(?:[ \t]+#+)?[ \t]*$/.test(line)) headings.push(index);
    if (/^[ \t]*#+[^\n]*Operator Checklist[^\n]*$/.test(line)) checklistHeadingLike += 1;
    if (/^[ \t]*(?:`{3,}|~{3,})[ \t]*operator-checklist(?:[ \t].*)?$/.test(line)) checklistFenceLike += 1;
    if (/^ {0,3}```operator-checklist[ \t]*$/.test(line)) matchingFences.push(index);
  }
  if (headings.length === 0) {
    if (checklistHeadingLike > 0 || checklistFenceLike > 0) throw new Error('malformed Operator Checklist syntax');
    return [];
  }
  if (checklistHeadingLike !== 1) throw new Error('plan must contain exactly one checklist-like Operator Checklist heading');
  if (checklistFenceLike !== 1) throw new Error('Operator Checklist must contain exactly one checklist-like fence');
  if (headings.length !== 1) throw new Error('plan must contain exactly one level-two Operator Checklist heading');
  if (matchingFences.length !== 1) throw new Error('Operator Checklist must contain exactly one operator-checklist fence');

  const heading = headings[0];
  let sectionEnd = lines.length;
  for (let index = heading + 1; index < lines.length; index += 1) {
    if (/^ {0,3}##(?:[ \t]+|$)/.test(lines[index])) { sectionEnd = index; break; }
  }
  const open = matchingFences[0];
  if (open <= heading || open >= sectionEnd) {
    throw new Error('operator-checklist fence must be inside the Operator Checklist section');
  }
  if (lines.slice(heading + 1, open).some((line) => line.trim().length > 0)) {
    throw new Error('Operator Checklist heading must be followed directly by its fence');
  }
  let close = -1;
  for (let index = open + 1; index < sectionEnd; index += 1) {
    if (/^ {0,3}```[ \t]*$/.test(lines[index])) { close = index; break; }
  }
  if (close < 0) throw new Error('operator-checklist fence is not closed');
  if (lines.slice(close + 1, sectionEnd).some((line) => line.trim().length > 0)) {
    throw new Error('Operator Checklist section contains trailing prose');
  }

  const body = lines.slice(open + 1, close).join('\n');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('operator-checklist body must be valid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('operator-checklist root must be an array');
  if (parsed.length < 1 || parsed.length > 100) throw new Error('operator-checklist must contain 1 to 100 tasks');
  const items = parsed.map((item, index) => normalizeItem(item, index, true));
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.key)) throw new Error(`duplicate operator checklist key '${item.key}'`);
    seen.add(item.key);
  }
  return items;
}

function contentHash(item: OperatorChecklistItem): string {
  const canonical = JSON.stringify({
    key: item.key,
    kind: item.kind,
    title: item.title,
    instructions: item.instructions,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

async function resolvePlanRecord(client: QueryClient, projectId: string, ref: string): Promise<PlanRecord> {
  const result = UUID_RE.test(ref)
    ? await client.query<PlanRecord>(
        `SELECT id, project_id, slug, path, title, current_sha, status
           FROM plans WHERE id = $1 AND project_id = $2`, [ref, projectId])
    : await client.query<PlanRecord>(
        `SELECT id, project_id, slug, path, title, current_sha, status
           FROM plans WHERE path = $1 AND project_id = $2`, [ref, projectId]);
  if (!result.rows[0]) throw new Error(`No registered plan matches '${ref}'. Register it first with mai_plan.`);
  return result.rows[0];
}

async function pendingCounts(client: QueryClient, projectId: string, planId?: string): Promise<CountRow> {
  const result = await client.query<CountRow>(
    `SELECT
       count(*) FILTER (WHERE status = 'pending')::text AS pending_count,
       count(*) FILTER (WHERE status = 'pending' AND kind = 'blocking')::text AS blocking_count,
       count(*) FILTER (WHERE status = 'pending' AND kind = 'follow_up')::text AS follow_up_count
       FROM operator_tasks
      WHERE project_id = $1 AND removed_at IS NULL
        AND ($2::uuid IS NULL OR plan_id = $2)`,
    [projectId, planId ?? null]
  );
  return result.rows[0];
}

function receiptText(receipt: OperatorTaskSyncReceipt): string {
  const label = receipt.plan_title ?? receipt.plan_path;
  const identity = ` for ${label}${receipt.plan_sha ? ` @ ${receipt.plan_sha.slice(0, 8)}` : ''}`;
  return `operator tasks${identity}: ${receipt.inserted} inserted, ${receipt.existing} existing; `
    + `${receipt.blocking} blocking, ${receipt.follow_up} follow-up — My Tasks: ${receipt.url}`;
}

function assignmentReceiptText(receipt: OperatorTaskSyncReceipt, groupIdentity: string): string {
  const revision = receipt.plan_sha ? ` @ ${receipt.plan_sha.slice(0, 8)}` : '';
  return `operator tasks for ${groupIdentity}${revision}: ${receipt.inserted} inserted, ${receipt.existing} existing; `
    + `${receipt.blocking} blocking, ${receipt.follow_up} follow-up — My Tasks: ${receipt.url}`;
}

async function syncWithClient(
  client: QueryClient, projectId: string, planRef: string, expectedSha: string | undefined,
): Promise<OperatorTaskSyncReceipt> {
  const plan = await resolvePlanRecord(client, projectId, planRef);
  if (plan.status !== 'approved' && plan.status !== 'executing') {
    throw new Error(`Plan '${plan.path}' must be approved or executing before operator-task sync.`);
  }
  const { resolvePlanPath } = await import('./plans.js');
  const absolute = await resolvePlanPath(projectId, plan.path);
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(absolute);
  } catch {
    throw new Error(`Cannot read plan file at '${plan.path}' (resolved: ${absolute}).`);
  }
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  if (!HASH_RE.test(sha) || (expectedSha !== undefined && expectedSha !== sha)) {
    throw new Error(`Plan SHA mismatch for '${plan.path}'.`);
  }
  if (plan.current_sha !== sha) throw new Error(`Registered plan SHA drift for '${plan.path}'.`);
  const review = await client.query<{ verdict: string; plan_sha: string | null }>(
    `SELECT verdict, plan_sha FROM plan_reviews WHERE plan_id = $1 ORDER BY pass DESC LIMIT 1`, [plan.id]
  );
  if (!review.rows[0] || review.rows[0].verdict !== 'approved' || review.rows[0].plan_sha !== sha) {
    throw new Error(`Plan '${plan.path}' has no latest approved review for its current SHA.`);
  }

  const items = parseOperatorChecklist(bytes.toString('utf8'));
  const assignedByAgent = agentIdentity();
  const assignedBySession = INSTANCE_SESSION;
  let inserted = 0;
  let existing = 0;
  for (const item of items) {
    const hash = contentHash(item);
    const created = await client.query<{ id: string }>(
      `INSERT INTO operator_tasks
         (project_id, plan_id, task_key, content_hash, source_kind, source_plan_slug,
          kind, title, instructions,
          assigned_by_agent, assigned_by_session, sort_order)
       VALUES ($1,$2,$3,$4,'plan',$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT DO NOTHING RETURNING id`,
      [projectId, plan.id, item.key, hash, plan.slug, item.kind, item.title, item.instructions,
        assignedByAgent, assignedBySession, item.sort_order]
    );
    const stored = await client.query<StoredIdentity>(
      `SELECT id, content_hash, plan_id, sort_order, assigned_by_agent, assigned_by_session
         FROM operator_tasks
        WHERE project_id = $1 AND source_plan_slug = $2 AND task_key = $3
          AND source_kind = 'plan'
        FOR UPDATE`,
      [projectId, plan.slug, item.key]
    );
    if (stored.rows[0]?.plan_id === null) {
      await client.query(
        `UPDATE operator_tasks SET plan_id = $1 WHERE id = $2 AND plan_id IS NULL`,
        [plan.id, stored.rows[0].id]
      );
      stored.rows[0].plan_id = plan.id;
    }
    if (!stored.rows[0] || stored.rows[0].plan_id !== plan.id || stored.rows[0].content_hash !== hash) {
      throw new Error(`Operator task identity collision for plan '${plan.path}' key '${item.key}'.`);
    }
    if (stored.rows[0].sort_order !== item.sort_order) {
      await client.query(
        `UPDATE operator_tasks SET sort_order = $1 WHERE id = $2 AND sort_order <> $1`,
        [item.sort_order, stored.rows[0].id]
      );
    }
    if (created.rowCount === 1) inserted += 1; else existing += 1;
  }
  const counts = await pendingCounts(client, projectId, plan.id);
  return {
    plan_id: plan.id,
    plan_path: plan.path,
    plan_title: plan.title,
    plan_sha: plan.current_sha,
    inserted,
    existing,
    blocking: Number(counts.blocking_count),
    follow_up: Number(counts.follow_up_count),
    url: myTasksPlanUrl(plan.id),
  };
}

export async function syncPlanOperatorTasks(args: {
  plan: string;
  expectedSha?: string;
  client?: PoolClient;
}): Promise<OperatorTaskSyncReceipt> {
  const projectId = await getProjectId();
  if (args.client) return syncWithClient(args.client, projectId, args.plan, args.expectedSha);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const receipt = await syncWithClient(client, projectId, args.plan, args.expectedSha);
    await client.query('COMMIT');
    return receipt;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function assignTasks(planPath: string | undefined, tasks: readonly OperatorChecklistItem[]): Promise<string> {
  const projectId = await getProjectId();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const plan = planPath === undefined ? undefined : await resolvePlanRecord(client, projectId, planPath);
    const assignedByAgent = agentIdentity();
    const assignedBySession = INSTANCE_SESSION;
    let inserted = 0;
    let existing = 0;
    for (const item of tasks) {
      const hash = contentHash(item);
      const created = await client.query<{ id: string }>(
        `INSERT INTO operator_tasks
           (project_id, plan_id, task_key, content_hash, source_kind, kind, title, instructions,
            assigned_by_agent, assigned_by_session, sort_order)
         VALUES ($1,$2,$3,$4,'ad_hoc',$5,$6,$7,$8,$9,$10)
         ON CONFLICT DO NOTHING RETURNING id`,
        [projectId, plan?.id ?? null, item.key, hash, item.kind, item.title, item.instructions,
          assignedByAgent, assignedBySession, item.sort_order]
      );
      const stored = await client.query<StoredIdentity>(
        `SELECT id, content_hash, plan_id, sort_order, assigned_by_agent, assigned_by_session
           FROM operator_tasks
          WHERE project_id = $1 AND assigned_by_session = $2 AND task_key = $3 AND source_kind = 'ad_hoc'`,
        [projectId, assignedBySession, item.key]
      );
      const row = stored.rows[0];
      if (!row || row.content_hash !== hash || row.plan_id !== (plan?.id ?? null)
          || row.sort_order !== item.sort_order) {
        throw new Error(`Operator task identity collision for ad-hoc key '${item.key}'.`);
      }
      if (created.rowCount === 1) inserted += 1; else existing += 1;
    }
    const counts = await pendingCounts(client, projectId, plan?.id);
    await client.query('COMMIT');
    return assignmentReceiptText({
      plan_id: plan?.id ?? '',
      plan_path: plan?.path ?? '',
      plan_title: plan?.title ?? null,
      plan_sha: plan?.current_sha ?? null,
      inserted,
      existing,
      blocking: Number(counts.blocking_count),
      follow_up: Number(counts.follow_up_count),
      url: plan ? myTasksPlanUrl(plan.id) : MY_TASKS_URL,
    }, plan ? `plan ${plan.title ?? plan.path} (${plan.id})` : `agent ${assignedByAgent}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function operatorTasksPost(input: unknown): Promise<string> {
  const base = optionalExactObject(input, ['mode'], ['plan_path', 'tasks'], 'mai_user_tasks_post input');
  const mode = base.mode;
  if (mode === 'sync-plan') {
    const exact = exactObject(input, ['mode', 'plan_path'], 'sync-plan input');
    const planPath = requiredString(exact, 'plan_path', 1000, 'sync-plan input');
    const receipt = await syncPlanOperatorTasks({ plan: planPath });
    return receiptText(receipt);
  }
  if (mode === 'assign') {
    const keys = Object.keys(base);
    if (keys.length !== 2 && keys.length !== 3) throw new Error('assign input has missing or unexpected fields');
    const rawTasks = base.tasks;
    if (!Array.isArray(rawTasks) || rawTasks.length < 1 || rawTasks.length > 50) {
      throw new Error('assign tasks must be an array containing 1 to 50 tasks');
    }
    const planValue = base.plan_path;
    if (planValue !== undefined && (typeof planValue !== 'string' || planValue.trim().length === 0 || planValue.length > 1000)) {
      throw new Error('assign plan_path must be a non-blank string of at most 1000 characters');
    }
    const tasks = rawTasks.map((item, index) => normalizeItem(item, index, false));
    const seen = new Set<string>();
    for (const task of tasks) {
      if (seen.has(task.key)) throw new Error(`duplicate ad-hoc task key '${task.key}'`);
      seen.add(task.key);
    }
    return assignTasks(typeof planValue === 'string' ? planValue : undefined, tasks);
  }
  throw new Error('mode must be sync-plan or assign');
}

function removalSnapshot(rows: readonly RemovalCandidate[]): string {
  const payload = [...rows]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((row) => `${row.id}:${new Date(row.updated_at).toISOString()}\n`)
    .join('');
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

async function removeOperatorTaskGroup(args: {
  projectId: string;
  target: Extract<OperatorTaskRemoveTarget, { mode: 'group' }>;
}): Promise<OperatorTaskRemoveResult> {
  const planMatch = /^plan:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
    .exec(args.target.groupKey);
  if ((args.target.groupKey !== 'unlinked' && !planMatch)
      || !/^[0-9a-f]{64}$/.test(args.target.snapshot)) {
    throw new OperatorTaskConflictError('Removal requires a valid group key and snapshot.');
  }
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const selected = args.target.groupKey === 'unlinked'
      ? await client.query<RemovalCandidate>(
          `SELECT id,status,removed_at,updated_at
             FROM operator_tasks
            WHERE project_id = $1 AND plan_id IS NULL
              AND removed_at IS NULL AND status IN ('completed','dismissed')
            ORDER BY id FOR UPDATE`,
          [args.projectId]
        )
      : await client.query<RemovalCandidate>(
          `SELECT id,status,removed_at,updated_at
             FROM operator_tasks
            WHERE project_id = $1 AND plan_id = $2
              AND removed_at IS NULL AND status IN ('completed','dismissed')
            ORDER BY id FOR UPDATE`,
          [args.projectId, planMatch?.[1] ?? null]
        );
    if (selected.rows.length === 0 || removalSnapshot(selected.rows) !== args.target.snapshot) {
      throw new OperatorTaskConflictError('Operator task group removal conflicted.');
    }
    const ids = selected.rows.map((row) => row.id);
    const removed = await client.query<{ id: string }>(
      `UPDATE operator_tasks
          SET removed_at = now(), updated_at = now()
        WHERE project_id = $1 AND id = ANY($2::uuid[])
          AND removed_at IS NULL AND status IN ('completed','dismissed')
        RETURNING id`,
      [args.projectId, ids]
    );
    if (removed.rowCount !== ids.length) {
      throw new OperatorTaskConflictError('Operator task group removal conflicted.');
    }
    await client.query('COMMIT');
    return { removed_count: ids.length };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function removeOperatorTasks(args: {
  projectId: string;
  target: OperatorTaskRemoveTarget;
}): Promise<OperatorTaskRemoveResult> {
  if (args.target.mode !== 'tasks') {
    return removeOperatorTaskGroup({ projectId: args.projectId, target: args.target });
  }
  const taskIds = args.target.taskIds.map((taskId) => taskId.trim());
  if (taskIds.length < 1 || taskIds.length > 100
      || taskIds.some((taskId) => !UUID_RE.test(taskId))
      || new Set(taskIds).size !== taskIds.length) {
    throw new OperatorTaskConflictError('Removal requires 1 to 100 unique task UUIDs.');
  }
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query<RemovalCandidate>(
      `SELECT id,status,removed_at,updated_at
         FROM operator_tasks
        WHERE project_id = $1 AND id = ANY($2::uuid[])
        ORDER BY id FOR UPDATE`,
      [args.projectId, taskIds],
    );
    if (selected.rows.length !== taskIds.length) {
      throw new OperatorTaskNotFoundError('Operator task not found.');
    }
    if (selected.rows.some((row) => row.removed_at !== null
        || (row.status !== 'completed' && row.status !== 'dismissed'))) {
      throw new OperatorTaskConflictError('Only visible terminal tasks can be removed.');
    }
    const removed = await client.query<{ id: string }>(
      `UPDATE operator_tasks
          SET removed_at = now(), updated_at = now()
        WHERE project_id = $1 AND id = ANY($2::uuid[])
          AND removed_at IS NULL AND status IN ('completed','dismissed')
        RETURNING id`,
      [args.projectId, taskIds],
    );
    if (removed.rowCount !== taskIds.length) {
      throw new OperatorTaskConflictError('Operator task removal conflicted.');
    }
    await client.query('COMMIT');
    return { removed_count: taskIds.length };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function taskColumns(alias: string): string {
  return `${alias}.id, ${alias}.project_id, ${alias}.plan_id, ${alias}.task_key,
    ${alias}.source_kind, ${alias}.kind, ${alias}.title, ${alias}.instructions,
    ${alias}.assigned_by_agent, ${alias}.assigned_by_session, ${alias}.sort_order,
    ${alias}.status, ${alias}.resolution_note, ${alias}.resolved_at,
    ${alias}.created_at, ${alias}.updated_at,
    p.title AS plan_title, p.path AS plan_path, p.status AS plan_status,
    p.current_sha AS plan_sha,
    p.updated_at AS plan_updated_at`;
}

export async function listOperatorTasks(args: {
  projectId: string;
  includeHistory: boolean;
  summaryOnly: boolean;
  planId?: string;
}): Promise<OperatorTaskList> {
  const counts = await pendingCounts(getPool(), args.projectId, args.planId);
  if (args.summaryOnly) {
    return {
      pending_count: Number(counts.pending_count),
      blocking_count: Number(counts.blocking_count),
      follow_up_count: Number(counts.follow_up_count),
      rows: [],
      groups: [],
    };
  }
  const rows = await getPool().query<OperatorTaskRow>(
    `SELECT ${taskColumns('ot')}
       FROM operator_tasks ot LEFT JOIN plans p ON p.id = ot.plan_id
      WHERE ot.project_id = $1
        AND ($2::uuid IS NULL OR ot.plan_id = $2)
        AND ot.removed_at IS NULL
        AND ($3::boolean OR ot.status = 'pending')
      ORDER BY CASE WHEN ot.plan_id IS NOT NULL THEN 0 ELSE 1 END,
        p.updated_at DESC NULLS LAST, p.id ASC NULLS LAST,
        CASE WHEN ot.status = 'pending' THEN 0 ELSE 1 END,
        CASE WHEN ot.status = 'pending' AND ot.kind = 'blocking' THEN 0
             WHEN ot.status = 'pending' THEN 1 ELSE 2 END,
        CASE WHEN ot.status = 'pending' THEN ot.sort_order END ASC NULLS LAST,
        CASE WHEN ot.status <> 'pending' THEN ot.resolved_at END DESC NULLS LAST,
        ot.sort_order ASC, ot.created_at ASC, ot.id ASC`,
    [args.projectId, args.planId ?? null, args.includeHistory]
  );
  const groups: OperatorTaskGroup[] = [];
  const byKey = new Map<string, OperatorTaskGroup>();
  for (const row of rows.rows) {
    const groupKey = row.plan_id === null ? 'unlinked' : `plan:${row.plan_id}`;
    let group = byKey.get(groupKey);
    if (!group) {
      group = {
        group_key: groupKey,
        group_kind: row.plan_id === null ? 'unlinked' : 'plan',
        plan_id: row.plan_id,
        plan_title: row.plan_title,
        plan_path: row.plan_path,
        plan_status: row.plan_status,
        plan_sha: row.plan_sha,
        pending_count: 0,
        blocking_count: 0,
        follow_up_count: 0,
        removal_snapshot: null,
        tasks: [],
      };
      byKey.set(groupKey, group);
      groups.push(group);
    }
    group.tasks.push(row);
    if (row.status === 'pending') {
      group.pending_count += 1;
      if (row.kind === 'blocking') group.blocking_count += 1;
      else group.follow_up_count += 1;
    }
  }
  for (const group of groups) {
    const terminal = group.tasks.filter((task) => task.status !== 'pending').map((task) => ({
      id: task.id,
      status: task.status,
      removed_at: null,
      updated_at: task.updated_at,
    }));
    group.removal_snapshot = terminal.length === 0 ? null : removalSnapshot(terminal);
  }
  return {
    pending_count: Number(counts.pending_count),
    blocking_count: Number(counts.blocking_count),
    follow_up_count: Number(counts.follow_up_count),
    rows: rows.rows,
    groups,
  };
}

function markdownEscape(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|>])/g, '\\$1');
}

export async function operatorTasksText(input: unknown, budget?: ReadBudget): Promise<string> {
  const record = optionalExactObject(input, [], ['plan_path', 'history', 'detail'], 'mai_user_tasks input');
  const planValue = record.plan_path;
  const historyValue = record.history;
  const detailValue = record.detail;
  if (planValue !== undefined && (typeof planValue !== 'string' || planValue.trim().length === 0 || planValue.length > 1000)) {
    throw new Error('plan_path must be a non-blank string of at most 1000 characters');
  }
  if (historyValue !== undefined && typeof historyValue !== 'boolean') throw new Error('history must be boolean');
  if (detailValue !== undefined && detailValue !== 'summary' && detailValue !== 'full') {
    throw new Error('detail must be summary or full');
  }
  const projectId = await getProjectId();
  const plan = typeof planValue === 'string' ? await resolvePlanRecord(getPool(), projectId, planValue) : undefined;
  const full = detailValue === 'full';
  const listed = await listOperatorTasks({
    projectId,
    includeHistory: historyValue === true,
    summaryOnly: false,
    planId: plan?.id,
  });
  const heading = `operator tasks: pending=${listed.pending_count}, blocking=${listed.blocking_count}, `
    + `follow-up=${listed.follow_up_count} — My Tasks: ${plan ? myTasksPlanUrl(plan.id) : MY_TASKS_URL}`;
  const narrowing = 'call mai_user_tasks with one plan_path, history:false, or detail:"summary"';
  if (!full) {
    const groupHeadings = listed.groups.map((group) => group.group_kind === 'plan'
      ? `- plan ${group.plan_title ?? group.plan_path ?? group.group_key}`
        + `${group.plan_sha ? ` @ ${group.plan_sha.slice(0, 8)}` : ''}`
        + ` — ${group.blocking_count} blocking, ${group.follow_up_count} follow-up — `
        + (group.plan_id ? myTasksPlanUrl(group.plan_id) : MY_TASKS_URL)
      : '- unlinked tasks');
    const summary = groupHeadings.length === 0 ? heading : `${heading}\n${groupHeadings.join('\n')}`;
    return budgetText(budget, summary, narrowing);
  }
  const sections: ReadSection[] = listed.groups.map((group) => ({
    heading: group.group_kind === 'plan'
      ? `\n## ${markdownEscape(group.plan_title ?? group.plan_path ?? group.group_key)}`
        + `${group.plan_sha ? ` @ ${group.plan_sha.slice(0, 8)}` : ''}`
      : '\n## Unlinked tasks',
    fullRows: group.tasks.map((task) =>
      `- [${task.status === 'pending' ? ' ' : 'x'}] **${markdownEscape(task.title)}** `
      + `(${task.kind === 'follow_up' ? 'follow-up' : 'blocking'}, ${task.source_kind})\n  `
      + markdownEscape(task.instructions).replace(/\n/g, '\n  ')),
    headlineRows: group.tasks.map((task) =>
      `- ${task.status}/${task.kind}: ${headlineField(markdownEscape(task.title), 180)}`),
  }));
  if (sections.length === 0) return budgetText(budget, heading, narrowing);
  if (budget === undefined) {
    return `${heading}\n${budgetSections(undefined, sections, 'operator task', narrowing)}`;
  }
  const separator = '\n';
  const bodyBudget: ReadBudget = {
    fullRows: budget.fullRows,
    charBudget: budget.charBudget - heading.length - separator.length,
  };
  const minimumFallback = `_Task details omitted; ${narrowing}._`;
  if (bodyBudget.charBudget < minimumFallback.length) return budgetText(budget, heading, narrowing);
  const body = budgetSections(bodyBudget, sections, 'operator task', narrowing, minimumFallback);
  const composed = `${heading}${separator}${body}`;
  if (composed.length > budget.charBudget) throw new Error('operator-task response exceeds read budget');
  return composed;
}

function mutationSql(action: 'complete' | 'reopen' | 'dismiss'): string {
  const transition = action === 'complete'
    ? `status = 'completed', resolution_note = NULL, resolved_at = now()`
    : action === 'reopen'
      ? `status = 'pending', resolution_note = NULL, resolved_at = NULL`
      : `status = 'dismissed', resolution_note = $3, resolved_at = now()`;
  const guard = action === 'reopen' ? `status IN ('completed','dismissed')` : `status = 'pending'`;
  return `WITH updated AS (
    UPDATE operator_tasks SET ${transition}, updated_at = now()
     WHERE id = $1 AND project_id = $2 AND removed_at IS NULL AND ${guard}
     RETURNING id, project_id, plan_id, task_key, source_kind, kind, title, instructions,
       assigned_by_agent, assigned_by_session, sort_order, status, resolution_note,
       resolved_at, created_at, updated_at
  )
  SELECT ${taskColumns('updated')} FROM updated LEFT JOIN plans p ON p.id = updated.plan_id`;
}

export async function operatorTaskStatus(args: {
  projectId: string;
  taskId: string;
  action: 'complete' | 'reopen' | 'dismiss';
  reason?: string;
}): Promise<OperatorTaskMutationResult> {
  const reason = args.reason?.trim();
  if (args.action === 'dismiss' && !reason) throw new OperatorTaskConflictError('Dismiss requires a reason.');
  const params = args.action === 'dismiss'
    ? [args.taskId, args.projectId, reason ?? null]
    : [args.taskId, args.projectId];
  const updated = await getPool().query<OperatorTaskRow>(mutationSql(args.action), params);
  const task = updated.rows[0];
  if (!task) {
    const exists = await getPool().query<{ status: OperatorTaskStatus; removed_at: Date | string | null }>(
      `SELECT status,removed_at FROM operator_tasks WHERE id = $1 AND project_id = $2`,
      [args.taskId, args.projectId]
    );
    if (!exists.rows[0]) throw new OperatorTaskNotFoundError('Operator task not found.');
    if (exists.rows[0].removed_at !== null) {
      throw new OperatorTaskConflictError('Removed operator task cannot be changed.');
    }
    throw new OperatorTaskConflictError(`Task cannot ${args.action} from status ${exists.rows[0].status}.`);
  }
  const counts = await pendingCounts(getPool(), args.projectId);
  return {
    task,
    pending_count: Number(counts.pending_count),
    blocking_count: Number(counts.blocking_count),
    follow_up_count: Number(counts.follow_up_count),
  };
}
