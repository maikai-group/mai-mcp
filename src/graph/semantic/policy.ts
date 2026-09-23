import { credentialConfigured } from '../../providers/runtime.js';
import { getPool } from '../../db.js';
import { object, integer, SemanticError } from './validation.js';
import type { CodePolicy, CodeProvider } from './types.js';

export function providerName(value: unknown): CodeProvider {
  if (value !== 'off' && value !== 'local' && value !== 'openai' && value !== 'voyage') {
    throw new SemanticError('Unknown code provider');
  }
  return value;
}
export function validCodePolicy(policy: CodePolicy): boolean {
  if (!Number.isSafeInteger(policy.revision) || policy.revision < 0) return false;
  if (policy.provider === 'off' || policy.provider === 'local') return policy.consentVersion === null;
  return (policy.provider === 'openai' || policy.provider === 'voyage')
    && policy.revision > 0 && policy.consentVersion === 'code-and-lessons/1';
}
export function decodePolicy(raw: unknown): CodePolicy {
  const row = object(raw, ['provider', 'revision', 'consent_version']);
  const provider = providerName(row.provider);
  const revision = integer(row.revision, 0, 2147483647);
  const consentVersion = row.consent_version === 'code-and-lessons/1' ? row.consent_version : null;
  const policy: CodePolicy = { provider, revision, consentVersion };
  if ((row.consent_version !== null && row.consent_version !== 'code-and-lessons/1') || !validCodePolicy(policy)) {
    throw new SemanticError('Invalid stored code provider policy', 409);
  }
  return policy;
}
export const DEFAULT_POLICY: CodePolicy = { provider: 'local', revision: 0, consentVersion: null };
export async function readPolicy(projectId: string): Promise<CodePolicy> {
  const rows = await getPool().query('SELECT provider,revision,consent_version FROM graph_code_policy WHERE project_id=$1', [projectId]);
  return rows.rows.length ? decodePolicy(rows.rows[0]) : { ...DEFAULT_POLICY };
}
export function providerConfigured(provider:CodeProvider):boolean {
  return (provider==='openai'||provider==='voyage')&&credentialConfigured(provider);
}
export interface PolicyChange { provider: CodeProvider; expectedRevision: number; acknowledgeCodeUpload?: boolean }
export function normalizePolicy(raw: unknown): PolicyChange {
  const data = object(raw, ['provider', 'expectedRevision', 'acknowledgeCodeUpload']);
  const provider = providerName(data.provider);
  const expectedRevision = integer(data.expectedRevision, 0, 2147483646);
  const cloud = provider === 'openai' || provider === 'voyage';
  if (cloud && data.acknowledgeCodeUpload !== true) throw new SemanticError('Explicit code and lesson upload acknowledgment required');
  if (!cloud && 'acknowledgeCodeUpload' in data) throw new SemanticError('Acknowledgment is only valid for a cloud provider');
  return cloud ? { provider, expectedRevision, acknowledgeCodeUpload: true } : { provider, expectedRevision };
}
export async function changePolicy(projectId: string, raw: unknown): Promise<CodePolicy> {
  const change = normalizePolicy(raw);
  const cloud = change.provider === 'openai' || change.provider === 'voyage';
  if (cloud && !providerConfigured(change.provider)) throw new SemanticError('Selected provider key is missing', 409);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const project = await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
    if (!project.rowCount) throw new SemanticError('Project not found', 404);
    const rows = await client.query('SELECT provider,revision,consent_version FROM graph_code_policy WHERE project_id=$1 FOR UPDATE', [projectId]);
    const previous = rows.rows.length ? decodePolicy(rows.rows[0]) : DEFAULT_POLICY;
    if (previous.revision !== change.expectedRevision) throw new SemanticError('Code provider policy changed; refresh and retry', 409);
    if (previous.provider === change.provider) { await client.query('COMMIT'); return previous; }
    const policy: CodePolicy = { provider: change.provider, revision: previous.revision + 1, consentVersion: cloud ? 'code-and-lessons/1' : null };
    await client.query(`INSERT INTO graph_code_policy(project_id,provider,revision,consent_version) VALUES($1,$2,$3,$4)
      ON CONFLICT(project_id) DO UPDATE SET provider=EXCLUDED.provider,revision=EXCLUDED.revision,
      consent_version=EXCLUDED.consent_version,updated_at=now()`, [projectId,policy.provider,policy.revision,policy.consentVersion]);
    await client.query("UPDATE graph_code_jobs SET cancel_requested=true WHERE project_id=$1 AND state='running'", [projectId]);
    await client.query('COMMIT');
    return policy;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
