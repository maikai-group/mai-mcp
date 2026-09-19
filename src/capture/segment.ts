// The ONLY implementation of the three boundary rules (spec §3.1). Boundaries
// depend solely on content up to the current entry, so appending can never move
// an earlier boundary — the invariant that makes `<uuid>#<seq>` IDs safe.
export interface TranscriptEntry {
  offset: number;                 // byte offset of this line's start — watermark source
  ts: string | null;              // ISO timestamp when present
  isCompactionBoundary: boolean;  // V1, harness-specific
  thinkingBlocks: number;         // contribution to the V2 running count
  raw: unknown;                   // harness-native record, consumed by parseEntries
}

export interface SegmentationOpts {
  idleGapHours: number;      // T — default 24
  maxThinkingBlocks: number; // V2 ceiling AND summarizer cap — default 150
}

export const SEG_DEFAULTS: SegmentationOpts = { idleGapHours: 24, maxThinkingBlocks: 150 };

export interface Segment {
  seq: number;
  startOffset: number; // byte offset of the segment's first entry
  entries: TranscriptEntry[];
}

export async function* segmentEntries(
  source: AsyncIterable<TranscriptEntry>,
  opts: Partial<SegmentationOpts> & { baseSeq?: number } = {}
): AsyncGenerator<Segment> {
  const idleGapMs = (opts.idleGapHours ?? SEG_DEFAULTS.idleGapHours) * 3_600_000;
  const maxThinking = opts.maxThinkingBlocks ?? SEG_DEFAULTS.maxThinkingBlocks;
  let seq = opts.baseSeq ?? 0;
  let cur: TranscriptEntry[] = [];
  let curThinking = 0;
  let startOffset = 0;
  let lastStampedMs: number | null = null;

  for await (const e of source) {
    const ms = e.ts !== null ? Date.parse(e.ts) : NaN;
    // Exactly one boundary per entry, earliest rule wins; the triggering entry
    // always OPENS the new segment (spec §3.1 boundary placement).
    let boundary = false;
    if (cur.length > 0) {
      if (!Number.isNaN(ms) && lastStampedMs !== null && ms - lastStampedMs >= idleGapMs) {
        boundary = true; // T — negative/missing delta can never reach the threshold
      } else if (e.isCompactionBoundary) {
        boundary = true; // V1 — the marker belongs with what follows
      } else if (curThinking + e.thinkingBlocks > maxThinking) {
        boundary = true; // V2 — ceiling never exceeded; an oversized single entry forms its own segment
      }
    }
    if (boundary) {
      yield { seq, startOffset, entries: cur };
      seq++;
      cur = [];
      curThinking = 0;
    }
    if (cur.length === 0) startOffset = e.offset;
    cur.push(e);
    curThinking += e.thinkingBlocks;
    if (!Number.isNaN(ms)) lastStampedMs = ms; // file order authoritative — update unconditionally
  }
  if (cur.length > 0) yield { seq, startOffset, entries: cur };
}
