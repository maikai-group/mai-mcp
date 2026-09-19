// Content-addressed bounded artifact store (conductor-machine-contract/2).
// The address IS sha256(utf8 bytes): any client computes it independently, so
// there is no cross-repo ID-derivation scheme to specify or drift. First
// consumers: frozen plan snapshots and delta-review evidence documents for the
// M-AI5 conductor (both UTF-8 text; binary content is out of contract /2).
// IMMUTABLE AND PERMANENT: no release/delete/tombstone operation exists —
// destructive authority stays out of the ungated tracker family. Retention is
// an operator concern (documented non-guarantee in the contract doc).
import { createHash } from 'node:crypto';
import { getPool, getProjectId } from './db.js';
import { agentIdentity, INSTANCE_SESSION } from './session-identity.js';

export const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const TOKEN_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export class ArtifactValidationError extends Error {}
export class ArtifactNotFoundError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function rejectUnknownKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new ArtifactValidationError(`unknown parameter: ${key}`);
  }
}

export interface ArtifactPutResult {
  ok: true; id: string; sha256: string; byteLength: number; duplicate: boolean;
}

export async function artifactPut(args: unknown): Promise<ArtifactPutResult> {
  if (!isRecord(args)) throw new ArtifactValidationError('arguments object required');
  rejectUnknownKeys(args, ['kind', 'content']);
  const kind = args.kind;
  const content = args.content;
  if (typeof kind !== 'string' || !TOKEN_PATTERN.test(kind)) {
    throw new ArtifactValidationError('kind must match ^[a-z][a-z0-9_-]{0,63}$');
  }
  if (typeof content !== 'string' || content.length === 0) {
    throw new ArtifactValidationError('content required (non-empty UTF-8 string)');
  }
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
    throw new ArtifactValidationError(`content exceeds ${MAX_ARTIFACT_BYTES} bytes`);
  }
  const sha = createHash('sha256').update(bytes).digest('hex');
  const pool = getPool();
  const projectId = await getProjectId();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO run_artifacts
       (project_id, kind, sha256, byte_length, content, created_by_agent, created_by_session)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT ON CONSTRAINT run_artifacts_identity DO NOTHING
     RETURNING id`,
    [projectId, kind, sha, bytes.byteLength, bytes, agentIdentity(), INSTANCE_SESSION]);
  if (rows.length > 0) {
    return { ok: true, id: rows[0].id, sha256: sha, byteLength: bytes.byteLength, duplicate: false };
  }
  // Same sha in this project = same content by construction (content-addressed).
  const { rows: existing } = await pool.query<{ id: string }>(
    'SELECT id FROM run_artifacts WHERE project_id = $1 AND sha256 = $2', [projectId, sha]);
  if (existing.length === 0) {
    // Storage fault, not a caller error: plain Error escapes the machine
    // envelope to the house isError path (pass-4 finding 8fd004ee).
    throw new Error(`artifact ${sha}: conflict row not readable (storage fault)`);
  }
  return { ok: true, id: existing[0].id, sha256: sha, byteLength: bytes.byteLength, duplicate: true };
}

export interface ArtifactGetResult {
  kind: string; sha256: string; byteLength: number; content: string;
}

export async function artifactGet(args: unknown): Promise<ArtifactGetResult> {
  if (!isRecord(args)) throw new ArtifactValidationError('arguments object required');
  rejectUnknownKeys(args, ['sha256']);
  if (typeof args.sha256 !== 'string' || !SHA256_PATTERN.test(args.sha256)) {
    throw new ArtifactValidationError('sha256 required (64 lowercase hex)');
  }
  const pool = getPool();
  const projectId = await getProjectId();
  const { rows } = await pool.query<{ kind: string; sha256: string; byte_length: number; content: Buffer }>(
    'SELECT kind, sha256, byte_length, content FROM run_artifacts WHERE project_id = $1 AND sha256 = $2',
    [projectId, args.sha256]);
  if (rows.length === 0) throw new ArtifactNotFoundError(`artifact not found: ${args.sha256}`);
  const row = rows[0];
  return {
    kind: row.kind, sha256: row.sha256, byteLength: row.byte_length,
    content: row.content.toString('utf8'),
  };
}
