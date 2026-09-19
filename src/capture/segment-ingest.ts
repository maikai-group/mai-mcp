// Watermark-driven segmented ingest (spec §3.3–3.4). The ONLY writer of
// transcript_watermarks. Sealed segments are never re-read: incremental runs
// seek straight to open_start_offset.
import fsp from 'node:fs/promises';
import { getPool, getProjectId } from '../db.js';
import { persistParsedSession } from '../scripts/ingest-common.js';
import type { CaptureAdapter } from './adapter.js';
import { segmentEntries, type Segment } from './segment.js';

export interface TranscriptRef {
  path: string;
  /** Base transcript uuid — segments persist as `<transcriptId>#<seq>`. */
  transcriptId: string;
  harness: string;
  cwd?: string | null;
}

export interface SegmentIngestReport {
  status: 'unchanged' | 'ingested' | 'empty' | 'dry-run';
  segmentsPersisted: number;
  segmentsPlanned: number; // dry-run: segments a real run would touch
  fullReingest: boolean;   // true when watermark was absent or discarded (shrink)
}

interface WatermarkRow {
  open_seq: number;
  open_start_offset: string; // bigint comes back as string
  ingested_mtime_ms: string;
  file_size_bytes: string;
}

export async function ingestTranscriptSegmented(
  adapter: CaptureAdapter,
  ref: TranscriptRef,
  opts: { dryRun?: boolean; forceFull?: boolean } = {}
): Promise<SegmentIngestReport> {
  const pool = getPool();
  const projectId = await getProjectId();
  const st = await fsp.stat(ref.path);
  // ceil, not round — sub-ms mtime fractions (ingest-codex.ts's real prior bug).
  const mtimeMs = Math.ceil(st.mtimeMs);
  const sizeBytes = st.size;

  const wmRes = await pool.query<WatermarkRow>(
    `SELECT open_seq, open_start_offset, ingested_mtime_ms, file_size_bytes
       FROM transcript_watermarks WHERE project_id = $1 AND transcript_path = $2`,
    [projectId, ref.path]
  );
  // forceFull (review W1): reingest plans from offset 0 / seq 0 in BOTH dry and
  // wet mode — otherwise a watermark written by the already-live hooks makes the
  // dry-run preview report 0 planned segments for exactly the busiest transcripts.
  let wm = opts.forceFull ? null : (wmRes.rows[0] ?? null);
  let fullReingest = wm === null;

  if (wm && Number(wm.file_size_bytes) > sizeBytes) {
    // Truncated/rewritten (spec §3.4 step 2): discard watermark, drop this
    // transcript's segment rows, full re-ingest. Accepted risk (review W9,
    // deviation 5): curated decisions promoted from these segment rows survive
    // with session_id nulled. starts_with, not LIKE — filename-derived ids can
    // contain `_`, a LIKE wildcard (review W7).
    fullReingest = true;
    if (!opts.dryRun) {
      await pool.query(
        `DELETE FROM code_sessions WHERE project_id = $1 AND starts_with(original_session_id, $2)`,
        [projectId, `${ref.transcriptId}#`]
      );
      await pool.query(
        `DELETE FROM transcript_watermarks WHERE project_id = $1 AND transcript_path = $2`,
        [projectId, ref.path]
      );
    }
    wm = null;
  } else if (wm && Number(wm.ingested_mtime_ms) >= mtimeMs) {
    return { status: 'unchanged', segmentsPersisted: 0, segmentsPlanned: 0, fullReingest: false };
  }

  const fromOffset = wm ? Number(wm.open_start_offset) : 0;
  const baseSeq = wm ? wm.open_seq : 0;
  const segOpts = { ...(adapter.segmentation ?? {}), baseSeq };

  let persisted = 0;
  let planned = 0;
  let last: Segment | null = null;

  const persistOne = async (seg: Segment, sealed: boolean): Promise<void> => {
    planned++;
    if (opts.dryRun) return;
    const parsed = adapter.parseEntries(seg.entries);
    await persistParsedSession(parsed, `${ref.transcriptId}#${seg.seq}`, ref.path);
    await pool.query(
      `UPDATE code_sessions SET metadata = metadata || jsonb_build_object(
         'segment_seq', $2::int, 'segment_sealed', $3::boolean,
         'transcript_path', $4::text, 'harness', $5::text, 'cwd', $6::text)
       WHERE original_session_id = $1 AND project_id = $7`,
      [`${ref.transcriptId}#${seg.seq}`, seg.seq, sealed, ref.path, ref.harness, ref.cwd ?? null, projectId]
    );
    persisted++;
  };

  for await (const seg of segmentEntries(adapter.readEntries(ref.path, fromOffset), segOpts)) {
    if (last) await persistOne(last, true); // a successor exists → sealed
    last = seg;
  }
  if (last) await persistOne(last, false); // trailing segment stays open

  if (!last) {
    return { status: opts.dryRun ? 'dry-run' : 'empty', segmentsPersisted: 0, segmentsPlanned: 0, fullReingest };
  }
  if (!opts.dryRun) {
    await pool.query(
      `INSERT INTO transcript_watermarks
         (project_id, transcript_path, harness, open_seq, open_start_offset, ingested_mtime_ms, file_size_bytes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (project_id, transcript_path) DO UPDATE SET
         harness = EXCLUDED.harness, open_seq = EXCLUDED.open_seq,
         open_start_offset = EXCLUDED.open_start_offset,
         ingested_mtime_ms = EXCLUDED.ingested_mtime_ms,
         file_size_bytes = EXCLUDED.file_size_bytes, updated_at = now()`,
      [projectId, ref.path, ref.harness, last.seq, last.startOffset, mtimeMs, sizeBytes]
    );
    if (opts.forceFull) {
      // A forced full run can yield FEWER segments than prior incremental
      // history (rare: unstamped leading entries shift the T-gap baseline).
      // Upserts covered seqs 0..last; higher seqs are stale — remove (pass-3 W2).
      await pool.query(
        `DELETE FROM code_sessions
          WHERE project_id = $1 AND starts_with(original_session_id, $2)
            AND (metadata->>'segment_seq')::int > $3`,
        [projectId, `${ref.transcriptId}#`, last.seq]
      );
    }
  }
  return { status: opts.dryRun ? 'dry-run' : 'ingested', segmentsPersisted: persisted, segmentsPlanned: planned, fullReingest };
}
