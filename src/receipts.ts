// Append-only run-receipt ledger for external machine consumers
// (conductor-machine-contract/2). mai-mcp validates shape boundaries here,
// never consumer semantics: `kind` is a bounded consumer-owned token and the
// payload is the consumer's versioned document stored verbatim.
import { createHash } from 'node:crypto';
import { getPool, getProjectId } from './db.js';
import { agentIdentity, INSTANCE_SESSION } from './session-identity.js';

export const MAX_RECEIPT_PAYLOAD_BYTES = 256 * 1024;
export const RECEIPTS_PAGE_MAX = 200;
export const RECEIPTS_PAGE_DEFAULT = 100;
const TOKEN_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Microsecond-exact cursor timestamp: PostgreSQL renders it via to_char and
// parses it back via ::timestamptz — it NEVER passes through a JS Date, which
// truncates to milliseconds and would re-serve or skip boundary rows
// (pass-3 finding 60753c12).
const CURSOR_TS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
export const CURSOR_TS_SQL =
  `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export class ReceiptValidationError extends Error {}
/** Duplicate receipt_key whose stored payload differs — never a silent no-op. */
export class ReceiptConflictError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function boundedString(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}
function rejectUnknownKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new ReceiptValidationError(`unknown parameter: ${key}`);
  }
}

/** Cursors are stream-bound: a cursor minted for one plan/cycle/thread stream
 * is rejected on any other stream (pass-3 finding 60753c12). The tag includes
 * the PROJECT identity: cycle_id/thread keys are only unique per project, so a
 * tag without it would accept a foreign project's cursor and silently skip
 * rows (pass-4 finding 54292b93). Callers therefore resolve projectId BEFORE
 * minting or decoding any cursor. */
export function streamTag(kind: 'plan' | 'cycle' | 'thread', key: string, projectId: string): string {
  return createHash('sha256').update(`${projectId}:${kind}:${key}`, 'utf8').digest('hex').slice(0, 16);
}
export function encodeCursor(tag: string, ts: string, id: string): string {
  return Buffer.from(`${tag}/${ts}/${id}`, 'utf8').toString('base64url');
}
export function decodeCursor(cursor: unknown, expectedTag: string): { ts: string; id: string } {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 256) {
    throw new ReceiptValidationError('malformed cursor');
  }
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const parts = decoded.split('/');
  if (parts.length !== 3) throw new ReceiptValidationError('malformed cursor');
  const [tag, ts, id] = parts;
  if (!CURSOR_TS_PATTERN.test(ts) || !UUID_PATTERN.test(id)) {
    throw new ReceiptValidationError('malformed cursor');
  }
  if (tag !== expectedTag) {
    throw new ReceiptValidationError('cursor does not belong to this stream');
  }
  return { ts, id };
}

export interface ReceiptAddResult { ok: true; id: string; duplicate: boolean }

export async function receiptAdd(args: unknown): Promise<ReceiptAddResult> {
  if (!isRecord(args)) throw new ReceiptValidationError('arguments object required');
  rejectUnknownKeys(args, ['receipt']);
  if (!isRecord(args.receipt)) throw new ReceiptValidationError('receipt object required');
  const r = args.receipt;
  const receiptKey = r.receiptKey;
  const kind = r.kind;
  const cycleId = r.cycleId;
  const schemaVersion = r.schemaVersion;
  const planIdRaw = r.planId;
  const pass = r.pass;
  if (!boundedString(receiptKey, 256)) throw new ReceiptValidationError('receiptKey required (1-256 chars)');
  if (typeof kind !== 'string' || !TOKEN_PATTERN.test(kind)) {
    throw new ReceiptValidationError('kind must match ^[a-z][a-z0-9_-]{0,63}$');
  }
  if (!boundedString(cycleId, 128)) throw new ReceiptValidationError('cycleId required (1-128 chars)');
  if (!boundedString(schemaVersion, 64)) throw new ReceiptValidationError('schemaVersion required (1-64 chars)');
  if (!(pass === null || pass === undefined || (typeof pass === 'number' && Number.isInteger(pass) && pass >= 1))) {
    throw new ReceiptValidationError('pass must be null or a positive integer');
  }
  const pool = getPool();
  const projectId = await getProjectId();
  const json = JSON.stringify(r);
  if (Buffer.byteLength(json, 'utf8') > MAX_RECEIPT_PAYLOAD_BYTES) {
    throw new ReceiptValidationError(`receipt exceeds ${MAX_RECEIPT_PAYLOAD_BYTES} bytes`);
  }
  const payloadSha = createHash('sha256').update(json, 'utf8').digest('hex');
  // Idempotent replay is checked BEFORE any planId resolution: a byte-identical
  // replay must succeed as a no-op even when the referenced plan has since been
  // deleted (R1 promises the receipt survives plan deletion; resolving planId
  // first made replay throw after deletion — pass-7 finding 6d3e56fe). Loud
  // planId validation applies only to receipts that are actually NEW.
  const { rows: replay } = await pool.query<{ id: string; payload_sha256: string }>(
    'SELECT id, payload_sha256 FROM run_receipts WHERE project_id = $1 AND receipt_key = $2',
    [projectId, receiptKey]);
  if (replay.length > 0) {
    if (replay[0].payload_sha256 !== payloadSha) {
      throw new ReceiptConflictError(
        `receipt_key ${receiptKey}: stored payload differs (byte-conflict; append-only ledger refuses divergent replay)`);
    }
    return { ok: true, id: replay[0].id, duplicate: true };
  }
  // A PROVIDED planId must resolve: silent NULL made a typo indistinguishable
  // from intentional absence (pass-3 finding 279abc1c; spec failure-honesty).
  // Receipts WITHOUT a planId are legal (plan-less cycles) — omission means
  // the key is ABSENT. An explicit `planId: null` is a provided invalid value
  // (the schema declares a string) and is rejected (pass-4 finding 22ede192).
  // This block runs only for genuinely NEW receipts (see replay check above).
  let resolvedPlanId: string | null = null;
  if (planIdRaw !== undefined) {
    if (typeof planIdRaw !== 'string') throw new ReceiptValidationError('planId must be a string UUID (omit the key entirely for a plan-less receipt)');
    const planId = planIdRaw.toLowerCase();
    if (!UUID_PATTERN.test(planId)) throw new ReceiptValidationError(`planId is not a UUID: ${planIdRaw}`);
    const { rows: planRows } = await pool.query<{ id: string }>(
      'SELECT id FROM plans WHERE id = $1 AND project_id = $2', [planId, projectId]);
    if (planRows.length === 0) {
      throw new ReceiptValidationError(`planId not registered in this project: ${planId}`);
    }
    resolvedPlanId = planRows[0].id;
  }
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO run_receipts
       (project_id, plan_id, receipt_key, kind, cycle_id, pass, schema_version,
        payload, payload_sha256, created_by_agent, created_by_session)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT ON CONSTRAINT run_receipts_idempotency DO NOTHING
     RETURNING id`,
    [projectId, resolvedPlanId, receiptKey, kind, cycleId, pass ?? null,
     schemaVersion, json, payloadSha, agentIdentity(), INSTANCE_SESSION]);
  if (rows.length > 0) return { ok: true, id: rows[0].id, duplicate: false };
  const { rows: existing } = await pool.query<{ id: string; payload_sha256: string }>(
    'SELECT id, payload_sha256 FROM run_receipts WHERE project_id = $1 AND receipt_key = $2',
    [projectId, receiptKey]);
  if (existing.length === 0) {
    // Row vanished between insert and readback — append-only tables do not
    // delete, so this is a genuine STORAGE FAULT. Thrown as a plain Error so
    // it escapes the machine conflict/validation envelope and reaches the
    // house isError path, which consumers treat as retryable infrastructure
    // failure (pass-4 finding 8fd004ee).
    throw new Error(`receipt_key ${receiptKey}: conflict row not readable (storage fault)`);
  }
  if (existing[0].payload_sha256 !== payloadSha) {
    throw new ReceiptConflictError(
      `receipt_key ${receiptKey}: stored payload differs (byte-conflict; append-only ledger refuses divergent replay)`);
  }
  return { ok: true, id: existing[0].id, duplicate: true };
}

export interface ReceiptsPage { receipts: Record<string, unknown>[]; nextCursor: string | null }

/** Ledger read, oldest-first, keyset-paged — no silent truncation: when more
 * rows exist the page carries nextCursor; null means the ledger is complete. */
export async function receiptsQuery(args: unknown): Promise<ReceiptsPage> {
  if (!isRecord(args)) throw new ReceiptValidationError('arguments object required');
  rejectUnknownKeys(args, ['plan_id', 'cycle_id', 'cursor', 'limit']);
  const byPlan = boundedString(args.plan_id, 128);
  const byCycle = boundedString(args.cycle_id, 128);
  if (!byPlan && !byCycle) throw new ReceiptValidationError('plan_id or cycle_id required');
  const limitRaw = args.limit;
  let limit = RECEIPTS_PAGE_DEFAULT;
  if (limitRaw !== undefined) {
    if (typeof limitRaw !== 'number' || !Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > RECEIPTS_PAGE_MAX) {
      throw new ReceiptValidationError(`limit must be an integer 1-${RECEIPTS_PAGE_MAX}`);
    }
    limit = limitRaw;
  }
  // plan_id compares NATIVELY as uuid (`plan_id = $2::uuid`), never as
  // `plan_id::text = $2`: casting the COLUMN defeats the run_receipts_plan
  // btree's uuid equality prefix and degrades keyset paging to a scan
  // (pass-7 finding d85b027f). The parameter is validated as a UUID first so
  // the cast cannot throw on garbage input.
  let keyValue: string;
  if (byPlan) {
    keyValue = String(args.plan_id).toLowerCase();
    if (!UUID_PATTERN.test(keyValue)) throw new ReceiptValidationError('plan_id must be a UUID');
  } else {
    keyValue = String(args.cycle_id);
  }
  const pool = getPool();
  const projectId = await getProjectId();
  const tag = streamTag(byPlan ? 'plan' : 'cycle', keyValue, projectId);
  let after: { ts: string; id: string } | null = null;
  if (args.cursor !== undefined) after = decodeCursor(args.cursor, tag);
  const params: (string | number)[] = [projectId, keyValue];
  let where = byPlan
    ? `project_id = $1 AND plan_id = $2::uuid`
    : `project_id = $1 AND cycle_id = $2`;
  if (after !== null) {
    params.push(after.ts, after.id);
    where += ` AND (created_at, id) > ($3::timestamptz, $4::uuid)`;
  }
  params.push(limit + 1);
  const { rows } = await pool.query<{ id: string; cursor_ts: string; payload: Record<string, unknown> }>(
    `SELECT id, ${CURSOR_TS_SQL} AS cursor_ts, payload FROM run_receipts
     WHERE ${where} ORDER BY created_at, id LIMIT $${params.length}`, params);
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit && page.length > 0
    ? encodeCursor(tag, page[page.length - 1].cursor_ts, page[page.length - 1].id)
    : null;
  return { receipts: page.map((row) => row.payload), nextCursor };
}
