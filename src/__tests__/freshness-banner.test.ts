import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  renderFreshnessBanner, renderCodePrimeLine, renderDbSchemaPrimeLine,
  type DbSchemaState, type GraphFreshness, type GraphStaleCounts,
} from '../graph/freshness.js';

const DB_STATES: DbSchemaState[] = [
  { state: 'not-configured' },
  { state: 'never-extracted' },
  { state: 'stale', reason: 'no-url', tables: 10, nodes: 142, lastExtracted: new Date('2026-06-13T00:00:00Z') },
  { state: 'stale', reason: 'behind-code', tables: 10, nodes: 142, lastExtracted: new Date('2026-06-13T00:00:00Z') },
  { state: 'stale', reason: 'behind-code', tables: 0, nodes: 1, lastExtracted: null },
  { state: 'fresh', tables: 10, nodes: 142, lastExtracted: new Date('2026-08-18T00:00:00Z') },
];

const CODE_STATES: GraphStaleCounts[] = [
  { total: 0, stale: 0, method: 'per-file' },
  { total: 1368, stale: 0, method: 'per-file' },
  { total: 1368, stale: 42, method: 'per-file' },
];

const unwrap = (s: string): string => s.replace(/^_/, '').replace(/_$/, '');

describe('banner wording is derived from prime, never restated', () => {
  it('covers every DbSchemaState variant the union declares', () => {
    expect(new Set(DB_STATES.map((d) => d.state))).toEqual(
      new Set(['not-configured', 'never-extracted', 'stale', 'fresh'])
    );
  });

  it('matches renderDbSchemaPrimeLine for every schema state, modulo emphasis', () => {
    for (const db of DB_STATES) {
      const f: GraphFreshness = { code: { total: 1, stale: 0, method: 'per-file' }, db };
      expect(renderFreshnessBanner(f).db.text).toBe(unwrap(renderDbSchemaPrimeLine(db)));
    }
  });

  it('matches renderCodePrimeLine for every code state, modulo emphasis', () => {
    for (const code of CODE_STATES) {
      const f: GraphFreshness = { code, db: { state: 'not-configured' } };
      expect(renderFreshnessBanner(f).code.text).toBe(unwrap(renderCodePrimeLine(code)));
    }
  });

  it('never leaves markdown emphasis in the banner text', () => {
    for (const db of DB_STATES) {
      for (const code of CODE_STATES) {
        const b = renderFreshnessBanner({ code, db });
        expect(b.code.text.startsWith('_')).toBe(false);
        expect(b.code.text.endsWith('_')).toBe(false);
        expect(b.db.text.startsWith('_')).toBe(false);
        expect(b.db.text.endsWith('_')).toBe(false);
      }
    }
  });

  it('preserves an underscore inside a sentence', () => {
    expect(renderFreshnessBanner({
      code: { total: 0, stale: 0, method: 'per-file' },
      db: { state: 'not-configured' },
    }).db.text).toContain('MAI_GRAPH_DB_URL');
  });

  it('assigns a tone to every state and warns only when something is wrong', () => {
    expect(renderFreshnessBanner({
      code: { total: 5, stale: 0, method: 'per-file' },
      db: { state: 'fresh', tables: 1, nodes: 1, lastExtracted: new Date('2026-08-18T00:00:00Z') },
    })).toMatchObject({ code: { tone: 'ok' }, db: { tone: 'ok' } });

    expect(renderFreshnessBanner({
      code: { total: 5, stale: 2, method: 'per-file' },
      db: { state: 'stale', reason: 'no-url', tables: 1, nodes: 1, lastExtracted: null },
    })).toMatchObject({ code: { tone: 'warn' }, db: { tone: 'warn' } });

    expect(renderFreshnessBanner({
      code: { total: 0, stale: 0, method: 'per-file' },
      db: { state: 'never-extracted' },
    })).toMatchObject({ code: { tone: 'info' }, db: { tone: 'info' } });
  });

  it('carries no field that could hold the dev-DB URL (plan 28 R2, inherited)', () => {
    for (const db of DB_STATES) {
      const b = renderFreshnessBanner({ code: { total: 1, stale: 0, method: 'per-file' }, db });
      expect(Object.keys(b).sort()).toEqual(['code', 'db']);
      expect(Object.keys(b.db).sort()).toEqual(['text', 'tone']);
      expect(JSON.stringify(b)).not.toMatch(/postgres(ql)?:\/\//);
    }
  });

  it('is carried by overview without registering a freshness graph route', () => {
    const overview = fs.readFileSync(new URL('../graph/overview.ts', import.meta.url), 'utf8');
    const web = fs.readFileSync(new URL('../web-server.ts', import.meta.url), 'utf8');
    expect(overview).toMatch(/freshness:\s*FreshnessBannerPayload/);
    expect(overview).toMatch(/renderFreshnessBanner\(await readGraphFreshness\(pid\)\)/);
    // The count is a ratchet on the graph route surface: six through plan 39,
    // seven since plan 47 added `/api/graph/full` (the hero payload). The
    // discriminator that carries this case's intent is the line after it —
    // freshness rides on overview, never on a route of its own.
    expect(web.match(/"\/api\/graph\//g)).toHaveLength(7);
    expect(web).toContain('"/api/graph/full"');
    expect(web).not.toContain('/api/graph/freshness');
  });
});
