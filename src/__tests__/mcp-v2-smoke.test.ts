/** Plan 18 both-era smoke: the built server must serve a genuine 2025-era
 * client (legacy shim) AND a 2026-07-28-pinned client (cache hints on the
 * wire). DB is deliberately unreachable (port 1 → instant ECONNREFUSED): every
 * case here is DB-free by design, and the piggyback heartbeat's failure is
 * silent-by-contract — this keeps the smoke off the live brain entirely
 * (lesson 63fb332c: no read verb is write-free against a real DB).
 *
 * Era modes are pinned explicitly — never 'auto' (auto's FALLBACK is the
 * nondeterminism; note both auto and pin probe server/discover on a
 * short-lived sibling process, so the server boots twice per modern connect —
 * harmless here by the DB-free design). The typed v2 client strips ONLY the
 * wire-only field (resultType) — ttlMs/cacheScope ARE exposed on the typed
 * result — and resultType alone is why the modern assertions tee RAW frames
 * off the transport (onmessage wrap AFTER connect — connect assigns it). */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport as LegacyStdio } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client as ModernClient } from '@modelcontextprotocol/client';
import { StdioClientTransport as ModernStdio } from '@modelcontextprotocol/client/stdio';

const SERVER = fileURLToPath(new URL('../../build/index.js', import.meta.url));
// Built explicitly as Record<string,string> — both stdio transports type env
// without undefined, so spreading process.env would be a type error. PATH is
// required so the transports can resolve `node`.
const SPAWN_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? '',
  MAI_PROJECT_SLUG: 'v2-smoke',
  MAI_DB_URL: 'postgresql://postgres:postgres@127.0.0.1:1/unreachable',
};

interface ListToolsFrame {
  result: { ttlMs: number; cacheScope: string; resultType: string; tools: unknown[] };
}
// Cast-free guard (global lesson 293a39bc): `in`-operator narrowing gives typed
// property access on `object` — no `as` anywhere in this file.
function isListToolsFrame(msg: unknown): msg is ListToolsFrame {
  if (typeof msg !== 'object' || msg === null || !('result' in msg)) return false;
  const r = msg.result;
  if (typeof r !== 'object' || r === null || !('tools' in r)) return false;
  return (
    Array.isArray(r.tools) &&
    'ttlMs' in r && typeof r.ttlMs === 'number' &&
    'cacheScope' in r && typeof r.cacheScope === 'string' &&
    'resultType' in r && typeof r.resultType === 'string'
  );
}
// Extracts the first text-content entry's text, or '' — no content cast.
function firstText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const first: unknown = content[0];
  if (typeof first !== 'object' || first === null || !('text' in first)) return '';
  return typeof first.text === 'string' ? first.text : '';
}
function isParityBaseline(v: unknown): v is { tools: unknown; call: unknown } {
  return typeof v === 'object' && v !== null && 'tools' in v && 'call' in v;
}
// Base frame guard: any JSON-RPC response whose result carries a tools array —
// used by the LEGACY raw-frame leak check (which asserts 2026 fields ABSENT),
// while isListToolsFrame above requires them PRESENT (the modern check).
function isToolsFrame(msg: unknown): msg is { result: { tools: unknown[] } } {
  if (typeof msg !== 'object' || msg === null || !('result' in msg)) return false;
  const r = msg.result;
  return typeof r === 'object' && r !== null && 'tools' in r && Array.isArray(r.tools);
}

describe('mcp v2 both-era smoke', () => {
  it('legacy 2025-era client: handshake, deterministic tools/list, NO 2026 wire fields, DB-free call path', async () => {
    const client = new LegacyClient({ name: 'legacy-smoke', version: '0.0.0' });
    const transport = new LegacyStdio({ command: 'node', args: [SERVER], env: SPAWN_ENV });
    await client.connect(transport);
    try {
      const frames: unknown[] = [];
      const prev = transport.onmessage;
      transport.onmessage = (msg) => { frames.push(msg); prev?.(msg); };
      const first = await client.listTools();
      const second = await client.listTools();
      // R5 second clause, gated on the ONE method that carries the new fields
      // (pass-11 aab7bb68/9c30acd4): the legacy RAW tools/list frame must not
      // leak 2026-only wire fields through the shim.
      const raw = frames.find(isToolsFrame);
      if (!raw) throw new Error('legacy raw tools/list frame not captured');
      expect('ttlMs' in raw.result).toBe(false);
      expect('cacheScope' in raw.result).toBe(false);
      expect('resultType' in raw.result).toBe(false);
      // 39 today = 35 core + 4 coordination; >35 pins "full core set plus
      // coordination present" without brittleness across tool additions (B1)
      expect(first.tools.length).toBeGreaterThan(35);
      expect(first.tools.map((t) => t.name)).toContain('mai_prime');
      // R4 determinism pin: consecutive lists byte-identical
      expect(JSON.stringify(second.tools)).toBe(JSON.stringify(first.tools));
      // DB-free call path end-to-end: unknown tool returns a self-describing
      // error result (never a protocol error, never a DB touch)
      const out = await client.callTool({ name: 'not_a_real_tool', arguments: {} });
      expect(firstText(out.content)).toMatch(/unknown tool|not_a_real_tool/i);
    } finally {
      await client.close();
    }
  }, 20_000);

  // Pass-2 B2: swap-parity gate. The fixture is frozen from the PRE-swap build
  // (Task 1 Step 3) and asserts the post-swap legacy surface is value-identical
  // — determinism alone only compares the new server with itself. One-shot
  // migration gate: Task 3 deletes the fixture (future tool additions would
  // legitimately invalidate a byte-frozen baseline) and this case then skips.
  const PARITY_FIXTURE = fileURLToPath(new URL('./fixtures/legacy-parity.json', import.meta.url));
  it.skipIf(!existsSync(PARITY_FIXTURE))('legacy parity vs frozen pre-swap baseline (one-shot swap gate)', async () => {
    const parsed: unknown = JSON.parse(readFileSync(PARITY_FIXTURE, 'utf8'));
    if (!isParityBaseline(parsed)) throw new Error('parity fixture malformed — regenerate via Task 1 Step 3');
    const baseline = parsed;
    const client = new LegacyClient({ name: 'parity-smoke', version: '0.0.0' });
    await client.connect(new LegacyStdio({ command: 'node', args: [SERVER], env: SPAWN_ENV }));
    try {
      const tools = await client.listTools();
      const call = await client.callTool({ name: 'not_a_real_tool', arguments: {} });
      // WHOLE-result parity on BOTH methods (pass-11 9c30acd4: comparing only
      // tools.tools discarded the tools/list wrapper — the exact place a
      // leaked ttlMs/cacheScope/resultType would appear, since sdk 1.x parses
      // with a loose schema that preserves unknown top-level fields). JSON-RPC
      // envelope/ids are client-normalized on both sides. R5 = value parity.
      expect(tools).toEqual(baseline.tools);
      expect(call).toEqual(baseline.call);
    } finally {
      await client.close();
    }
  }, 20_000);

  it('modern 2026-07-28-pinned client: negotiation succeeds, cache hints + resultType on the raw wire', async () => {
    const client = new ModernClient(
      { name: 'modern-smoke', version: '0.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );
    const transport = new ModernStdio({ command: 'node', args: [SERVER], env: SPAWN_ENV });
    await client.connect(transport); // RED pre-swap: 1.x server cannot negotiate a pinned 2026-07-28 era
    try {
      const frames: unknown[] = [];
      const prev = transport.onmessage;
      transport.onmessage = (msg) => { frames.push(msg); prev?.(msg); };
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain('mai_prime');
      // Cross-era set identity (pass-11 aab7bb68): the modern era serves the
      // SAME complete tool set as the legacy era — not merely mai_prime.
      const legacyPeer = new LegacyClient({ name: 'cross-era-smoke', version: '0.0.0' });
      await legacyPeer.connect(new LegacyStdio({ command: 'node', args: [SERVER], env: SPAWN_ENV }));
      try {
        const legacyTools = await legacyPeer.listTools();
        expect(tools.tools).toEqual(legacyTools.tools);
      } finally {
        await legacyPeer.close();
      }
      const frame = frames.find(isListToolsFrame);
      if (!frame) throw new Error('raw tools/list response frame not captured — onmessage tee failed');
      // R3: hints exactly as declared in ServerOptions.cacheHints
      expect(frame.result.ttlMs).toBe(3_600_000);
      expect(frame.result.cacheScope).toBe('private');
      // 2026 wire also carries resultType (SDK-injected; typed client strips it)
      expect(frame.result.resultType).toBe('complete');
    } finally {
      await client.close();
    }
  }, 20_000);
});
