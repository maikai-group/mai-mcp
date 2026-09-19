import { getPool, getProjectId } from './db.js';
import { enforceCharLimits } from './write-gate.js';

export type EdgeKind = 'decision' | 'lesson' | 'session' | 'topic' | 'commit';
export type EdgeRelation = 'relates_to' | 'caused_by' | 'fixed_by' | 'same_flaw_as' | 'implemented_by' | 'reverted_by';

const KIND_TABLE: Record<Exclude<EdgeKind, 'topic'>, string> = {
  decision: 'code_decisions',
  lesson: 'lessons',
  session: 'code_sessions',
  commit: 'code_commits',
};

/**
 * Verify a referenced row exists AND belongs to the pinned project (topics are
 * file-based — existence check arrives in Plan 2). Global lessons (project_id
 * IS NULL) are linkable from any project. Project-scoping here is what stops an
 * agent pinned to project A from linking to project B's rows.
 */
async function assertExists(kind: EdgeKind, id: string): Promise<void> {
  if (kind === 'topic') return;
  const table = KIND_TABLE[kind];
  const projectId = await getProjectId();
  // `table` is a closed Record of literal strings — never user input (no injection).
  const scope = kind === 'lesson' ? '(project_id = $2 OR project_id IS NULL)' : 'project_id = $2';
  const r = await getPool().query(`SELECT 1 FROM ${table} WHERE id = $1 AND ${scope}`, [id, projectId]);
  if (r.rows.length === 0) throw new Error(`${kind} ${id} not found in this project — cannot link.`);
}

/**
 * Create a typed link between two memories. Idempotent via the UNIQUE constraint —
 * a duplicate link returns the existing edge rather than erroring.
 */
export async function edgeAdd(args: {
  fromKind: EdgeKind;
  fromId: string;
  toKind: EdgeKind;
  toId: string;
  relation: EdgeRelation;
  note?: string;
}): Promise<string> {
  await enforceCharLimits({ fields: { note: args.note ?? '' }, toolName: 'mai_link' });
  await assertExists(args.fromKind, args.fromId);
  await assertExists(args.toKind, args.toId);
  const pool = getPool();
  const projectId = await getProjectId();
  const result = await pool.query<{ id: string }>(
    `INSERT INTO memory_edges (project_id, from_kind, from_id, to_kind, to_id, relation, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (from_kind, from_id, to_kind, to_id, relation)
     DO UPDATE SET note = COALESCE(EXCLUDED.note, memory_edges.note)
     RETURNING id`,
    [projectId, args.fromKind, args.fromId, args.toKind, args.toId, args.relation, args.note ?? null]
  );
  return `Linked ${args.fromKind} ${args.fromId.slice(0, 8)} —${args.relation}→ ${args.toKind} ${args.toId.slice(0, 8)} (edge ${result.rows[0].id.slice(0, 8)}).`;
}

/** Walk all edges touching a record (either direction), with linked-record summaries. */
export async function edgesOf(args: { kind: EdgeKind; id: string; projectId?: string }): Promise<string> {
  const pool = getPool();
  const projectId = args.projectId ?? (await getProjectId());
  const result = await pool.query<{
    relation: string; note: string | null; confidence: string;
    from_kind: string; from_id: string; to_kind: string; to_id: string;
  }>(
    `SELECT relation, note, confidence, from_kind, from_id, to_kind, to_id
     FROM memory_edges
     WHERE project_id = $1
       AND ((from_kind = $2 AND from_id = $3) OR (to_kind = $2 AND to_id = $3))
     ORDER BY created_at DESC
     LIMIT 50`,
    [projectId, args.kind, args.id]
  );
  // Implicit provenance: a decision extracted from (or written during) a session
  // carries session_id in its own row — surface it as a virtual edge so a
  // consumer can always trace a candidate back to its source session, even when
  // no explicit memory_edges link was ever created (Sol's B2 finding).
  const provenance: string[] = [];
  if (args.kind === 'decision') {
    const prov = await pool.query<{
      session_uuid: string; original_session_id: string | null; started_at: string | null; source: string;
    }>(
      `SELECT s.id AS session_uuid, s.original_session_id, s.started_at::text, d.source
       FROM code_decisions d JOIN code_sessions s ON s.id = d.session_id
       WHERE d.id = $1 AND d.project_id = $2`,
      [args.id, projectId]
    );
    if (prov.rows.length > 0) {
      const p = prov.rows[0];
      provenance.push(
        `- —extracted_from→ session ${p.session_uuid.slice(0, 8)} (original ${p.original_session_id ?? 'unknown'}, started ${p.started_at ?? 'unknown'}, decision source: ${p.source})`
      );
    }
  }

  if (result.rows.length === 0 && provenance.length === 0) {
    return `No edges for ${args.kind} ${args.id.slice(0, 8)}.`;
  }
  const lines = [`# Edges for ${args.kind} ${args.id.slice(0, 8)}`, ''];
  for (const e of result.rows) {
    const outgoing = e.from_kind === args.kind && e.from_id === args.id;
    const other = outgoing ? `${e.to_kind} ${e.to_id.slice(0, 8)}` : `${e.from_kind} ${e.from_id.slice(0, 8)}`;
    const arrow = outgoing ? `—${e.relation}→` : `←${e.relation}—`;
    lines.push(`- ${arrow} ${other} [${e.confidence}]${e.note ? ` — ${e.note}` : ''}`);
  }
  lines.push(...provenance);
  return lines.join('\n');
}
