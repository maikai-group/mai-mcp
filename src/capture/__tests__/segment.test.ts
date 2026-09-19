/** Boundary rules T/V1/V2, placement semantics, degenerate inputs, and the
 * prefix-stability invariant (spec §6). Plus byte-offset reader correctness. */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLinesWithOffsets } from '../lines.js';
import { segmentEntries, type TranscriptEntry } from '../segment.js';

function entry(over: Partial<TranscriptEntry>): TranscriptEntry {
  return { offset: 0, ts: null, isCompactionBoundary: false, thinkingBlocks: 0, raw: null, ...over };
}
async function* iter(list: TranscriptEntry[]): AsyncGenerator<TranscriptEntry> {
  for (const e of list) yield e;
}
async function collect(list: TranscriptEntry[], opts = {}) {
  const out = [];
  for await (const s of segmentEntries(iter(list), opts)) out.push(s);
  return out;
}
const T0 = Date.parse('2026-08-01T00:00:00Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
const H = 3_600_000;

describe('readLinesWithOffsets', () => {
  it('returns true byte offsets, resumable mid-file, multi-byte safe', async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mai-lines-')), 't.jsonl');
    const lines = ['{"a":1}', '{"emoji":"🌊🌊"}', '{"b":2}'];
    fs.writeFileSync(f, lines.join('\n') + '\n');
    const got: { offset: number; text: string }[] = [];
    for await (const l of readLinesWithOffsets(f)) got.push(l);
    expect(got.map((g) => g.text)).toEqual(lines);
    // Offsets must be byte-exact: re-reading from offset N yields the same tail.
    const tail: string[] = [];
    for await (const l of readLinesWithOffsets(f, got[1].offset)) tail.push(l.text);
    expect(tail).toEqual(lines.slice(1));
    expect(got[2].offset).toBe(Buffer.byteLength(lines[0] + '\n' + lines[1] + '\n', 'utf8'));
  });
  it('yields a final line with no trailing newline', async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mai-lines-')), 't2.jsonl');
    fs.writeFileSync(f, '{"a":1}\n{"b":2}');
    const got: string[] = [];
    for await (const l of readLinesWithOffsets(f)) got.push(l.text);
    expect(got).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe('segmentEntries — boundary rules', () => {
  it('T: 25h gap splits, 23h gap does not', async () => {
    const gap25 = await collect([entry({ ts: at(0) }), entry({ ts: at(25 * H) })]);
    expect(gap25.map((s) => s.entries.length)).toEqual([1, 1]);
    const gap23 = await collect([entry({ ts: at(0) }), entry({ ts: at(23 * H) })]);
    expect(gap23.map((s) => s.entries.length)).toEqual([2]);
  });
  it('V1: compaction marker opens the new segment', async () => {
    const segs = await collect([
      entry({ ts: at(0) }),
      entry({ ts: at(1), isCompactionBoundary: true }),
      entry({ ts: at(2) }),
    ]);
    expect(segs.map((s) => s.entries.length)).toEqual([1, 2]);
    expect(segs[1].entries[0].isCompactionBoundary).toBe(true); // marker belongs with what follows
  });
  it('V2: the entry that would exceed the ceiling opens the new segment', async () => {
    const segs = await collect(
      [entry({ thinkingBlocks: 100 }), entry({ thinkingBlocks: 50 }), entry({ thinkingBlocks: 1 })],
      { maxThinkingBlocks: 150 }
    );
    // 100+50 = 150 fits; +1 would exceed → third entry opens seq 1.
    expect(segs.map((s) => s.entries.length)).toEqual([2, 1]);
  });
  it('V2: a single oversized entry forms its own segment (no infinite loop)', async () => {
    const segs = await collect(
      [entry({ thinkingBlocks: 10 }), entry({ thinkingBlocks: 999 }), entry({ thinkingBlocks: 10 })],
      { maxThinkingBlocks: 150 }
    );
    expect(segs.map((s) => s.entries.length)).toEqual([1, 1, 1]);
  });
  it('interaction: earliest rule wins, exactly one boundary per entry', async () => {
    const segs = await collect(
      [
        entry({ ts: at(0), thinkingBlocks: 149 }),
        // 25h gap AND compaction AND would-exceed — still exactly one split.
        entry({ ts: at(25 * H), isCompactionBoundary: true, thinkingBlocks: 10 }),
      ],
      { maxThinkingBlocks: 150 }
    );
    expect(segs.length).toBe(2);
  });
  it('degenerate: empty source → no segments; single entry → one; marker-first → one (no empty leading)', async () => {
    expect(await collect([])).toEqual([]);
    expect((await collect([entry({})])).length).toBe(1);
    const markerFirst = await collect([entry({ isCompactionBoundary: true }), entry({})]);
    expect(markerFirst.map((s) => s.entries.length)).toEqual([2]);
  });
  it('no timestamps at all → one segment (T never fires)', async () => {
    const segs = await collect([entry({}), entry({}), entry({})]);
    expect(segs.length).toBe(1);
  });
  it('clock skew: out-of-order timestamps never split', async () => {
    const segs = await collect([entry({ ts: at(48 * H) }), entry({ ts: at(0) }), entry({ ts: at(1) })]);
    expect(segs.length).toBe(1);
  });
  it('unstamped entries pass through the gap calculation (T uses last STAMPED)', async () => {
    const segs = await collect([entry({ ts: at(0) }), entry({}), entry({ ts: at(25 * H) })]);
    expect(segs.map((s) => s.entries.length)).toEqual([2, 1]);
  });
  it('startOffset is the first entry of each segment; baseSeq offsets seq', async () => {
    const segs = await collect(
      [entry({ offset: 0, ts: at(0) }), entry({ offset: 77, ts: at(25 * H) })],
      { baseSeq: 4 }
    );
    expect(segs.map((s) => [s.seq, s.startOffset])).toEqual([[4, 0], [5, 77]]);
  });
  it('STABILITY: prefix boundaries equal full-file boundaries (sealed segments)', async () => {
    // Random-ish but deterministic mix of gaps, markers, and thinking loads.
    const entries: TranscriptEntry[] = [];
    let t = 0;
    for (let i = 0; i < 200; i++) {
      t += (i * 7919) % 3 === 0 ? 26 * H : 1000;
      entries.push(
        entry({
          offset: i * 100,
          ts: (i * 104729) % 5 === 0 ? null : at(t),
          isCompactionBoundary: (i * 15485863) % 41 === 0,
          thinkingBlocks: (i * 32452843) % 7,
        })
      );
    }
    const full = await collect(entries, { maxThinkingBlocks: 10 });
    for (const cut of [50, 120, 199]) {
      const prefix = await collect(entries.slice(0, cut), { maxThinkingBlocks: 10 });
      // Every sealed segment of the prefix run must match the full run exactly.
      for (let i = 0; i < prefix.length - 1; i++) {
        expect(prefix[i].startOffset).toBe(full[i].startOffset);
        expect(prefix[i].entries.length).toBe(full[i].entries.length);
      }
    }
  });
});

describe('adapter readEntries/parseEntries', () => {
  const claudeFx = fileURLToPath(new URL('./fixtures/seg-claude.jsonl', import.meta.url));
  const codexFx = fileURLToPath(new URL('./fixtures/seg-codex.jsonl', import.meta.url));

  it('claude-code: parseEntries(readEntries(all)) ≡ parseTranscript (parity)', async () => {
    const { ClaudeCodeAdapter } = await import('../claude-code.js');
    const a = new ClaudeCodeAdapter();
    const entries = [];
    for await (const e of a.readEntries(claudeFx)) entries.push(e);
    const viaEntries = a.parseEntries(entries);
    const viaWhole = await a.parseTranscript(claudeFx);
    expect(viaEntries).toEqual(viaWhole);
    expect(viaEntries.thinkingBlocks.length).toBe(3); // fixture lines 2, 3, 6
    expect(entries.reduce((n, e) => n + e.thinkingBlocks, 0)).toBe(3); // count matches push
    expect(entries.filter((e) => e.isCompactionBoundary).length).toBe(1);
  });

  it('codex: parity + compaction + reasoning counts', async () => {
    const { CodexAdapter } = await import('../codex.js');
    const a = new CodexAdapter();
    const entries = [];
    for await (const e of a.readEntries(codexFx)) entries.push(e);
    const viaEntries = a.parseEntries(entries);
    const viaWhole = await a.parseTranscript(codexFx);
    expect(viaEntries).toEqual(viaWhole);
    expect(viaEntries.harness).toBe('codex');
    expect(entries.filter((e) => e.isCompactionBoundary).length).toBe(1);
    expect(entries.reduce((n, e) => n + e.thinkingBlocks, 0)).toBe(2);
  });

  it('claude fixture segments as T-then-V1 (3 segments)', async () => {
    const { ClaudeCodeAdapter } = await import('../claude-code.js');
    const a = new ClaudeCodeAdapter();
    const segs = [];
    for await (const s of segmentEntries(a.readEntries(claudeFx))) segs.push(s);
    expect(segs.map((s) => s.entries.length)).toEqual([3, 1, 2]); // gap splits, then marker opens seg 2
  });

  it('generic sniffs both formats', async () => {
    const { GenericAdapter } = await import('../generic.js');
    const g = new GenericAdapter();
    const viaGenericCodex = [];
    for await (const e of g.readEntries(codexFx)) viaGenericCodex.push(e);
    expect(g.parseEntries(viaGenericCodex).harness).toBe('codex');
    const viaGenericClaude = [];
    for await (const e of g.readEntries(claudeFx)) viaGenericClaude.push(e);
    expect(g.parseEntries(viaGenericClaude).harness).toBeUndefined(); // claude legacy shape
  });
});

describe('middleTrim', () => {
  it('keeps head and tail', async () => {
    const { middleTrim } = await import('../../summarize.js');
    const arr = Array.from({ length: 10 }, (_, i) => i);
    expect(middleTrim(arr, 4)).toEqual([0, 1, 8, 9]);
    expect(middleTrim(arr, 10)).toEqual(arr);
    expect(middleTrim(arr, 3)).toEqual([0, 1, 9]);
  });
});
