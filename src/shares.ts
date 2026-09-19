// Cross-project references (plan 31, spec 2026-08-18-cross-project-references-design.md).
// Two keys, both operator-owned: the target's env (MAI_LINKED_PROJECTS — runtime)
// and a per-artifact grant row (project_shares — created by mai share / the
// dashboard, never by an agent-facing tool). Everything here is READ-ONLY
// toward the source project. Foreign ids are never minted into write-gate
// buckets: this module deliberately never calls recordReadResults or
// bumpSurfaced, so cross-boundary citations are impossible and source-row
// curation counters never tick from target-side reads.
import crypto from 'node:crypto';
import { getPool, getProjectId, projectSlugById } from './db.js';
import {
  budgetPage, budgetRows, headlineField, MCP_READ_NARROWING, pageBudget,
  type ReadBudget, type ReadSection,
} from './read-budget.js';
import { demandCapPrimeMinimum, type PreparedPrimeText } from './prime-budget.js';
import type { BoardRef } from './coordination/board.js';
import type { SqlRunner } from './curation.js';

/** Narrowing hint for mai_shared — ONE authority, the partition's own entry
 * (plan 38 retired the duplicated literal that lived here). */
const SHARED_NARROWING = MCP_READ_NARROWING.mai_shared;

export type ShareKind = 'decision' | 'doc' | 'handoff' | 'idea';
export const SHARE_KINDS: ShareKind[] = ['decision', 'doc', 'handoff', 'idea'];
export type ShareLiveStatus = 'ok' | 'updated' | 'retracted' | 'deleted' | 'moved';

export interface DocRef { repo_root: string; path: string; heading?: string }
export interface ShareSnapshot {
  headline: string;    // one line
  body: string;        // full body — SUPPRESSED on tombstone renders (agent surfaces)
  source_slug: string; // slug at share time (display fallback for audit surfaces)
  detail: string;      // decision_type / handoff type / idea status / doc kind+trail
  /** Kind-specific captured fields (spec §3): decision → source, confidence;
   * handoff → author_agent, refs count; idea → priority, status; doc →
   * doc kind, heading trail. Rendered in the detail view. */
  fields: Record<string, string | BoardRef[]>;
}

export interface ShareRow {
  id: string;
  source_project_id: string;
  target_project_id: string;
  artifact_kind: ShareKind;
  artifact_id: string | null;
  artifact_ref: DocRef | null;
  snapshot: ShareSnapshot;
  content_hash: string;
  snapshot_at: Date;
  note: string | null;
  status: 'active' | 'revoked';
  revoked_at: Date | null;
  revoked_reason: string | null;
  embedding: number[] | null;
  embedding_model: string | null;
  created_via: 'cli' | 'dashboard';
  created_at: Date;
}

export interface ShareLive {
  status: ShareLiveStatus;
  detail: string | null; // retraction reason / drift note — shown with the status
  note: string | null;   // informational non-tombstone flag (resolved/shipped in source)
}
export interface VisibleShare { row: ShareRow; sourceSlug: string; live: ShareLive }

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

/** Explicit prefixed column list — kept in step with ShareRow by Task 8's
 * suite (any drift fails the first resolver test). */
const SHARE_COLUMNS_S =
  `s.id, s.source_project_id, s.target_project_id, s.artifact_kind, s.artifact_id,
   s.artifact_ref, s.snapshot, s.content_hash, s.snapshot_at, s.note, s.status,
   s.revoked_at, s.revoked_reason, s.embedding, s.embedding_model, s.created_via, s.created_at`;

// ---------- the runtime key ----------

/** Linked source slugs this SERVER PROCESS may see. Read from the process
 * environment — written per consumer repo by `mai link` beside
 * MAI_PROJECT_SLUG, never an agent-controllable parameter (decision 392eb314).
 * MEMOIZED ON FIRST USE for the process lifetime (spec §2: even an in-process
 * env mutation cannot widen access after the first read), with a test-only
 * reset seam per the db.ts __resetProjectIdCacheForTests house pattern.
 * Invalid entries drop with one warning: fail closed to FEWER links. */
let _linkedSlugs: string[] | null = null;
export function linkedSlugsFromEnv(): string[] {
  if (_linkedSlugs !== null) return _linkedSlugs;
  const raw = (process.env.MAI_LINKED_PROJECTS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const valid = raw.filter((s) => /^[a-z0-9][a-z0-9-]*$/.test(s));
  if (valid.length !== raw.length) {
    console.warn(
      `[mai-shares] dropped invalid MAI_LINKED_PROJECTS entries: ` +
      raw.filter((s) => !valid.includes(s)).join(', ')
    );
  }
  _linkedSlugs = [...new Set(valid)];
  return _linkedSlugs;
}

/** Test-only: re-read the env on the next call (db.ts seam convention). */
export function __resetLinkedProjectsForTests(): void {
  _linkedSlugs = null;
}

/** Declared links — the CONFIG authority (projects.metadata.linked_projects).
 * Config generation (mai link/init/upgrade/verify) reads this; the read path
 * above never does. Missing project or key → []. */
export async function linkedProjectsForSlug(slug: string): Promise<string[]> {
  const r = await getPool().query<{ metadata: { linked_projects?: unknown } | null }>(
    `SELECT metadata FROM projects WHERE slug = $1`, [slug]
  );
  const raw = r.rows[0]?.metadata?.linked_projects;
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

// ---------- grant / revoke (operator surfaces ONLY — CLI + dashboard) ----------

export interface ShareCreateArgs {
  sourceProjectId: string;
  targetSlug: string;
  kind: ShareKind;
  artifactId?: string;  // decision | handoff | idea: full uuid or unique prefix
  docPath?: string;     // doc: repo-relative path (doc_chunks.path)
  docRepoRoot?: string; // doc: disambiguates when the path exists under two roots
  docHeading?: string;  // doc: optional informational heading
  note?: string;
  createdVia: 'cli' | 'dashboard';
  /** Test-only interleaving seam: runs after the source snapshot is locked and
   * before the share row is touched. */
  beforeGrantInsert?: () => Promise<void>;
}

interface SnapshotBuild { snapshot: ShareSnapshot; contentHash: string; artifactId: string | null; artifactRef: DocRef | null }

async function buildSnapshot(db: SqlRunner, args: ShareCreateArgs, sourceSlug: string): Promise<SnapshotBuild> {
  if (args.kind === 'doc') {
    const docPath = (args.docPath ?? '').trim();
    if (!docPath) throw new Error('doc shares need --path <repo-relative-path>');
    // doc ingestion replaces a path with DELETE+INSERT and can introduce a new
    // repo-root phantom. SHARE blocks all doc_chunks DML through grant commit;
    // row locks alone cannot protect the root-disambiguation predicate.
    await db.query(`LOCK TABLE doc_chunks IN SHARE MODE`);
    const rows = await db.query<{ repo_root: string; doc_sha: string; kind: string; heading_trail: string; content: string }>(
      `SELECT repo_root, doc_sha, kind, heading_trail, content FROM doc_chunks
        WHERE project_id = $1 AND path = $2 AND ($3::text IS NULL OR repo_root = $3)
        ORDER BY chunk_index LIMIT 1 FOR SHARE`,
      [args.sourceProjectId, docPath, args.docRepoRoot ?? null]
    );
    if (rows.rows.length === 0) {
      throw new Error(`doc '${docPath}' not found in project '${sourceSlug}' (not ingested, wrong path, or wrong --repo-root)`);
    }
    const roots = await db.query<{ repo_root: string }>(
      `SELECT DISTINCT repo_root FROM doc_chunks WHERE project_id = $1 AND path = $2`,
      [args.sourceProjectId, docPath]
    );
    if (args.docRepoRoot === undefined && roots.rows.length > 1) {
      throw new Error(`doc '${docPath}' exists under ${roots.rows.length} repo roots — pass --repo-root <root>: ${roots.rows.map((r) => r.repo_root).join(', ')}`);
    }
    const first = rows.rows[0];
    const heading = (args.docHeading ?? '').trim() || undefined;
    return {
      snapshot: {
        headline: headlineField(`${docPath}${heading ? ` § ${heading}` : ''}`, 200),
        body: first.content,
        source_slug: sourceSlug,
        detail: `${first.kind}${first.heading_trail ? ` · ${first.heading_trail}` : ''}`,
        fields: { doc_kind: first.kind, heading_trail: first.heading_trail },
      },
      contentHash: first.doc_sha,
      artifactId: null,
      artifactRef: { repo_root: first.repo_root, path: docPath, ...(heading ? { heading } : {}) },
    };
  }

  const resolveOne = async <T extends { id: string }>(sql: string): Promise<T> => {
    const prefix = (args.artifactId ?? '').trim().toLowerCase();
    if (!/^[0-9a-f][0-9a-f-]{3,35}$/.test(prefix)) {
      throw new Error(`${args.kind} shares need an artifact id (uuid or ≥4-char prefix)`);
    }
    const r = await db.query<T>(`${sql} FOR SHARE`, [args.sourceProjectId, prefix]);
    if (r.rows.length === 0) {
      throw new Error(`${args.kind} '${prefix}' not found in project '${sourceSlug}' — only a project's OWN artifacts can be shared (no transitive sharing)`);
    }
    if (r.rows.length > 1) throw new Error(`${args.kind} prefix '${prefix}' is ambiguous (${r.rows.length} matches) — use more characters`);
    return r.rows[0];
  };

  if (args.kind === 'decision') {
    const d = await resolveOne<{ id: string; description: string; reasoning: string | null; decision_type: string; source: string; confidence: number | null; still_valid: boolean; retracted_at: Date | null }>(
      `SELECT id, description, reasoning, decision_type, source, confidence, still_valid, retracted_at
         FROM code_decisions WHERE project_id = $1 AND id::text LIKE $2 || '%'`
    );
    if (!d.still_valid || d.retracted_at !== null) {
      throw new Error(`decision ${d.id.slice(0, 8)} is retracted in '${sourceSlug}' — sharing a tombstone is refused`);
    }
    const body = `${d.description}${d.reasoning ? `\n\n${d.reasoning}` : ''}`;
    return {
      snapshot: {
        headline: headlineField(d.description, 200), body, source_slug: sourceSlug, detail: d.decision_type,
        fields: { source: d.source, confidence: d.confidence === null ? 'unknown' : Number(d.confidence).toFixed(2) },
      },
      contentHash: sha256(`${d.description}\n${d.reasoning ?? ''}`),
      artifactId: d.id, artifactRef: null,
    };
  }
  if (args.kind === 'handoff') {
    const m = await resolveOne<{ id: string; body: string; type: string; status: string; author_agent: string; refs: BoardRef[] }>(
      `SELECT id, body, type, status, author_agent, refs FROM agent_messages WHERE project_id = $1 AND id::text LIKE $2 || '%'`
    );
    if (m.status === 'superseded' || m.status === 'stale') {
      throw new Error(`board message ${m.id.slice(0, 8)} is ${m.status} in '${sourceSlug}' — sharing a tombstone is refused`);
    }
    return {
      snapshot: {
        headline: headlineField(m.body, 200), body: m.body, source_slug: sourceSlug, detail: m.type,
        fields: {
          author_agent: m.author_agent,
          refs: Array.isArray(m.refs) ? m.refs : [],
        },
      },
      contentHash: sha256(m.body),
      artifactId: m.id, artifactRef: null,
    };
  }
  // idea
  const i = await resolveOne<{ id: string; title: string; detail: string | null; status: string; priority: string }>(
    `SELECT id, title, detail, status, priority FROM ideas WHERE project_id = $1 AND id::text LIKE $2 || '%'`
  );
  if (i.status === 'dropped') {
    throw new Error(`idea ${i.id.slice(0, 8)} is dropped in '${sourceSlug}' — sharing a tombstone is refused`);
  }
  return {
    snapshot: {
      headline: headlineField(i.title, 200),
      body: `${i.title}${i.detail ? `\n\n${i.detail}` : ''}`,
      source_slug: sourceSlug,
      detail: i.status,
      fields: { priority: i.priority, status: i.status },
    },
    contentHash: sha256(`${i.title}\n${i.detail ?? ''}`),
    artifactId: i.id, artifactRef: null,
  };
}

/** Create one grant (operator surfaces only). Ownership is enforced by every
 * buildSnapshot query filtering project_id = source — a foreign artifact is
 * simply "not found", which is what makes transitive re-sharing impossible. */
export async function shareCreate(args: ShareCreateArgs): Promise<string> {
  if (!SHARE_KINDS.includes(args.kind)) throw new Error(`kind must be one of: ${SHARE_KINDS.join(', ')}`);
  // Grant row + audit event commit ATOMICALLY (spec §2: "one grant row
  // (+ audit event) atomically") — a grant that exists without its event, or
  // vice versa, is unrepairable by retry (the active-unique index blocks a
  // re-insert; a lone event lies). One checked-out client, one transaction.
  const client = await getPool().connect();
  let shareId: string;
  let sourceSlug: string;
  let targetSlug: string;
  let regrant = false;
  try {
    await client.query('BEGIN');
    // Mutation identity never uses db.ts's process-lifetime slug caches. Resolve
    // the requested target name live, then lock source+target in UUID order and
    // re-check the name after the lock. This rejects a cached/stale old slug and
    // freezes event-time display slugs for the whole grant transaction.
    const targetLookup = await client.query<{ id: string }>(
      `SELECT id FROM projects WHERE slug = $1`, [args.targetSlug]
    );
    if (targetLookup.rows.length === 0) throw new Error(`Project not found: ${args.targetSlug}`);
    const targetId = targetLookup.rows[0].id;
    if (targetId === args.sourceProjectId) throw new Error('source and target are the same project — nothing to share');
    const identities = await client.query<{ id: string; slug: string }>(
      `SELECT id, slug FROM projects WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [[args.sourceProjectId, targetId]]
    );
    const source = identities.rows.find((row) => row.id === args.sourceProjectId);
    const target = identities.rows.find((row) => row.id === targetId);
    if (!source) throw new Error(`Source project not found: ${args.sourceProjectId}`);
    if (!target || target.slug !== args.targetSlug) throw new Error(`Project not found: ${args.targetSlug}`);
    sourceSlug = source.slug;
    targetSlug = target.slug;

    // Every artifact query uses this transaction's client and locks the exact
    // accepted row through grant/event commit. Docs additionally take a SHARE
    // table lock so path/root predicates cannot gain or lose rows mid-grant.
    const built = await buildSnapshot(client, args, sourceSlug);
    const { embed, currentEmbeddingModelId } = await import('./embeddings.js');
    const vec = await embed(`${built.snapshot.headline}\n${built.snapshot.body}`);
    if (args.beforeGrantInsert !== undefined) await args.beforeGrantInsert();

    // jsonb equality, never ::text vs JSON.stringify — Postgres normalizes
    // jsonb rendering, so a text compare would miss real matches.
    const prior = await client.query(
      `SELECT 1 FROM project_shares
        WHERE source_project_id = $1 AND target_project_id = $2 AND artifact_kind = $3
          AND ((artifact_id IS NOT NULL AND artifact_id = $4)
            OR (artifact_ref IS NOT NULL AND artifact_ref = $5::jsonb))
          AND status = 'revoked' LIMIT 1`,
      [args.sourceProjectId, targetId, args.kind, built.artifactId, built.artifactRef === null ? null : JSON.stringify(built.artifactRef)]
    );
    regrant = prior.rows.length > 0;
    const r = await client.query<{ id: string }>(
      `INSERT INTO project_shares
         (source_project_id, target_project_id, artifact_kind, artifact_id, artifact_ref,
          snapshot, content_hash, note, embedding, embedding_model, created_via)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11) RETURNING id`,
      [args.sourceProjectId, targetId, args.kind, built.artifactId,
       built.artifactRef === null ? null : JSON.stringify(built.artifactRef),
       JSON.stringify(built.snapshot), built.contentHash, args.note ?? null,
       vec, vec ? currentEmbeddingModelId() : null, args.createdVia]
    );
    shareId = r.rows[0].id;
    await client.query(
      `INSERT INTO share_events
         (share_id, event, source_project_id, target_project_id, source_slug,
          target_slug, artifact_kind, headline, actor_surface, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [shareId, regrant ? 'regrant' : 'grant', args.sourceProjectId, targetId,
       sourceSlug, targetSlug, args.kind, built.snapshot.headline,
       args.createdVia, args.note ?? null]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof Error && /project_shares_active_uniq|duplicate key/.test(err.message)) {
      throw new Error(`already actively shared ${args.kind} → '${args.targetSlug}' — revoke first to re-share`);
    }
    throw err;
  } finally {
    client.release();
  }
  const declared = await linkedProjectsForSlug(targetSlug);
  const pending = declared.includes(sourceSlug)
    ? ''
    : `\npending: '${targetSlug}' has not linked '${sourceSlug}' — run: mai link ${targetSlug} --with ${sourceSlug}`;
  return `shared ${args.kind} → '${targetSlug}' (share ${shareId.slice(0, 8)})${pending}`;
}

/** Revoke one grant (operator surfaces only). Reason required. Immediate:
 * the resolver reads status per request — nothing caches share rows. */
export async function shareRevoke(args: {
  shareId: string; reason: string; via: 'cli' | 'dashboard'; projectId: string;
  /** Test-only concurrency seam after ordered project locks and before the
   * share-row lock. */
  beforeShareLock?: () => Promise<void>;
}): Promise<string> {
  const reason = (args.reason ?? '').trim();
  if (!reason) throw new Error('revocation requires a --reason');
  const prefix = (args.shareId ?? '').trim().toLowerCase();
  if (!/^[0-9a-f][0-9a-f-]{3,35}$/.test(prefix)) throw new Error('share id must be a uuid or ≥4-char prefix');
  // Revoke + audit event commit atomically; the row is locked and the status
  // transition is CONDITIONAL, so a concurrent double-revoke fails loudly
  // instead of writing a second event over an already-revoked share.
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // Discovery is deliberately unlocked. Mutation lock order is globally
    // projects-in-UUID-order → share row, matching shareCreate and preventing
    // grant/revoke wait cycles.
    const candidates = await client.query<{ id: string; source_project_id: string; target_project_id: string }>(
      `SELECT id, source_project_id, target_project_id, artifact_kind, snapshot
        FROM project_shares
        WHERE status = 'active' AND id::text LIKE $1 || '%'
          AND (source_project_id = $2 OR target_project_id = $2)`,
      [prefix, args.projectId]
    );
    if (candidates.rows.length === 0) throw new Error(`no active share matches '${prefix}'`);
    if (candidates.rows.length > 1) throw new Error(`share prefix '${prefix}' is ambiguous — use more characters`);
    const candidate = candidates.rows[0];
    const identities = await client.query<{ id: string; slug: string }>(
      `SELECT id, slug FROM projects WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [[candidate.source_project_id, candidate.target_project_id]]
    );
    if (args.beforeShareLock !== undefined) await args.beforeShareLock();
    const locked = await client.query<{ id: string; source_project_id: string; target_project_id: string; artifact_kind: ShareKind; snapshot: ShareSnapshot }>(
      `SELECT id, source_project_id, target_project_id, artifact_kind, snapshot
         FROM project_shares
        WHERE id = $1 AND status = 'active'
          AND (source_project_id = $2 OR target_project_id = $2)
        FOR UPDATE`,
      [candidate.id, args.projectId]
    );
    if (locked.rows.length === 0) throw new Error(`share ${candidate.id.slice(0, 8)} was not active — nothing revoked`);
    const s = locked.rows[0];
    const source = identities.rows.find((row) => row.id === s.source_project_id);
    const target = identities.rows.find((row) => row.id === s.target_project_id);
    if (!source || !target) throw new Error('share project disappeared during revoke');
    const updated = await client.query(
      `UPDATE project_shares SET status = 'revoked', revoked_at = NOW(), revoked_reason = $2
        WHERE id = $1 AND status = 'active'`,
      [s.id, reason]
    );
    if (updated.rowCount !== 1) throw new Error(`share ${s.id.slice(0, 8)} was not active — nothing revoked`);
    await client.query(
      `INSERT INTO share_events
         (share_id, event, source_project_id, target_project_id, source_slug,
          target_slug, artifact_kind, headline, actor_surface, note)
       VALUES ($1,'revoke',$2,$3,$4,$5,$6,$7,$8,$9)`,
      [s.id, s.source_project_id, s.target_project_id,
       source.slug, target.slug,
       s.artifact_kind, s.snapshot.headline, args.via, reason]
    );
    await client.query('COMMIT');
    return `revoked share ${s.id.slice(0, 8)} — invisible on the next read`;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------- resolution + live classification (the ONE foreign read path) ----------

async function classifyLive(row: ShareRow): Promise<ShareLive> {
  const db = getPool();
  if (row.artifact_kind === 'decision') {
    const r = await db.query<{ description: string; reasoning: string | null; still_valid: boolean; retracted_at: Date | null; retraction_reason: string | null }>(
      `SELECT description, reasoning, still_valid, retracted_at, retraction_reason
         FROM code_decisions WHERE id = $1 AND project_id = $2`,
      [row.artifact_id, row.source_project_id]
    );
    if (r.rows.length === 0) return { status: 'deleted', detail: 'source artifact deleted', note: null };
    const d = r.rows[0];
    if (!d.still_valid || d.retracted_at !== null) {
      return { status: 'retracted', detail: d.retraction_reason ?? 'retracted in source', note: null };
    }
    const hash = sha256(`${d.description}\n${d.reasoning ?? ''}`);
    return hash === row.content_hash
      ? { status: 'ok', detail: null, note: null }
      : { status: 'updated', detail: 'updated in source since shared', note: null };
  }
  if (row.artifact_kind === 'handoff') {
    const r = await db.query<{ body: string; status: string }>(
      `SELECT body, status FROM agent_messages WHERE id = $1 AND project_id = $2`,
      [row.artifact_id, row.source_project_id]
    );
    if (r.rows.length === 0) return { status: 'deleted', detail: 'source artifact deleted', note: null };
    const m = r.rows[0];
    if (m.status === 'superseded' || m.status === 'stale') {
      return { status: 'retracted', detail: `${m.status} in source`, note: null };
    }
    const drift = sha256(m.body) === row.content_hash ? null : 'updated in source since shared';
    return {
      status: drift === null ? 'ok' : 'updated', detail: drift,
      note: m.status === 'resolved' ? 'resolved in source' : null,
    };
  }
  if (row.artifact_kind === 'idea') {
    const r = await db.query<{ title: string; detail: string | null; status: string }>(
      `SELECT title, detail, status FROM ideas WHERE id = $1 AND project_id = $2`,
      [row.artifact_id, row.source_project_id]
    );
    if (r.rows.length === 0) return { status: 'deleted', detail: 'source artifact deleted', note: null };
    const i = r.rows[0];
    if (i.status === 'dropped') return { status: 'retracted', detail: 'dropped in source', note: null };
    const drift = sha256(`${i.title}\n${i.detail ?? ''}`) === row.content_hash ? null : 'updated in source since shared';
    return {
      status: drift === null ? 'ok' : 'updated', detail: drift,
      note: i.status === 'shipped' ? 'shipped in source' : null,
    };
  }
  // doc
  const ref = row.artifact_ref;
  if (ref === null) return { status: 'moved', detail: 'share row carries no doc ref', note: null };
  const r = await db.query<{ doc_sha: string }>(
    `SELECT doc_sha FROM doc_chunks WHERE project_id = $1 AND repo_root = $2 AND path = $3 LIMIT 1`,
    [row.source_project_id, ref.repo_root, ref.path]
  );
  if (r.rows.length === 0) return { status: 'moved', detail: 'moved or renamed in source', note: null };
  return r.rows[0].doc_sha === row.content_hash
    ? { status: 'ok', detail: null, note: null }
    : { status: 'updated', detail: 'updated in source since shared', note: null };
}

/** Batched live classification for the hot read paths (prime/search): ONE
 * query per id-kind via ANY(uuid[]), instead of one per share. project_id is
 * re-checked per row (defense in depth — a share row pins its source). Doc
 * refs classify per-ref via classifyLive; docs are expected rare and the
 * resolver's LIMIT bounds the worst case. */
async function classifyLiveBatch(rows: readonly ShareRow[]): Promise<Map<string, ShareLive>> {
  const db = getPool();
  const out = new Map<string, ShareLive>();
  const idsOf = (k: ShareKind): ShareRow[] => rows.filter((r) => r.artifact_kind === k);

  const dec = idsOf('decision');
  if (dec.length > 0) {
    const r = await db.query<{ id: string; project_id: string; description: string; reasoning: string | null; still_valid: boolean; retracted_at: Date | null; retraction_reason: string | null }>(
      `SELECT id, project_id, description, reasoning, still_valid, retracted_at, retraction_reason
         FROM code_decisions WHERE id = ANY($1::uuid[])`,
      [dec.map((x) => x.artifact_id)]
    );
    const live = new Map(r.rows.map((row) => [row.id, row]));
    for (const s of dec) {
      const d = s.artifact_id === null ? undefined : live.get(s.artifact_id);
      if (!d || d.project_id !== s.source_project_id) { out.set(s.id, { status: 'deleted', detail: 'source artifact deleted', note: null }); continue; }
      if (!d.still_valid || d.retracted_at !== null) { out.set(s.id, { status: 'retracted', detail: d.retraction_reason ?? 'retracted in source', note: null }); continue; }
      const drift = sha256(`${d.description}\n${d.reasoning ?? ''}`) === s.content_hash;
      out.set(s.id, drift ? { status: 'ok', detail: null, note: null } : { status: 'updated', detail: 'updated in source since shared', note: null });
    }
  }
  const hand = idsOf('handoff');
  if (hand.length > 0) {
    const r = await db.query<{ id: string; project_id: string; body: string; status: string }>(
      `SELECT id, project_id, body, status FROM agent_messages WHERE id = ANY($1::uuid[])`,
      [hand.map((x) => x.artifact_id)]
    );
    const live = new Map(r.rows.map((row) => [row.id, row]));
    for (const s of hand) {
      const m = s.artifact_id === null ? undefined : live.get(s.artifact_id);
      if (!m || m.project_id !== s.source_project_id) { out.set(s.id, { status: 'deleted', detail: 'source artifact deleted', note: null }); continue; }
      if (m.status === 'superseded' || m.status === 'stale') { out.set(s.id, { status: 'retracted', detail: `${m.status} in source`, note: null }); continue; }
      const same = sha256(m.body) === s.content_hash;
      out.set(s.id, {
        status: same ? 'ok' : 'updated', detail: same ? null : 'updated in source since shared',
        note: m.status === 'resolved' ? 'resolved in source' : null,
      });
    }
  }
  const idea = idsOf('idea');
  if (idea.length > 0) {
    const r = await db.query<{ id: string; project_id: string; title: string; detail: string | null; status: string }>(
      `SELECT id, project_id, title, detail, status FROM ideas WHERE id = ANY($1::uuid[])`,
      [idea.map((x) => x.artifact_id)]
    );
    const live = new Map(r.rows.map((row) => [row.id, row]));
    for (const s of idea) {
      const i = s.artifact_id === null ? undefined : live.get(s.artifact_id);
      if (!i || i.project_id !== s.source_project_id) { out.set(s.id, { status: 'deleted', detail: 'source artifact deleted', note: null }); continue; }
      if (i.status === 'dropped') { out.set(s.id, { status: 'retracted', detail: 'dropped in source', note: null }); continue; }
      const same = sha256(`${i.title}\n${i.detail ?? ''}`) === s.content_hash;
      out.set(s.id, {
        status: same ? 'ok' : 'updated', detail: same ? null : 'updated in source since shared',
        note: i.status === 'shipped' ? 'shipped in source' : null,
      });
    }
  }
  for (const s of idsOf('doc')) out.set(s.id, await classifyLive(s));
  return out;
}

interface ShareCursor { createdAt: Date; id: string }
interface VisibleSharePage { rows: VisibleShare[]; nextCursor: ShareCursor | null }
const SHARE_PAGE_SIZE = 100;

/** One bounded two-key page. Surface semantics choose the bound: list/prime
 * stop after their presentation cap, detail uses a direct prefix predicate,
 * and search follows every cursor before selecting its top three. */
async function visibleSharePage(
  targetProjectId: string,
  args: { limit: number; cursor?: ShareCursor; idPrefix?: string },
): Promise<VisibleSharePage> {
  const slugs = linkedSlugsFromEnv();
  if (slugs.length === 0) return { rows: [], nextCursor: null };
  const limit = Math.max(1, Math.min(args.limit, SHARE_PAGE_SIZE));
  const r = await getPool().query<ShareRow & { source_slug: string }>(
    `SELECT ${SHARE_COLUMNS_S}, p.slug AS source_slug
       FROM project_shares s JOIN projects p ON p.id = s.source_project_id
      WHERE s.target_project_id = $1 AND s.status = 'active' AND p.slug = ANY($2::text[])
        AND ($3::text IS NULL OR s.id::text LIKE $3 || '%')
        AND ($4::timestamptz IS NULL OR s.created_at < $4
          OR (s.created_at = $4 AND s.id < $5::uuid))
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT $6`,
    [targetProjectId, slugs, args.idPrefix ?? null,
     args.cursor?.createdAt ?? null, args.cursor?.id ?? null, limit]
  );
  const live = await classifyLiveBatch(r.rows);
  const rows: VisibleShare[] = r.rows.map((row) => ({
    row, sourceSlug: row.source_slug,
    live: live.get(row.id) ?? { status: 'deleted', detail: 'classification missing', note: null },
  }));
  const last = r.rows.at(-1);
  return {
    rows,
    nextCursor: r.rows.length === limit && last
      ? { createdAt: last.created_at, id: last.id }
      : null,
  };
}

/** Complete semantic resolver used by security tests and non-presentational
 * callers. It is complete but never one unbounded SQL query: classification
 * remains batched page-by-page. */
export async function resolveVisibleShares(targetProjectId: string): Promise<VisibleShare[]> {
  const out: VisibleShare[] = [];
  let cursor: ShareCursor | undefined;
  do {
    const page = await visibleSharePage(targetProjectId, { limit: SHARE_PAGE_SIZE, cursor });
    out.push(...page.rows);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return out;
}

// ---------- renderers (label format lives HERE and only here) ----------

/** Canonical source label. Every nonblank agent-visible foreign line begins
 * with this exact value — list, detail, prime and search. */
function shareLabel(v: VisibleShare): string {
  const statusBits = [v.live.status, ...(v.live.note ? [v.live.note] : [])].join(' · ');
  return `[from ${v.sourceSlug} · ${v.row.artifact_kind} · ${statusBits}]`;
}

export function shareLine(v: VisibleShare): string {
  const s = v.row.snapshot;
  const suffix = v.live.status === 'retracted' ? ` — RETRACTED in source: ${v.live.detail ?? 'no reason recorded'} — body withheld`
    : v.live.status === 'deleted' ? ' — source artifact deleted'
    : v.live.status === 'moved' ? ` — ${v.live.detail}`
    : v.live.status === 'updated' ? ` — ${v.live.detail}`
    : '';
  const note = v.row.note ? ` — note: ${headlineField(v.row.note, 120)}` : '';
  const content = `${s.headline} (share \`${v.row.id.slice(0, 8)}\`)${suffix}${note}`;
  const label = shareLabel(v);
  // Retraction reasons are operator-authored and may contain newlines. Prefix
  // AFTER splitting so list, prime and search cannot emit an unlabelled
  // continuation line from any interpolated value.
  return content.split('\n').map((line) => `- ${label} ${line}`).join('\n');
}

function shareDetail(v: VisibleShare): string {
  const s = v.row.snapshot;
  const kindFields = Object.entries(s.fields ?? {}).map(([k, val]) =>
    `${k}: ${typeof val === 'string' ? val : JSON.stringify(val)}`
  ).join(' · ');
  const lines = [
    `# Shared reference ${v.row.id.slice(0, 8)} — from ${v.sourceSlug}`,
    '',
    `kind: ${v.row.artifact_kind} (${s.detail}) · status: ${v.live.status}${v.live.note ? ` · ${v.live.note}` : ''}`,
    `granted: ${v.row.created_at.toISOString().slice(0, 10)} · snapshot taken: ${v.row.snapshot_at.toISOString().slice(0, 10)}${v.row.note ? ` · note: ${v.row.note}` : ''}`,
    ...(kindFields ? [kindFields] : []),
  ];
  if (v.live.status === 'retracted' || v.live.status === 'deleted') {
    lines.push('', `${v.live.status === 'retracted' ? 'RETRACTED in source' : 'Source artifact deleted'}: ${v.live.detail ?? ''}`,
      '', '_Snapshot body withheld — the source no longer stands behind this content. The operator can still read it on the dashboard Sharing page._');
  } else {
    if (v.live.detail) lines.push('', `⚠ ${v.live.detail}`);
    lines.push('', '--- snapshot (share-time copy; the source project owns the truth) ---', '', s.body);
  }
  if (v.row.artifact_ref) lines.push('', `source doc: ${v.row.artifact_ref.repo_root}/${v.row.artifact_ref.path}`);
  if (v.row.artifact_id) lines.push('', `source artifact id: ${v.row.artifact_id} (READ-ONLY — not citable in this project's write gate)`);
  // Prefix after joining so embedded snapshot newlines are labelled too.
  const label = shareLabel(v);
  return lines.join('\n').split('\n')
    .map((line) => line === '' ? '' : `${label} ${line}`)
    .join('\n');
}

/** mai_shared backend. list (default) or deterministic id-prefix detail page.
 * Never mints tokens. Direct non-MCP callers with no budget/part retain the
 * complete single-string detail used by operator tests. */
export async function sharedQuery(
  args: { id?: string; limit?: number; part?: number }, budget?: ReadBudget,
): Promise<string> {
  const projectId = await getProjectId();
  if (args.part !== undefined && args.id === undefined) throw new Error('mai_shared part requires id');
  if (args.id !== undefined) {
    const prefix = args.id.trim().toLowerCase();
    const hits = (await visibleSharePage(projectId, { limit: 2, idPrefix: prefix })).rows;
    if (hits.length === 0) return `no visible share matches '${prefix}' — list with mai_shared.`;
    if (hits.length > 1) return `share prefix '${prefix}' is ambiguous (${hits.length}) — use more characters.`;
    const detail = shareDetail(hits[0]);
    if (budget === undefined && args.part === undefined) return detail;
    return budgetPage(
      pageBudget(), `${shareLabel(hits[0])} Shared detail ${hits[0].row.id.slice(0, 8)}`,
      detail, args.part ?? 1, 'share',
      (next) => `mai_shared {id:"${hits[0].row.id.slice(0, 8)}", part:${next}}`,
    ).text;
  }
  const limit = Math.max(1, Math.min(args.limit ?? 20, 50));
  const visible = (await visibleSharePage(projectId, { limit })).rows;
  if (visible.length === 0) {
    return linkedSlugsFromEnv().length === 0
      ? 'No linked projects — cross-project references are operator-configured (mai link / mai share).'
      : 'Linked projects have shared nothing visible here yet.';
  }
  return budgetRows(
    budget, visible,
    (xs) => ['# Shared from linked projects (read-only)', '', ...xs.map(shareLine), '', '_Detail: mai_shared {id: "<prefix>"}. These are FOREIGN references — not citable via extends/supersedes._'].join('\n'),
    shareLine, '# Shared from linked projects (read-only)', 'share', SHARED_NARROWING,
  );
}

const SHARED_PRIME_HEADING = '## Shared from linked projects (read-only)';
const SHARED_RECOVERY_MINIMUM =
  '_mai_shared for linked references; foreign ids are not citable._';

/** The prepared shared source keeps BOTH lanes off one resolver result: the
 * allocated lane renders every visible row, while `legacyFull` reproduces the
 * historical first-five-plus-pointer string for unbudgeted callers. */
export interface PreparedPrimeSharedText extends PreparedPrimeText {
  legacyFull: string | null;
}

/** Prime section prepared — ONE `visibleSharePage` resolution, no re-query.
 * Omitted entirely when nothing resolves (legacy projects pay zero bytes).
 * Task-scoped prime ONLY; never primeStartupCompact. */
export async function preparePrimeSharedSection(projectId: string): Promise<PreparedPrimeSharedText> {
  const visible = (await visibleSharePage(projectId, { limit: 6 })).rows;
  if (visible.length === 0) return { minimum: '', full: '', legacyFull: null, render: () => '' };

  const legacyRows = visible.slice(0, 5).map(shareLine);
  const legacyFull = [SHARED_PRIME_HEADING, '', ...legacyRows, '',
    `_${visible.length > 5 ? 'More shares available' : `${visible.length} share(s) visible`} — mai_shared for the list/detail. Foreign ids are not citable._`].join('\n');

  const renderFull = (rows: readonly VisibleShare[]): string =>
    [SHARED_PRIME_HEADING, '', ...rows.map(shareLine), '',
      `_${rows.length} share(s) visible — mai_shared for the list/detail. Foreign ids are not citable._`].join('\n');
  const full = renderFull(visible);
  const minimum = demandCapPrimeMinimum(full, SHARED_RECOVERY_MINIMUM);
  // Execution resolution (decision 43ef92f9, operator-confirmed): the degraded
  // block keeps the approved 400-char floor, one labelled row and the literal
  // mai_shared route; the foreign-id warning stays pinned in the recovery
  // minimum and the full/legacy renders. A warning line here costs 66 chars and
  // would evict the label row the floor exists to preserve. Non-citability is
  // enforced by the write gate, which never mints a foreign id.
  const headline = (v: VisibleShare): string =>
    `${shareLabel(v)} ${headlineField(v.row.snapshot.headline, 120)} (share \`${v.row.id.slice(0, 8)}\`)`;

  return {
    minimum,
    full,
    legacyFull,
    render: (charBudget?: number) =>
      budgetRows(
        charBudget === undefined ? undefined : { fullRows: visible.length, charBudget },
        visible, renderFull, headline, SHARED_PRIME_HEADING, 'share', SHARED_NARROWING, minimum,
      ),
  };
}

export async function primeSharedSection(projectId: string): Promise<string | null> {
  return (await preparePrimeSharedSection(projectId)).legacyFull;
}

/** Simple deterministic lexical score: fraction of query tokens (len ≥ 3)
 * present in the text. Fallback lane when a share row has no current-model
 * embedding — shares are few (target-scoped), so Node-side scoring is fine. */
export function lexicalScore(query: string, text: string): number {
  const tokens = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3))];
  if (tokens.length === 0) return 0;
  const hay = text.toLowerCase();
  return tokens.filter((t) => hay.includes(t)).length / tokens.length;
}

/** Foreign-references lane for mai_search (kind 'all'). Separate section, cap 3,
 * labelled rows, NO token minting. Cosine on model-matching share embeddings;
 * lexical fallback for the rest. PINNED-PROJECT ONLY: the env key describes
 * THIS server's links, so an operator `mai search --project X` from a shell
 * carrying another project's MAI_LINKED_PROJECTS must not resolve X's grants
 * against it — the lane returns null for any non-pinned project (and for an
 * unpinned CLI process, where getProjectId throws). */
export async function sharesReadSection(query: string, projectId: string): Promise<ReadSection | null> {
  try {
    if (projectId !== (await getProjectId())) return null;
  } catch {
    return null; // unpinned surface (CLI --project without MAI_PROJECT_SLUG)
  }
  const { embedQuery, embeddingsEnabled, cosineSim, currentEmbeddingModelId } = await import('./embeddings.js');
  const modelId = embeddingsEnabled() ? currentEmbeddingModelId() : null;
  const queryVec = modelId ? await embedQuery(query) : null;
  const scored: Array<{ v: VisibleShare; score: number }> = [];
  let cursor: ShareCursor | undefined;
  do {
    const page = await visibleSharePage(projectId, { limit: SHARE_PAGE_SIZE, cursor });
    for (const v of page.rows) {
      const s = v.row.snapshot;
      const semantic = queryVec && v.row.embedding && v.row.embedding_model === modelId
        ? cosineSim(queryVec, v.row.embedding) : null;
      const score = semantic ?? lexicalScore(query, `${s.headline}\n${s.body}`);
      const threshold = semantic !== null ? 0.25 : 0.34;
      if (score >= threshold) scored.push({ v, score });
    }
    scored.sort((a, b) => b.score - a.score);
    scored.splice(3);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  if (scored.length === 0) return null;
  const rows = scored.map((x) =>
    `${shareLine(x.v)} — detail: mai_shared {id: "${x.v.row.id.slice(0, 8)}"}`
  );
  return {
    heading: '## Foreign references (read-only — from linked projects; not citable)\n',
    fullRows: rows,
    headlineRows: [...rows],
  };
}

// ---------- operator (web/CLI) views ----------

export interface OperatorShare {
  id: string; direction: 'in' | 'out'; kind: ShareKind; status: 'active' | 'revoked';
  source_slug: string; current_source_slug: string; target_slug: string; headline: string; body: string;
  detail: string; fields: Record<string, string | BoardRef[]>; note: string | null; live: ShareLive | null;
  created_at: string; revoked_at: string | null; revoked_reason: string | null;
  link_state: 'linked' | 'pending' | 'dark';
}

export interface OperatorLinkState {
  source_slug: string;
  current_source_slug: string | null;
  state: 'linked' | 'pending' | 'dark';
  detail: string;
}

function operatorLinkState(
  grantSlug: string, currentSlug: string | null, declared: readonly string[],
): Pick<OperatorLinkState, 'state' | 'detail'> {
  if (currentSlug === null) return { state: 'dark', detail: 'source renamed or deleted — references are dark' };
  if (declared.includes(currentSlug)) {
    return grantSlug === currentSlug
      ? { state: 'linked', detail: 'both runtime link and grant source agree' }
      : { state: 'linked', detail: `relinked to renamed source '${currentSlug}' (grant-time slug '${grantSlug}')` };
  }
  if (grantSlug !== currentSlug) return { state: 'dark', detail: `source renamed to '${currentSlug}' — references are dark` };
  return { state: 'pending', detail: `run: mai link <target> --with ${currentSlug}` };
}

/** Dashboard/CLI listing — full snapshots (operator surface; suppression is an
 * agent-surface behaviour, not data deletion). Grant-time and current source
 * slugs stay distinct so pending and renamed/dark are not conflated. */
export async function sharesOperatorView(projectId: string, direction: 'in' | 'out' | 'both'): Promise<OperatorShare[]> {
  const db = getPool();
  const mySlug = await projectSlugById(projectId);
  const declared = await linkedProjectsForSlug(mySlug);
  const r = await db.query<ShareRow & { source_slug: string; target_slug: string }>(
    `SELECT ${SHARE_COLUMNS_S},
            sp.slug AS source_slug, tp.slug AS target_slug
       FROM project_shares s
       JOIN projects sp ON sp.id = s.source_project_id
       JOIN projects tp ON tp.id = s.target_project_id
      WHERE ($2 IN ('in','both') AND s.target_project_id = $1)
         OR ($2 IN ('out','both') AND s.source_project_id = $1)
      ORDER BY s.created_at DESC LIMIT 200`,
    [projectId, direction]
  );
  const out: OperatorShare[] = [];
  for (const row of r.rows) {
    const dir: 'in' | 'out' = row.target_project_id === projectId ? 'in' : 'out';
    out.push({
      id: row.id, direction: dir, kind: row.artifact_kind, status: row.status,
      source_slug: row.snapshot.source_slug, current_source_slug: row.source_slug,
      target_slug: row.target_slug,
      headline: row.snapshot.headline, body: row.snapshot.body, detail: row.snapshot.detail,
      fields: row.snapshot.fields,
      note: row.note, live: row.status === 'active' ? await classifyLive(row) : null,
      created_at: row.created_at.toISOString(),
      revoked_at: row.revoked_at ? row.revoked_at.toISOString() : null,
      revoked_reason: row.revoked_reason,
      link_state: dir === 'in'
        ? operatorLinkState(row.snapshot.source_slug, row.source_slug, declared).state
        : 'linked',
    });
  }
  return out;
}

/** Per-source dashboard banner. Declared-but-missing slugs remain visible as
 * dark; active grants contribute their grant-time + current slug pair so a
 * rename is distinguishable from an ordinary unlinked/pending grant. */
export async function shareLinkStates(projectId: string): Promise<OperatorLinkState[]> {
  const db = getPool();
  const mySlug = await projectSlugById(projectId);
  const declared = await linkedProjectsForSlug(mySlug);
  const known = await db.query<{ slug: string }>(
    `SELECT slug FROM projects WHERE slug = ANY($1::text[])`, [declared]
  );
  const currentByDeclared = new Set(known.rows.map((r) => r.slug));
  const pairs = await db.query<{ source_slug: string; current_source_slug: string }>(
    `SELECT DISTINCT s.snapshot->>'source_slug' AS source_slug, p.slug AS current_source_slug
       FROM project_shares s JOIN projects p ON p.id = s.source_project_id
      WHERE s.target_project_id = $1 AND s.status = 'active'`, [projectId]
  );
  const states = new Map<string, { grantSlug: string; currentSlug: string | null }>();
  for (const slug of declared) {
    states.set(slug, { grantSlug: slug, currentSlug: currentByDeclared.has(slug) ? slug : null });
  }
  for (const pair of pairs.rows) {
    if (declared.includes(pair.current_source_slug)) {
      // Intentional post-rename relink: collapse the declared current slug and
      // grant-time slug into one linked banner while retaining rename history.
      states.delete(pair.source_slug);
      states.set(pair.current_source_slug, {
        grantSlug: pair.source_slug, currentSlug: pair.current_source_slug,
      });
    } else {
      states.set(pair.source_slug, {
        grantSlug: pair.source_slug, currentSlug: pair.current_source_slug,
      });
    }
  }
  return [...states.values()].sort((a, b) => a.grantSlug.localeCompare(b.grantSlug)).map(({ grantSlug, currentSlug }) => ({
    source_slug: grantSlug,
    current_source_slug: currentSlug,
    ...operatorLinkState(grantSlug, currentSlug, declared),
  }));
}

export interface ShareEventRow {
  id: string; share_id: string; source_project_id: string; target_project_id: string;
  event: string; source_slug: string; target_slug: string;
  artifact_kind: string; headline: string; actor_surface: string; note: string | null; created_at: string;
}

export interface ShareEventPage { rows: ShareEventRow[]; next_cursor: string | null }
interface EventCursor { createdAt: Date; id: string }

function encodeEventCursor(row: { created_at: Date; id: string }): string {
  return Buffer.from(JSON.stringify([row.created_at.toISOString(), row.id]), 'utf8').toString('base64url');
}

function decodeEventCursor(value: string | undefined): EventCursor | null {
  if (value === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2 ||
        typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string' ||
        !/^[0-9a-f-]{36}$/.test(parsed[1])) throw new Error('shape');
    const createdAt = new Date(parsed[0]);
    if (Number.isNaN(createdAt.getTime())) throw new Error('date');
    return { createdAt, id: parsed[1] };
  } catch {
    throw new Error('invalid audit cursor');
  }
}

export async function shareEventsForProject(
  projectId: string, args: { cursor?: string; limit?: number } = {},
): Promise<ShareEventPage> {
  const cursor = decodeEventCursor(args.cursor);
  const limit = Math.max(1, Math.min(args.limit ?? 100, 100));
  const r = await getPool().query<Omit<ShareEventRow, 'created_at'> & { created_at: Date }>(
    `SELECT id, share_id, source_project_id, target_project_id, event,
            source_slug, target_slug, artifact_kind, headline, actor_surface, note, created_at
       FROM share_events
      WHERE (source_project_id = $1 OR target_project_id = $1)
        AND ($2::timestamptz IS NULL OR created_at < $2
          OR (created_at = $2 AND id < $3::uuid))
      ORDER BY created_at DESC, id DESC LIMIT $4`,
    [projectId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1]
  );
  const pageRows = r.rows.slice(0, limit);
  return {
    rows: pageRows.map((e) => ({ ...e, created_at: e.created_at.toISOString() })),
    next_cursor: r.rows.length > limit && pageRows.length > 0
      ? encodeEventCursor(pageRows[pageRows.length - 1])
      : null,
  };
}

export interface ShareCandidate { kind: ShareKind; id: string | null; path: string | null; repo_root: string | null; headline: string; detail: string }

/** Grant-picker search over THIS project's own artifacts (dashboard). */
export async function shareCandidates(projectId: string, kind: ShareKind, q: string): Promise<ShareCandidate[]> {
  const db = getPool();
  const query = `%${q.trim()}%`;
  if (kind === 'decision') {
    const r = await db.query<{ id: string; description: string; decision_type: string }>(
      `SELECT id, description, decision_type FROM code_decisions
        WHERE project_id = $1 AND still_valid = true AND description ILIKE $2
        ORDER BY timestamp DESC LIMIT 20`, [projectId, query]);
    return r.rows.map((d) => ({ kind, id: d.id, path: null, repo_root: null, headline: headlineField(d.description, 160), detail: d.decision_type }));
  }
  if (kind === 'handoff') {
    const r = await db.query<{ id: string; body: string; type: string; status: string }>(
      `SELECT id, body, type, status FROM agent_messages
        WHERE project_id = $1 AND status NOT IN ('superseded','stale') AND body ILIKE $2
        ORDER BY created_at DESC LIMIT 20`, [projectId, query]);
    return r.rows.map((m) => ({ kind, id: m.id, path: null, repo_root: null, headline: headlineField(m.body, 160), detail: `${m.type} · ${m.status}` }));
  }
  if (kind === 'idea') {
    const r = await db.query<{ id: string; title: string; status: string }>(
      `SELECT id, title, status FROM ideas
        WHERE project_id = $1 AND status <> 'dropped' AND title ILIKE $2
        ORDER BY updated_at DESC LIMIT 20`, [projectId, query]);
    return r.rows.map((i) => ({ kind, id: i.id, path: null, repo_root: null, headline: headlineField(i.title, 160), detail: i.status }));
  }
  const r = await db.query<{ path: string; kind: string; repo_root: string }>(
    `SELECT DISTINCT path, kind, repo_root FROM doc_chunks
      WHERE project_id = $1 AND path ILIKE $2 ORDER BY path, repo_root LIMIT 20`, [projectId, query]);
  // repo_root rides along so the dashboard can share a doc whose relative path
  // exists under two registered roots — buildSnapshot demands the
  // disambiguation and the picker is the only place that knows it.
  return r.rows.map((d) => ({ kind: 'doc', id: null, path: d.path, repo_root: d.repo_root, headline: d.path, detail: d.kind }));
}
