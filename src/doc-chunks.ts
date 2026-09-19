// Auto-ingested plan/spec doc chunks (plan 20, spec 2026-08-11-auto-ingest-
// plans-design.md). Chunks are DERIVED content: the doc on disk stays
// authoritative; recall serves POINTERS (path:line + heading trail + excerpt),
// never full bodies. Write-gate interaction: none — chunks assert nothing
// (spec §8), provenance is the doc itself.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getPool } from './db.js';
// Type-only: this file builds sections, it never budgets them (the caller does).
import type { ReadSection } from './read-budget.js';

export const CHUNK_CHAR_CAP = 1500;

export type DocKind = 'plan' | 'spec';

export interface DocChunk {
  startLine: number; // 1-based, inclusive
  endLine: number;   // 1-based, inclusive
  headingTrail: string;
  content: string;
  contentHash: string;
}

function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Passage text for a chunk — ONE definition shared by the write path
 * (rechunkDoc) and `mai embed --rebuild` (they must match or rebuilt vectors
 * score differently from fresh ones — the embed-rebuild findings precedent).
 * Stored passages use RAW embed(), never embedQuery(): the BGE instruction
 * prefix is retrieval-only (plan 14). */
export function chunkPassage(headingTrail: string, content: string): string {
  return headingTrail ? `${headingTrail}\n${content}` : content;
}

interface Section {
  startLine: number; // 1-based doc line of the section's first line
  lines: string[];
  trail: string;
}

interface Para {
  start: number; // index within the section's lines
  lines: string[];
}

/** Maximal runs of non-blank lines; trailing blank lines attach to the
 * preceding paragraph so pieces TILE the section (no orphaned line ranges). */
function splitParas(lines: string[]): Para[] {
  const paras: Para[] = [];
  let cur: Para | null = null;
  let blankRun = false;
  for (let i = 0; i < lines.length; i++) {
    const blank = lines[i].trim() === '';
    if (!cur) {
      cur = { start: i, lines: [lines[i]] };
      paras.push(cur);
      blankRun = blank;
      continue;
    }
    if (blank) {
      cur.lines.push(lines[i]);
      blankRun = true;
      continue;
    }
    if (blankRun) {
      cur = { start: i, lines: [lines[i]] };
      paras.push(cur);
      blankRun = false;
      continue;
    }
    cur.lines.push(lines[i]);
  }
  return paras;
}

/**
 * Split markdown into heading-bounded chunks (spec §4): `##`/`###` open a new
 * section (tasks, requirement blocks, spec sections); `#` only seeds the trail
 * root and never splits. Heading-looking lines INSIDE fenced code blocks never
 * split — plan docs quote entire task templates in fences. Oversize sections
 * split at paragraph boundaries under CHUNK_CHAR_CAP; a single paragraph over
 * the cap splits at line boundaries; a single LINE over the cap stays whole
 * (chunks must map to real line ranges — the path:line pointer contract
 * outranks the approximate cap). Deterministic: same input → identical chunks
 * incl. hashes (doc_sha staleness diffing depends on it).
 */
export function chunkMarkdown(text: string): DocChunk[] {
  const lines = text.split('\n');
  const sections: Section[] = [];
  let h1 = '';
  let h2 = '';
  let cur: Section | null = null;
  let fence: { marker: string; length: number } | null = null;

  const open = (startLine: number, trail: string): Section => {
    const s: Section = { startLine, lines: [], trail };
    sections.push(s);
    return s;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence === null) {
      // CommonMark §4.5 opener: at most 3 leading spaces. Backtick info
      // strings cannot themselves contain a backtick.
      const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (opener && (opener[1][0] === '~' || !opener[2].includes('`'))) {
        fence = { marker: opener[1][0], length: opener[1].length };
      }
    } else {
      // CommonMark §4.5 closer: same marker, at least opening length, at most
      // 3 leading spaces, and ONLY spaces/tabs after the run. A line such as
      // ````not-a-close is code content (finding 558a072a).
      const closer = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (
        closer && closer[1][0] === fence.marker && closer[1].length >= fence.length
      ) fence = null;
    }
    // Headings match only OUTSIDE fences. Subtlety (test-pinned by the fence
    // case): a line that OPENS a fence has already set `fence` non-null above,
    // and a backtick line can never match /^#{1,3}\s/ anyway — so nothing on
    // or inside a fence line ever splits.
    const heading = fence === null ? /^(#{1,3})\s+(.*)$/.exec(line) : null;
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].trim();
      const blankPreamble =
        cur !== null && sections.length === 1 && cur.lines.every((l) => l.trim() === '');
      if (level === 1) {
        h1 = title; // trail root only — no boundary
        if (blankPreamble && cur) cur.trail = title;
      } else if (level === 2) {
        h2 = title;
        if (blankPreamble && cur) cur.trail = title;
        else cur = open(i + 1, title);
        cur.lines.push(line);
        continue;
      } else {
        const trail = h2 ? `${h2} > ${title}` : title;
        if (blankPreamble && cur) cur.trail = trail;
        else cur = open(i + 1, trail);
        cur.lines.push(line);
        continue;
      }
    }
    if (!cur) cur = open(i + 1, h1 || '(preamble)');
    cur.lines.push(line);
  }

  const chunks: DocChunk[] = [];
  const emit = (startLine: number, trail: string, pieceLines: string[]): void => {
    const content = pieceLines.join('\n');
    // Even a wholly blank doc needs one exact tiled row: doc_sha staleness is
    // stored on chunk rows, so dropping it would reprocess the unchanged file
    // on every sweep (finding 56df5a70). chunkPassage adds `(preamble)`, giving
    // the embedder non-empty passage text; lexical recall will not match blanks.
    chunks.push({
      startLine,
      endLine: startLine + pieceLines.length - 1,
      headingTrail: trail,
      content,
      contentHash: sha256(content),
    });
  };

  const joinedLen = (ls: string[]): number => ls.reduce((n, l) => n + l.length, 0) + Math.max(0, ls.length - 1);

  for (const s of sections) {
    const paras = splitParas(s.lines);
    // Greedy paragraph packing under the cap; an oversize single paragraph
    // splits at line boundaries (lines stay atomic).
    let acc: Para | null = null;
    const pieces: Para[] = [];
    for (const p of paras) {
      const pLen = joinedLen(p.lines);
      if (acc && joinedLen(acc.lines) + 1 + pLen <= CHUNK_CHAR_CAP) {
        acc.lines.push(...p.lines);
        continue;
      }
      acc = null;
      if (pLen <= CHUNK_CHAR_CAP) {
        acc = { start: p.start, lines: [...p.lines] };
        pieces.push(acc);
        continue;
      }
      let sub: Para | null = null;
      for (let j = 0; j < p.lines.length; j++) {
        const l = p.lines[j];
        // splitParas attaches trailing blanks to the paragraph. When the
        // preceding atomic line already exceeds the approximate cap, keep
        // those blanks with it rather than creating a blank-only piece that
        // emit() would discard (finding cc05a5c5).
        if (sub && l.trim() === '') {
          sub.lines.push(l);
          continue;
        }
        if (sub && joinedLen(sub.lines) + 1 + l.length <= CHUNK_CHAR_CAP) {
          sub.lines.push(l);
          continue;
        }
        sub = { start: p.start + j, lines: [l] };
        pieces.push(sub);
      }
    }
    for (const piece of pieces) emit(s.startLine + piece.start, s.trail, piece.lines);
  }
  return chunks;
}

// ---------- DB lifecycle (delete-and-rechunk per doc, atomic) ----------

export interface RechunkArgs {
  projectId: string;
  /** Realpath'd registered root this doc's path is relative to — half of the
   * identity key (plan-20 finding 2481fa65; ambiguity 1). For anything inside
   * the project root this IS the project root, which keeps `path` identical to
   * plans.path and to single-root behaviour. */
  repoRoot: string;
  /** Path relative to repoRoot — the other half of the doc_chunks identity key
   * (same contract as plans.path under the project root). */
  path: string;
  /** Resolved absolute path. The CALLER owns containment — everything routes
   * through plans.ts's resolvePlanPath / resolveUnderRoot (per-root containment
   * + symlink safety). */
  absPath: string;
  kind: DocKind;
  planId?: string | null;
}

export interface RechunkResult {
  status: 'chunked' | 'unchanged';
  chunks: number;
  docSha: string;
}

/**
 * Chunk + embed one doc. Unchanged doc (same doc_sha) short-circuits without
 * touching rows — EXCEPT to attach a late-arriving plan_id to chunks the sweep
 * wrote before the plan was registered. Changed doc: embeddings are computed
 * OUTSIDE the transaction (the reviewPost ordering rule — a cold local model
 * costs up to 20s and BEGIN must stay clear of
 * idle_in_transaction_session_timeout), then DELETE + INSERT commit atomically
 * per doc (spec §4): readers never see a half-replaced doc. embed() → null
 * (disabled/failed tier) is fine — the row lands unembedded, the trigram lane
 * still finds it, and `mai embed --rebuild` back-fills.
 */
export async function rechunkDoc(args: RechunkArgs): Promise<RechunkResult> {
  const buf = await fs.readFile(args.absPath); // loud ENOENT propagates — callers decide
  const docSha = sha256(buf);
  const pool = getPool();
  const existing = await pool.query<{ doc_sha: string }>(
    `SELECT doc_sha FROM doc_chunks
      WHERE project_id = $1 AND repo_root = $2 AND path = $3 LIMIT 1`,
    [args.projectId, args.repoRoot, args.path]
  );
  if (existing.rows[0]?.doc_sha === docSha) {
    if (args.planId) {
      // Self-healing on BOTH columns (finding abdf0cd3): the caller resolves
      // kind per file with tracker identity winning, so an existing row that
      // disagrees is stale labelling — correct it here rather than leaving a
      // registered plan tagged 'spec' forever on the unchanged path.
      await pool.query(
        `UPDATE doc_chunks SET plan_id = $4, kind = $5
          WHERE project_id = $1 AND repo_root = $2 AND path = $3
            AND (plan_id IS DISTINCT FROM $4 OR kind IS DISTINCT FROM $5)`,
        [args.projectId, args.repoRoot, args.path, args.planId, args.kind]
      );
    }
    return { status: 'unchanged', chunks: 0, docSha };
  }
  const chunks = chunkMarkdown(buf.toString('utf8'));
  const { embed, currentEmbeddingModelId } = await import('./embeddings.js');
  const vecs: Array<number[] | null> = [];
  for (const c of chunks) vecs.push(await embed(chunkPassage(c.headingTrail, c.content)));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM doc_chunks WHERE project_id = $1 AND repo_root = $2 AND path = $3`,
      [args.projectId, args.repoRoot, args.path]
    );
    for (const [i, c] of chunks.entries()) {
      const vec = vecs[i];
      await client.query(
        `INSERT INTO doc_chunks
           (project_id, plan_id, kind, repo_root, path, doc_sha, chunk_index, start_line, end_line,
            heading_trail, content, content_hash, embedding, embedding_model)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          args.projectId, args.planId ?? null, args.kind, args.repoRoot, args.path, docSha, i,
          c.startLine, c.endLine, c.headingTrail, c.content, c.contentHash,
          vec, vec ? currentEmbeddingModelId() : null,
        ]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { status: 'chunked', chunks: chunks.length, docSha };
}

/** Sweep a deleted doc's chunks (derived data — always safe to drop). Keyed by
 * the full identity (repo_root + path): the same relative path can exist under
 * two registered roots (finding 2481fa65). */
export async function deleteDocChunks(
  projectId: string,
  repoRoot: string,
  docPath: string
): Promise<number> {
  const r = await getPool().query(
    `DELETE FROM doc_chunks WHERE project_id = $1 AND repo_root = $2 AND path = $3`,
    [projectId, repoRoot, docPath]
  );
  return r.rowCount ?? 0;
}

// ---------- recall: the pointer section for mai_search / mai_prime ----------

/** Hard cap (spec §6): top 3 pointers, independent of the caller's limit. */
const CHUNK_POINTER_CAP = 3;
/** ~2 lines' worth of excerpt. */
const EXCERPT_CHARS = 160;

interface ChunkHit {
  repo_root: string;
  path: string;
  start_line: number;
  end_line: number;
  heading_trail: string;
  content: string;
}

/** Pointer path (finding 2481fa65): rows stored under the project root render
 * repo-relative — the path an agent already types, byte-identical to
 * single-root behaviour. A row from a registered repo OUTSIDE that root renders
 * ABSOLUTE, because a bare relative path there points nowhere. */
function pointerPath(h: ChunkHit, projectRoot: string | null): string {
  return projectRoot && h.repo_root === projectRoot ? h.path : path.join(h.repo_root, h.path);
}

function excerpt(content: string): string {
  // Drop the heading line itself (the trail already carries it), collapse
  // whitespace, cap at ~2 lines. The pointer IS the product — never render
  // full bodies (spec §6); the agent opens the doc at the line when needed.
  const body = content.replace(/^#{2,3}\s[^\n]*\n?/, '');
  const flat = (body.trim() === '' ? content : body).replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS).trimEnd()}…` : flat;
}

/** `staleFrom` = index where the stale-bucket hits begin (they carry the
 * rebuild remedy); pass hits.length for an unlabeled (state 1/3) render —
 * labeling a cosine-rejected CURRENT-model row "not re-embedded" would be a
 * lie, so trigram-only states never label. */
/** The trailing newline deliberately preserves today's blank line before the
 * first pointer, in BOTH the string wrapper and budgetSections. */
const DOC_POINTER_HEADING =
  '## Plan/spec docs (pointers — open the file at the line; bodies are not repeated here)\n';

function pointerRows(hits: ChunkHit[], staleFrom: number, projectRoot: string | null): string[] {
  return hits.map((h, i) => {
    const stale = i >= staleFrom ? ' · text match (not re-embedded — mai embed --rebuild)' : '';
    return `- ${pointerPath(h, projectRoot)}:${h.start_line}-${h.end_line} · ${h.heading_trail || '(preamble)'} · ${excerpt(h.content)}${stale}`;
  });
}

/** A doc pointer is ALREADY the complete product — there is no body to omit —
 * so the full and headline arrays are byte-identical by construction. */
function pointerSection(
  hits: ChunkHit[], staleFrom: number, projectRoot: string | null,
): ReadSection | null {
  if (hits.length === 0) return null;
  const rows = pointerRows(hits, staleFrom, projectRoot);
  return { heading: DOC_POINTER_HEADING, fullRows: rows, headlineRows: [...rows] };
}

/** Trigram lane. word_similarity, NOT the house similarity() idiom: chunk
 * content is up to ~1,500 chars where whole-string similarity collapses —
 * measured 2026-08-12: exact phrase in a ~330-char chunk scores 0.223 via
 * similarity() but 1.000 via word_similarity(); no-overlap noise sits at
 * ~0.05. Threshold 0.3 separates cleanly. staleForModel mirrors
 * trgmDecisionHits' `$n IS NULL OR` idiom: null = all rows; a model id =
 * stale/untagged rows only. */
async function trgmChunkHits(
  query: string,
  projectId: string,
  staleForModel: string | null,
  limit: number
): Promise<ChunkHit[]> {
  const r = await getPool().query<ChunkHit>(
    `SELECT repo_root, path, start_line, end_line, heading_trail, content
       FROM doc_chunks
      WHERE project_id = $1
        AND ($4::text IS NULL OR embedding_model IS DISTINCT FROM $4)
        AND word_similarity($2, content) >= 0.3
      ORDER BY word_similarity($2, content) DESC
      LIMIT $3`,
    [projectId, query, limit, staleForModel]
  );
  return r.rows;
}

/**
 * Doc-chunk pointer section for mai_search / mai_prime. Returns null when
 * nothing matches — the section is omitted entirely (pointers must never cost
 * tokens when they have nothing to point at). No new tool (spec §6): this
 * lives inside the reads trained habit already hits.
 *
 * THREE-STATE HYBRID RETRIEVAL (lesson 8712fd38 — the plan-14 R4 closed state
 * model, named here so reviewers find it; decisionsSimilarOrTrgm and
 * findingsQuery are the two shipped precedents):
 *   state 1 — semantic unavailable (disabled / no provider / query embed
 *     failed) → trigram over ALL rows;
 *   state 2 — semantic hits exist → current-tag cosine hits PLUS a separate
 *     trigram pass over stale/untagged rows, merged under ONE budget
 *     (budgetHybridHits: one stale slot reserved at limit ≥ 2, so a mixed
 *     corpus cannot hide rebuild debt);
 *   state 3 — semantic available but ZERO hits above threshold → trigram over
 *     ALL rows (the all-row rescue: a stale text hit must never suppress the
 *     rescue of a lexically matching current-model row that cosine rejected).
 */
export async function docChunksReadSection(
  query: string, projectId: string,
): Promise<ReadSection | null> {
  const { embedQuery, embeddingsEnabled, cosineSim, currentEmbeddingModelId, budgetHybridHits } =
    await import('./embeddings.js');
  const modelId = embeddingsEnabled() ? currentEmbeddingModelId() : null;
  const queryVec = modelId ? await embedQuery(query) : null;
  // The project root decides how each pointer renders (repo-relative inside it,
  // absolute for a registered repo outside it — finding 2481fa65).
  const { projectRootReal } = await import('./plans.js');
  const projectRoot = await projectRootReal(projectId);
  if (!modelId || !queryVec) {
    // state 1
    const hits = await trgmChunkHits(query, projectId, null, CHUNK_POINTER_CAP);
    return pointerSection(hits, hits.length, projectRoot);
  }
  const current = await getPool().query<ChunkHit & { embedding: number[] }>(
    `SELECT repo_root, path, start_line, end_line, heading_trail, content, embedding
       FROM doc_chunks
      WHERE project_id = $1 AND embedding IS NOT NULL AND embedding_model = $2`,
    [projectId, modelId]
  );
  const scored = current.rows
    .map((c) => ({ c, sim: cosineSim(queryVec, c.embedding) }))
    .filter((s) => s.sim >= 0.25)
    .sort((a, b) => b.sim - a.sim)
    .map((s) => s.c);
  if (scored.length === 0) {
    // state 3 — all-row rescue, fires BEFORE the stale bucket is ever queried
    const all = await trgmChunkHits(query, projectId, null, CHUNK_POINTER_CAP);
    return pointerSection(all, all.length, projectRoot);
  }
  // state 2
  const stale = await trgmChunkHits(query, projectId, modelId, CHUNK_POINTER_CAP);
  const sel = budgetHybridHits(scored, stale, CHUNK_POINTER_CAP);
  const merged = [...sel.semantic, ...sel.stale];
  return pointerSection(merged, sel.semantic.length, projectRoot);
}

/** The byte-identical string wrapper prime/direct callers already use. */
export async function docChunksSection(query: string, projectId: string): Promise<string | null> {
  const section = await docChunksReadSection(query, projectId);
  return section ? `${section.heading}\n${section.fullRows.join('\n')}` : null;
}
