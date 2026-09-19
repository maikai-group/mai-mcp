// Code-review findings (plan 24, spec 2026-08-13 §8). Persistence is an
// OPERATOR/CLI concern — there is no MCP tool here, by decision aa0b6c0b: the
// registered surface has 10 chars of headroom and CRUD for a new table is not a
// capability worth spending it on. Recall rides the existing mai_findings.
import { getPool } from './db.js';
import { agentIdentity } from './session-identity.js';
import { recordFindingReferences } from './curation.js';

/** Body fields are capped high enough to be a sanity bound, never a content
 * limit (pass-1 N3): plan_findings caps them at nothing, and real code-review
 * evidence quoting a diff plus its surroundings routinely passes 4,000 chars.
 * A cap that truncates a reviewer's reasoning would make the NOT NULL columns
 * theater in the same way dropping evidence at format time did. */
export const CODE_FINDING_BODY_MAX = 16000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CODE_FINDING_SEVERITIES = ['blocker', 'warning', 'note'] as const;
export const CODE_FINDING_STATUSES = ['open', 'fixed', 'disputed', 'accepted-risk'] as const;

export type CodeFindingSeverity = (typeof CODE_FINDING_SEVERITIES)[number];
export type CodeFindingStatus = (typeof CODE_FINDING_STATUSES)[number];

/**
 * Distinct, documented exit codes so a caller never parses prose (R4).
 * PROJECT_MISMATCH is the REAL cross-project case, not a synonym for "unknown
 * slug" (pass-1 W2): spec §8.2.5 names project mismatch as its own failure, and
 * the mismatch worth distinguishing is the one where the UUID exists — under
 * someone else's project. NOT_FOUND means the id exists nowhere.
 */
export const EXIT = {
  OK: 0,
  VALIDATION: 2,
  NOT_FOUND: 3,
  PROJECT_MISMATCH: 4,
  DB: 5,
} as const;

/** Thrown with a code the CLI turns into process.exitCode. */
export class CodeFindingError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = 'CodeFindingError';
  }
}

export interface CodeFindingInput {
  base_sha: string;
  head_sha: string;
  severity: string;
  title: string;
  location: string;
  issue: string;
  evidence: string;
  fix: string;
  ref?: string;
  plan_id?: string;
}

function str(v: unknown, field: string, max = CODE_FINDING_BODY_MAX): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new CodeFindingError(EXIT.VALIDATION, `field '${field}' must be a non-empty string`);
  }
  if (v.length > max) {
    // Say what to DO. A reviewer subagent that reads only "max 16000" is most
    // likely to drop the finding; one told to trim and re-file keeps it.
    throw new CodeFindingError(
      EXIT.VALIDATION,
      `field '${field}' is ${v.length} chars; max ${max} — trim it and re-file, do not drop the finding`
    );
  }
  return v;
}

/** Parse and validate one finding. Never trusts the caller's JSON shape. */
export function parseFinding(raw: unknown): CodeFindingInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new CodeFindingError(EXIT.VALIDATION, 'expected a JSON object');
  }
  // NOT `...(raw as Record<string, unknown>)`: that is an as-assertion, R8 bans
  // them in new files, and Step 4's `check-no-casts.mjs src/code-findings.ts`
  // would fail on it — the plan's own gate, tripped by the plan's own code.
  // The guard above already narrowed `raw` to a non-null, non-array object, so
  // the spread needs no help. Verified: tsc --noEmit exit 0, gate clean.
  const o: Record<string, unknown> = { ...raw };
  const severity = str(o.severity, 'severity', 32);
  if (!CODE_FINDING_SEVERITIES.some((s) => s === severity)) {
    throw new CodeFindingError(
      EXIT.VALIDATION,
      `severity must be one of ${CODE_FINDING_SEVERITIES.join('|')}, got '${severity}'`
    );
  }
  const out: CodeFindingInput = {
    base_sha: str(o.base_sha, 'base_sha', 64),
    head_sha: str(o.head_sha, 'head_sha', 64),
    severity,
    title: str(o.title, 'title', 300),
    location: str(o.location, 'location', 300),
    issue: str(o.issue, 'issue'),
    evidence: str(o.evidence, 'evidence'),
    fix: str(o.fix, 'fix'),
  };
  if (o.ref !== undefined) out.ref = str(o.ref, 'ref', 64);
  if (o.plan_id !== undefined) {
    // Shape-checked HERE, not at the database (pass-1 W4): a non-UUID string
    // reaches Postgres as 22P02 and would exit 5 (DB failure) for what is
    // plainly a validation error, defeating R4's whole promise.
    const planId = str(o.plan_id, 'plan_id', 64);
    if (!UUID_RE.test(planId)) {
      throw new CodeFindingError(EXIT.VALIDATION, `plan_id must be a UUID, got '${planId}'`);
    }
    out.plan_id = planId;
  }
  return out;
}

/** Resolve a slug to its project id. Explicit slug ONLY — never inferred (R2). */
export async function resolveProject(slug: string): Promise<string> {
  if (!slug || !slug.trim()) {
    throw new CodeFindingError(EXIT.VALIDATION, '--project <slug> is required and is never inferred');
  }
  const r = await getPool().query<{ id: string }>(`SELECT id FROM projects WHERE slug = $1`, [slug]);
  if (r.rows.length === 0) {
    throw new CodeFindingError(EXIT.PROJECT_MISMATCH, `no project with slug '${slug}'`);
  }
  return r.rows[0].id;
}

export interface CodeFindingResult {
  id: string;
  status: CodeFindingStatus;
  severity?: string;
  title?: string;
}

/** Persist one finding. Attribution comes from the configured identity (R2),
 * and the vector is written here, at parity with reviewPost (ambiguity 6). */
export async function codeFindingAdd(slug: string, input: CodeFindingInput): Promise<CodeFindingResult> {
  const projectId = await resolveProject(slug);

  // A plan UUID from ANOTHER project passes the FK happily and produces a row
  // whose plan_id points somewhere its project_id cannot see — invisible in the
  // owning project (every read is project-scoped) and attached in this one to a
  // plan that does not exist here. Spec §8.2.1 requires the explicit slug
  // precisely so a cross-project write is impossible by accident; the database
  // cannot catch this, so the correlation check lives here (pass-1 W4).
  if (input.plan_id !== undefined) {
    const p = await getPool().query(
      `SELECT 1 FROM plans WHERE id = $1 AND project_id = $2`,
      [input.plan_id, projectId]
    );
    if (p.rowCount === 0) {
      throw new CodeFindingError(
        EXIT.PROJECT_MISMATCH,
        `plan ${input.plan_id} does not belong to project '${slug}'`
      );
    }
  }

  // Embedded on write, exactly as reviewPost does it (src/plans.ts:777-780):
  // the SAME passage shape `${title}. ${issue}`, and the RAW embed() rather
  // than embedQuery(), whose instruction prefix is retrieval-only (plan 14).
  // A rebuilt vector must score identically to a freshly-stored one. When the
  // provider is down embed() returns null, the row stores NULL/NULL, and Task 3
  // Step 7's rebuild pass backfills it — the same degradation plan findings have.
  const { embed, currentEmbeddingModelId } = await import('./embeddings.js');
  // embed() REJECTS on provider timeout — withTimeout at embeddings.ts:168-175
  // rejects rather than resolving null — so an unguarded call would both fail
  // the write and report it as exit 5, a database failure the database never
  // saw (pass-4 W4's sweep). A missing vector is an expected, recoverable state
  // in this design: ambiguity 6 stores NULL/NULL when no provider is
  // configured, and Task 3 Step 7's rebuild pass backfills it. A provider that
  // is merely slow must degrade to that same state, never lose the finding.
  let vec: number[] | null = null;
  try {
    vec = await embed(`${input.title}. ${input.issue}`);
  } catch {
    vec = null;
  }

  // The finding and its load-bearing citations share ONE transaction, exactly
  // as reviewPost does it (src/plans.ts:899, decision ba95ae4a, spec §2.3): a
  // finding whose citation counters never bumped is a finding that silently
  // stopped feeding curation, and plan 22's counters are what keep a cited
  // decision alive. Embedding happens BEFORE the transaction opens, so a slow
  // or hanging provider never holds a write lock — the same ordering reviewPost
  // uses at src/plans.ts:777-780.
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const r = await client.query<{ id: string; status: CodeFindingStatus }>(
      `INSERT INTO code_findings
         (project_id, plan_id, base_sha, head_sha, reviewer_agent, ref,
          severity, title, location, issue, evidence, fix, embedding, embedding_model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id, status`,
      [
        projectId, input.plan_id ?? null, input.base_sha, input.head_sha, agentIdentity(),
        input.ref ?? null, input.severity, input.title, input.location,
        input.issue, input.evidence, input.fix,
        vec, vec ? currentEmbeddingModelId() : null,
      ]
    );
    const row = r.rows[0];
    await recordFindingReferences(client, projectId, row.id, input.issue, input.evidence);
    await client.query('COMMIT');
    return { id: row.id, status: row.status, severity: input.severity, title: input.title };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Close a finding. Scoped by id AND project (R3) so a UUID from another project
 * closes nothing here — the project predicate is in the WHERE clause, not a
 * post-hoc check, so there is no window in which the wrong row is updated.
 */
export async function codeFindingClose(
  slug: string,
  findingId: string,
  status: string,
  note: string
): Promise<CodeFindingResult> {
  // Shape-check BEFORE the id reaches SQL (pass-5 W1). Without this a malformed
  // uuid raises 22P02 inside the UPDATE, which is not a CodeFindingError and so
  // exits 5 — database failure — for a plainly malformed argument. This is the
  // THIRD site of that species: pass-1 fixed it for plan_id, pass-4 for the
  // --file path, and the sweep both times stopped at the add path. The rule is
  // the whole rule: every caller-supplied value reaching SQL is shape-checked
  // where it enters, or R4's exit codes are only true for remembered paths.
  if (!UUID_RE.test(findingId)) {
    throw new CodeFindingError(EXIT.VALIDATION, `finding id must be a UUID, got '${findingId}'`);
  }
  const projectId = await resolveProject(slug);
  if (!CODE_FINDING_STATUSES.some((s) => s === status)) {
    throw new CodeFindingError(
      EXIT.VALIDATION,
      `status must be one of ${CODE_FINDING_STATUSES.join('|')}, got '${status}'`
    );
  }
  if (status !== 'open' && !note.trim()) {
    throw new CodeFindingError(EXIT.VALIDATION, `closing as '${status}' requires a note saying why`);
  }
  const r = await getPool().query<{ id: string; status: CodeFindingStatus; title: string }>(
    `UPDATE code_findings
        SET status = $3,
            resolution_note = CASE WHEN $3 = 'open' THEN NULL ELSE $4 END,
            resolved_at = CASE WHEN $3 = 'open' THEN NULL ELSE now() END,
            resolved_by_agent = CASE WHEN $3 = 'open' THEN NULL ELSE $5 END
      WHERE id = $1 AND project_id = $2
      RETURNING id, status, title`,
    [findingId, projectId, status, note.trim(), agentIdentity()]
  );
  if (r.rows.length === 0) {
    // Zero rows has TWO causes and R4 requires them apart (pass-1 W2). The
    // UPDATE above is still the only statement that can write, so this probe
    // changes nothing — it only explains a refusal that already happened.
    const elsewhere = await getPool().query<{ slug: string }>(
      `SELECT p.slug FROM code_findings f
         JOIN projects p ON p.id = f.project_id
        WHERE f.id = $1`,
      [findingId]
    );
    const owner = elsewhere.rows[0];
    if (owner) {
      throw new CodeFindingError(
        EXIT.PROJECT_MISMATCH,
        `finding ${findingId} belongs to project '${owner.slug}', not '${slug}' — nothing was changed`
      );
    }
    throw new CodeFindingError(EXIT.NOT_FOUND, `no finding ${findingId} in any project`);
  }
  return { id: r.rows[0].id, status: r.rows[0].status, title: r.rows[0].title };
}
