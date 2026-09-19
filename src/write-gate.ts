// Origin: forked from the Mai Group's predecessor memory server (private).
import { getPool, getProjectId } from './db.js';
import { bumpSurfaced, type CuratedKind, type CitationRelation } from './curation.js';

/**
 * What `verifyCatA` VALIDATED — returned instead of discarded (plan 22, spec
 * §2.2). The gate still only validates; the CALLER persists it inside the same
 * transaction as the citing INSERT, so a rejected or failed write can never
 * manufacture a load-bearing signal (spec §2.3, plan 22 ambiguity 1).
 */
export interface ValidatedCitation {
  citedKind: CuratedKind;
  citedId: string;
  relation: CitationRelation;
  reason: string;
  sessionTokenId: string;
}

/**
 * Per-MCP-process session ID. Set once at server startup; immutable for the
 * server's lifetime. When the server dies and respawns, a new ID is minted.
 * This IS the "session" for token-gate purposes.
 */
const SESSION_PID = process.pid;
const SESSION_STARTED_AT = new Date();

/**
 * One memoized DB row id for this server's session token. Lazy-initialized
 * on first call to ensureSessionToken().
 */
let _sessionTokenId: string | null = null;

/**
 * Per-tool result-set keys. Reads write into these buckets; writes validate
 * citation IDs against the matching bucket. ('notes' is the Cat C logging
 * bucket — Plan 2's mai_note/mai_progress; it mints no preview.)
 */
export type ResultBucket = 'lessons' | 'decisions' | 'notes';

/**
 * Categories of write tools — used for selecting the right gate logic.
 */
export type WriteCategory =
  | 'A_add_new'         // requires search-token + structured citation
  | 'C_append_file';    // requires structured trigger evidence

/**
 * Citation kinds for Cat A writes.
 */
export type CitationKind =
  | { kind: 'supersedes'; supersedes_id: string; reason: string }
  | { kind: 'extends'; extends_id: string; how: string }
  | { kind: 'novel'; justification: string };

export const FIELD_CHAR_LIMIT = 1000;
export const NOVEL_JUSTIFICATION_MIN = 50;

/**
 * Ensure the per-process session token row exists in the DB. Idempotent.
 * Called by every read/write entry point. Returns the token UUID.
 */
export async function ensureSessionToken(): Promise<string> {
  if (_sessionTokenId) return _sessionTokenId;
  const pool = getPool();
  const projectId = await getProjectId();
  const result = await pool.query<{ id: string }>(
    `INSERT INTO write_session_tokens (project_id, session_pid, session_started_at)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [projectId, SESSION_PID, SESSION_STARTED_AT]
  );
  _sessionTokenId = result.rows[0].id;
  return _sessionTokenId;
}

/**
 * Record that a read tool returned these IDs. Adds them to the bucket so future
 * citations can be validated.
 */
export async function recordReadResults(bucket: ResultBucket, ids: string[]): Promise<void> {
  const tokenId = await ensureSessionToken();
  const pool = getPool();
  // Surfaced tier (plan 22, spec §2.1): THIS function is the single choke point
  // every present and future read verb already funnels through, so one extra
  // bulk statement here covers them all by construction — nothing new has to be
  // threaded through any read path, now or later.
  await bumpSurfaced(bucket, ids);
  if (ids.length === 0) {
    // Zero-hit search still counts as having searched — novel-citation
    // credibility (verifyCatA novel branch) keys off reads_count.
    await pool.query(
      `UPDATE write_session_tokens
       SET reads_count = reads_count + 1, last_activity_at = NOW()
       WHERE id = $1`,
      [tokenId]
    );
    return;
  }
  await pool.query(
    `UPDATE write_session_tokens
     SET result_set_ids = jsonb_set(
           result_set_ids,
           ARRAY[$2::text],
           COALESCE(result_set_ids -> $2, '[]'::jsonb)
             || (
               SELECT jsonb_agg(DISTINCT i) FROM jsonb_array_elements_text(
                 COALESCE(result_set_ids -> $2, '[]'::jsonb) || $3::jsonb
               ) AS t(i)
             ),
           true
         ),
         reads_count = reads_count + 1,
         last_activity_at = NOW()
     WHERE id = $1`,
    [tokenId, bucket, JSON.stringify(ids)]
  );
}

/**
 * Verify Cat A precondition: a search happened this session AND citation references
 * a valid result-set ID (or claims novel with justification ≥ minimum AND a prior
 * search this session).
 *
 * Throws WriteGateError on failure with the rejection details + populated preview.
 */
export async function verifyCatA(args: {
  bucket: ResultBucket;
  citation: CitationKind | undefined;
  payloadFingerprint: string;
  toolName: string;
}): Promise<ValidatedCitation | null> {
  if (!args.citation) {
    await logViolationAndThrow({
      toolName: args.toolName,
      kind: 'missing_citation',
      payload: args.payloadFingerprint,
      bucket: args.bucket,
      message:
        `Write rejected: Cat A writes require a structured citation. Pass one of:\n` +
        `  { kind: "supersedes", supersedes_id: <id>, reason: "..." }\n` +
        `  { kind: "extends", extends_id: <id>, how: "..." }\n` +
        `  { kind: "novel", justification: "..." }  (≥${NOVEL_JUSTIFICATION_MIN} chars)`,
    });
    return null;
  }

  if (args.citation.kind === 'novel') {
    if (!args.citation.justification || args.citation.justification.trim().length < NOVEL_JUSTIFICATION_MIN) {
      await logViolationAndThrow({
        toolName: args.toolName,
        kind: 'novel_justification_too_short',
        payload: args.payloadFingerprint,
        bucket: args.bucket,
        message:
          `Write rejected: novel citation's justification is ${args.citation.justification?.length ?? 0} chars; ` +
          `minimum is ${NOVEL_JUSTIFICATION_MIN}. The field is citation.justification (a string nested in the ` +
          `citation object) — explain why no related entry exists.`,
      });
      return null;
    }
    // Novel claims still require a search this session — "I looked and found
    // nothing" is only credible if you looked. (Closes the predecessor's novel-bypass gap.)
    const tokenIdNovel = await ensureSessionToken();
    const tokenRowNovel = await getPool().query<{ result_set_ids: Record<string, string[]>; reads_count: number }>(
      `SELECT result_set_ids, reads_count FROM write_session_tokens WHERE id = $1`,
      [tokenIdNovel]
    );
    const bucketReads = (tokenRowNovel.rows[0]?.result_set_ids?.[args.bucket] ?? []) as string[];
    const readsCount = tokenRowNovel.rows[0]?.reads_count ?? 0;
    if (readsCount === 0 && bucketReads.length === 0) {
      await logViolationAndThrow({
        toolName: args.toolName,
        kind: 'no_search_token',
        payload: args.payloadFingerprint,
        bucket: args.bucket,
        message:
          `Write rejected: novel citations require a prior search this session. ` +
          `Run mai_search with a relevant query first — if nothing related comes back, ` +
          `your novel justification is then credible.`,
      });
      return null;
    }
    return null;
  }

  if (args.citation.kind !== 'supersedes' && args.citation.kind !== 'extends') {
    await logViolationAndThrow({
      toolName: args.toolName,
      kind: 'unknown_kind',
      payload: args.payloadFingerprint,
      bucket: args.bucket,
      message:
        `Write rejected: citation.kind must be "supersedes", "extends", or "novel". ` +
        `Got: ${JSON.stringify((args.citation as { kind?: unknown }).kind)}.`,
    });
    return null;
  }

  const citedId =
    args.citation.kind === 'supersedes'
      ? args.citation.supersedes_id
      : args.citation.extends_id;

  if (!citedId || !citedId.trim()) {
    await logViolationAndThrow({
      toolName: args.toolName,
      kind: 'invalid_citation',
      payload: args.payloadFingerprint,
      bucket: args.bucket,
      message: `Write rejected: ${args.citation.kind} citation requires a non-empty ID.`,
    });
    return null;
  }

  const tokenId = await ensureSessionToken();
  const pool = getPool();
  const tokenRow = await pool.query<{ result_set_ids: Record<string, string[]> }>(
    `SELECT result_set_ids FROM write_session_tokens WHERE id = $1`,
    [tokenId]
  );
  const bucketIds = (tokenRow.rows[0]?.result_set_ids?.[args.bucket] ?? []) as string[];
  if (!bucketIds.includes(citedId)) {
    await logViolationAndThrow({
      toolName: args.toolName,
      kind: 'invalid_citation',
      payload: args.payloadFingerprint,
      bucket: args.bucket,
      message:
        `Write rejected: cited ID '${citedId}' was not returned by any search ` +
        `in this session. Either you didn't search, or the ID is wrong. ` +
        `Re-run mai_search with a relevant query and cite a returned ID.`,
    });
    return null;
  }

  await ensureSessionToken();
  // Validated — hand the caller what it needs to PERSIST the citation (plan 22
  // ambiguity 1). The gate itself deliberately writes no citation row: it has
  // no transaction to join, and threading a client through the rejection path
  // would be a refactor of the write-gate (iron rule 3). Every rejection branch
  // above is byte-for-byte unchanged.
  if (args.bucket === 'notes') return null;
  return {
    citedKind: args.bucket === 'lessons' ? 'lesson' : 'decision',
    citedId,
    relation: args.citation.kind,
    reason: args.citation.kind === 'supersedes' ? args.citation.reason : args.citation.how,
    sessionTokenId: tokenId,
  };
}

/**
 * Verify Cat C precondition: structured trigger evidence per note type.
 */
export type NoteTriggerEvidence =
  | { type: 'decision'; user_quote: string }
  | { type: 'decision_selection'; question: string; options_presented: string[]; option_selected: string }
  | { type: 'progress'; tool_call_id?: string; file_path?: string }
  | { type: 'todo'; reason: string }
  | { type: 'question'; question: string }
  | { type: 'agent_observation'; what_happened: string };

export async function verifyCatC(args: {
  evidence: NoteTriggerEvidence | undefined;
  toolName: string;
  payloadFingerprint: string;
}): Promise<void> {
  const e = args.evidence;

  // Defense in depth behind the dispatch-boundary param check: a missing or
  // non-object evidence used to TypeError on `e.type` — an opaque failure that
  // reads as a server bug AND skips violation logging (telemetry blind spot).
  if (!e || typeof e !== 'object') {
    await logViolationAndThrow({
      toolName: args.toolName,
      kind: 'invalid_trigger_evidence',
      payload: args.payloadFingerprint,
      bucket: 'notes',
      message:
        `Write rejected: evidence is required — pass a structured evidence object with a 'type' field, ` +
        `e.g. { type: "progress", file_path: "<file the work landed in>" } or ` +
        `{ type: "progress", tool_call_id: "<id of the tool call that did the work>" }. ` +
        `Got: ${JSON.stringify(e)}.`,
    });
    return;
  }

  let valid = false;
  let why = '';

  switch (e.type) {
    case 'decision':
      valid = !!e.user_quote && e.user_quote.trim().length >= 20;
      why = valid
        ? ''
        : `decision notes require user_quote ≥20 chars (got ${e.user_quote?.length ?? 0}). ` +
          `Quote what the user actually said agreeing to this decision.`;
      break;
    case 'decision_selection': {
      const opts = Array.isArray(e.options_presented) ? e.options_presented : [];
      const q = e.question?.trim() ?? '';
      const sel = e.option_selected?.trim() ?? '';
      valid = q.length >= 10 && opts.length >= 2 && sel.length > 0 && opts.includes(e.option_selected);
      why = valid
        ? ''
        : `decision_selection requires question ≥10 chars, at least 2 options_presented, and ` +
          `option_selected must be one of them. Use this when the decision was made by selecting an ` +
          `option in a dialog (no typed quote needed) — it is a first-class evidence form, not a bypass.`;
      break;
    }
    case 'progress':
      valid = !!e.tool_call_id || !!e.file_path;
      why = valid
        ? ''
        : `progress notes require either tool_call_id or file_path. ` +
          `Reference the actual work that was completed.`;
      break;
    case 'todo':
      valid = !!e.reason && e.reason.trim().length >= 50;
      why = valid
        ? ''
        : `todo notes require reason ≥50 chars (got ${e.reason?.length ?? 0}). ` +
          `Explain why deferred and what unblocks it.`;
      break;
    case 'question':
      valid = !!e.question && e.question.trim().length >= 10;
      why = valid
        ? ''
        : `question notes require question ≥10 chars (got ${e.question?.length ?? 0}).`;
      break;
    case 'agent_observation':
      valid = !!e.what_happened && e.what_happened.trim().length >= 50;
      why = valid
        ? ''
        : `agent_observation requires what_happened ≥50 chars (got ${e.what_happened?.length ?? 0}). ` +
          `Describe the concrete event/correction/pattern that prompted this memory entry.`;
      break;
    default:
      valid = false;
      why = `unknown evidence.type: ${JSON.stringify((e as { type?: unknown }).type)}`;
  }

  if (!valid) {
    await logViolationAndThrow({
      toolName: args.toolName,
      kind: 'invalid_trigger_evidence',
      payload: args.payloadFingerprint,
      bucket: 'notes',
      message: `Write rejected: ${why}`,
    });
  }

  await ensureSessionToken();
}

/**
 * Char-limit enforcer. Throws on any field exceeding FIELD_CHAR_LIMIT.
 */
export async function enforceCharLimits(args: {
  fields: Record<string, string | undefined | null>;
  toolName: string;
}): Promise<void> {
  const violations: Array<{ field: string; len: number }> = [];
  for (const [field, val] of Object.entries(args.fields)) {
    if (typeof val === 'string' && val.length > FIELD_CHAR_LIMIT) {
      violations.push({ field, len: val.length });
    }
  }
  if (violations.length > 0) {
    const detail = violations
      .map((v) => `  ${v.field}: ${v.len} chars (max ${FIELD_CHAR_LIMIT})`)
      .join('\n');
    await logViolationAndThrow({
      toolName: args.toolName,
      kind: 'char_limit_exceeded',
      payload: JSON.stringify(args.fields).slice(0, 1000),
      bucket: 'lessons',
      message: `Write rejected: field char limit exceeded.\n${detail}`,
    });
  }
}

/**
 * Custom error type for gate rejections.
 */
export class WriteGateError extends Error {
  public readonly kind: string;
  public readonly preview: Array<{ id: string; summary: string; meta?: string }>;

  constructor(message: string, kind: string, preview: Array<{ id: string; summary: string; meta?: string }>) {
    super(message);
    this.name = 'WriteGateError';
    this.kind = kind;
    this.preview = preview;
  }
}

/**
 * Internal: log a violation and throw WriteGateError.
 */
async function logViolationAndThrow(args: {
  toolName: string;
  kind: string;
  payload: string;
  bucket: ResultBucket;
  message: string;
}): Promise<void> {
  let preview: Array<{ id: string; summary: string; meta?: string }> = [];
  if (args.kind === 'no_search_token' || args.kind === 'missing_citation' || args.kind === 'invalid_citation') {
    preview = await runPreviewSearch(args.bucket, args.payload);
  }

  const pool = getPool();
  const projectId = await getProjectId();
  const tokenId = await ensureSessionToken();
  await pool.query(
    `INSERT INTO write_violations
       (project_id, session_token_id, tool_name, violation_kind,
        attempted_payload, preview_results)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [projectId, tokenId, args.toolName, args.kind, args.payload.slice(0, 1000), JSON.stringify(preview)]
  );
  await pool.query(
    `UPDATE write_session_tokens SET writes_attempted = writes_attempted + 1, writes_rejected = writes_rejected + 1, last_activity_at = NOW() WHERE id = $1`,
    [tokenId]
  );

  let fullMessage = args.message;
  if (preview.length > 0) {
    fullMessage += `\n\nMost-similar existing entries (use one of these IDs in your citation):`;
    for (const p of preview) {
      fullMessage += `\n  ${p.id}: ${p.summary}` + (p.meta ? ` (${p.meta})` : '');
    }
    fullMessage += `\n\nIf supersession: { kind: "supersedes", supersedes_id: <id>, reason: "..." }`;
    fullMessage += `\nIf extending: { kind: "extends", extends_id: <id>, how: "..." }`;
    fullMessage += `\nIf truly novel: { kind: "novel", justification: "..." }  (≥${NOVEL_JUSTIFICATION_MIN} chars)`;
  }

  throw new WriteGateError(fullMessage, args.kind, preview);
}

/**
 * Server-side preview-search via pg_trgm similarity.
 */
async function runPreviewSearch(
  bucket: ResultBucket,
  payloadFingerprint: string
): Promise<Array<{ id: string; summary: string; meta?: string }>> {
  const pool = getPool();
  const projectId = await getProjectId();
  const queryText = payloadFingerprint.slice(0, 200);

  switch (bucket) {
    case 'lessons': {
      const r = await pool.query<{ id: string; rule: string; confidence_label: string }>(
        `SELECT id, rule, confidence_label
         FROM lessons
         WHERE project_id = $1 AND superseded_by IS NULL
           AND similarity(rule, $2) >= 0.20
         ORDER BY similarity(rule, $2) DESC
         LIMIT 3`,
        [projectId, queryText]
      );
      return r.rows.map((row) => ({
        id: row.id,
        summary: row.rule.slice(0, 80),
        meta: row.confidence_label,
      }));
    }
    case 'decisions': {
      const r = await pool.query<{ id: string; description: string; confidence: number }>(
        `SELECT id, description, confidence
         FROM code_decisions
         WHERE project_id = $1 AND still_valid = true
           AND similarity(description, $2) >= 0.15
         ORDER BY similarity(description, $2) DESC
         LIMIT 3`,
        [projectId, queryText]
      );
      return r.rows.map((row) => ({
        id: row.id,
        summary: row.description.slice(0, 80),
        meta: `conf ${Number(row.confidence).toFixed(2)}`,
      }));
    }
    case 'notes':
    default:
      return [];
  }
}

/**
 * Mark a successful write — update session token stats.
 */
export async function recordWriteSuccess(): Promise<void> {
  const tokenId = await ensureSessionToken();
  const pool = getPool();
  await pool.query(
    `UPDATE write_session_tokens
     SET writes_attempted = writes_attempted + 1,
         writes_succeeded = writes_succeeded + 1,
         last_activity_at = NOW()
     WHERE id = $1`,
    [tokenId]
  );

  await pool.query(
    `UPDATE write_violations
     SET followup_succeeded = true,
         followup_at = NOW()
     WHERE id IN (
       SELECT id FROM write_violations
       WHERE session_token_id = $1 AND followup_succeeded IS NULL
       ORDER BY rejected_at DESC
       LIMIT 1
     )`,
    [tokenId]
  );
}
