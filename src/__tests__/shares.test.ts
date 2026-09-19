/**
 * Cross-project shares (plan 31, spec §12): two-key visibility, labelling,
 * lifecycle statuses, non-transitivity, non-citability, counter isolation,
 * fail-closed rename/deletion. Pinned to the TARGET project (shr-test-b);
 * project A is the source, C the third party. Tests set MAI_LINKED_PROJECTS
 * explicitly and use the reset seam between cases; one dedicated negative
 * control mutates env WITHOUT reset to prove first-use pinning cannot widen.
 */
import { beforeAll, afterAll, afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';

const execFileAsync = promisify(execFile);

const savedEnv = {
  MAI_PROJECT_SLUG: process.env.MAI_PROJECT_SLUG,
  MAI_DB_URL: process.env.MAI_DB_URL,
  MAI_LINKED_PROJECTS: process.env.MAI_LINKED_PROJECTS,
  MAI_EMBEDDINGS: process.env.MAI_EMBEDDINGS,
};
process.env.MAI_PROJECT_SLUG = 'shr-test-b';
process.env.MAI_DB_URL = requireDisposableTestDbUrl();
process.env.MAI_LINKED_PROJECTS = '';
process.env.MAI_EMBEDDINGS = '0'; // lexical lane only — the standing suite never loads a model

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });
const entry = path.resolve('build/entry.js');
const runMai = (args: readonly string[], slug = 'shr-test-b') => execFileAsync(
  process.execPath, [entry, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MAI_DB_URL: process.env.MAI_DB_URL, MAI_PROJECT_SLUG: slug, MAI_EMBEDDINGS: '0' },
  }
);

async function withRealServer<T>(
  nudgeText: string,
  fn: (call: (name: string, args: Record<string, unknown>) => Promise<string>) => Promise<T>,
): Promise<T> {
  const { buildServer } = await import('../index.js');
  const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');
  const server = buildServer(async () => nudgeText);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'plan31-wire', version: '0.0.0' });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const result = await client.callTool({ name, arguments: args });
      const blocks = Array.isArray(result.content) ? result.content : [];
      return blocks.map((block) =>
        'text' in block && typeof block.text === 'string' ? block.text : ''
      ).join('\n\n');
    };
    return await fn(call);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
let projectA = '';
let projectB = '';
let projectC = '';
let decisionA = '';   // shared A→B
let handoffA = '';
let ideaA = '';
let decisionB = '';   // B-local (control: local citation still works)

async function cleanup(): Promise<void> {
  await admin.query(`DELETE FROM share_events WHERE source_slug LIKE 'shr-test-%' OR target_slug LIKE 'shr-test-%'`);
  await admin.query(`DELETE FROM projects WHERE slug LIKE 'shr-test-%'`); // cascades shares/decisions/tokens
}

beforeAll(async () => {
  await cleanup();
  const mk = async (slug: string): Promise<string> =>
    (await admin.query<{ id: string }>(`INSERT INTO projects (slug, name) VALUES ($1,$1) RETURNING id`, [slug])).rows[0].id;
  projectA = await mk('shr-test-a');
  projectB = await mk('shr-test-b');
  projectC = await mk('shr-test-c');
  decisionA = (await admin.query<{ id: string }>(
    `INSERT INTO code_decisions (project_id, decision_type, description, reasoning, source)
     VALUES ($1,'security','FOREIGN-A decision: vault custody boundary ruling','because the products are separate','user-approved') RETURNING id`,
    [projectA])).rows[0].id;
  handoffA = (await admin.query<{ id: string }>(
    `INSERT INTO agent_messages (project_id, author_agent, type, body)
     VALUES ($1,'test@plan31','handoff','FOREIGN-A handoff: conductor pointer lives here') RETURNING id`,
    [projectA])).rows[0].id;
  ideaA = (await admin.query<{ id: string }>(
    `INSERT INTO ideas (project_id, title, detail) VALUES ($1,'FOREIGN-A idea: shared telemetry shape','pair-scoped') RETURNING id`,
    [projectA])).rows[0].id;
  decisionB = (await admin.query<{ id: string }>(
    `INSERT INTO code_decisions (project_id, decision_type, description, source)
     VALUES ($1,'architecture','LOCAL-B decision about vault custody','user-approved') RETURNING id`,
    [projectB])).rows[0].id;
  await admin.query(
    `INSERT INTO doc_chunks (project_id, kind, repo_root, path, doc_sha, chunk_index, start_line, end_line, heading_trail, content, content_hash)
     VALUES ($1,'spec','/tmp/shr-a','docs/specs/custody.md','sha-doc-1',0,1,10,'Custody','FOREIGN-A spec: custody boundary details','h1'),
            ($1,'spec','/tmp/shr-a','docs/specs/custody.md','sha-doc-1',1,11,20,'Custody > Later','FORBIDDEN-SECOND-CHUNK-SENTINEL','h2')`,
    [projectA]);
});

/** Set the env AND reset the memoized linked-set (plan 31 B7: the runtime
 * value is memoized on first use; tests re-read through the seam). */
const setLinked = async (v: string): Promise<void> => {
  process.env.MAI_LINKED_PROJECTS = v;
  (await import('../shares.js')).__resetLinkedProjectsForTests();
};

afterEach(async () => { await setLinked(''); });

afterAll(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  await cleanup();
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
});

const share = async (kind: 'decision' | 'handoff' | 'idea' | 'doc', artifactId?: string): Promise<string> => {
  const { shareCreate } = await import('../shares.js');
  const msg = await shareCreate({
    sourceProjectId: projectA, targetSlug: 'shr-test-b', kind,
    artifactId, docPath: kind === 'doc' ? 'docs/specs/custody.md' : undefined,
    createdVia: 'cli',
  });
  const m = /share ([0-9a-f]{8})/.exec(msg);
  if (!m) throw new Error(`no share id in: ${msg}`);
  const full = await admin.query<{ id: string }>(`SELECT id FROM project_shares WHERE id::text LIKE $1 || '%'`, [m[1]]);
  return full.rows[0].id;
};
const revokeAll = async (): Promise<void> => {
  await admin.query(`UPDATE project_shares SET status='revoked', revoked_at=NOW(), revoked_reason='test reset' WHERE status='active'`);
};

async function expectBlockedSourceWrite(sql: string, values: unknown[]): Promise<void> {
  const contender = await admin.connect();
  try {
    await contender.query('BEGIN');
    await contender.query(`SET LOCAL lock_timeout = '100ms'`);
    let blocked = false;
    try {
      await contender.query(sql, values);
    } catch (err) {
      blocked = err instanceof Error && /lock timeout/.test(err.message);
    }
    expect(blocked).toBe(true);
    await contender.query('ROLLBACK');
  } finally {
    await contender.query('ROLLBACK').catch(() => {});
    contender.release();
  }
}

async function waitForProjectLockWait(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE 'SELECT id, slug FROM projects WHERE id = ANY%'`
    );
    if (Number(waiting.rows[0].n) > 0) return;
    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
  }
  throw new Error('re-grant never reached the ordered project-lock wait');
}

describe('grant transaction consistency and lock order', () => {
  it('holds every accepted artifact snapshot stable through grant commit', async () => {
    const { shareCreate } = await import('../shares.js');
    await shareCreate({
      sourceProjectId: projectA, targetSlug: 'shr-test-b', kind: 'decision', artifactId: decisionA, createdVia: 'cli',
      beforeGrantInsert: async () => {
        await expectBlockedSourceWrite(
          `UPDATE code_decisions SET still_valid=false, retracted_at=NOW() WHERE id=$1`, [decisionA]
        );
      },
    });
    expect((await admin.query<{ body: string }>(
      `SELECT snapshot->>'body' AS body FROM project_shares WHERE artifact_id=$1 AND status='active'`, [decisionA]
    )).rows[0].body).toContain('vault custody boundary ruling');
    await revokeAll();

    await shareCreate({
      sourceProjectId: projectA, targetSlug: 'shr-test-b', kind: 'handoff', artifactId: handoffA, createdVia: 'cli',
      beforeGrantInsert: async () => {
        await expectBlockedSourceWrite(`UPDATE agent_messages SET status='stale' WHERE id=$1`, [handoffA]);
      },
    });
    expect((await admin.query<{ body: string }>(
      `SELECT snapshot->>'body' AS body FROM project_shares WHERE artifact_id=$1 AND status='active'`, [handoffA]
    )).rows[0].body).toContain('conductor pointer');
    await revokeAll();

    await shareCreate({
      sourceProjectId: projectA, targetSlug: 'shr-test-b', kind: 'idea', artifactId: ideaA, createdVia: 'cli',
      beforeGrantInsert: async () => {
        await expectBlockedSourceWrite(`UPDATE ideas SET status='dropped' WHERE id=$1`, [ideaA]);
      },
    });
    expect((await admin.query<{ body: string }>(
      `SELECT snapshot->>'body' AS body FROM project_shares WHERE artifact_id=$1 AND status='active'`, [ideaA]
    )).rows[0].body).toContain('shared telemetry shape');
    await revokeAll();

    await shareCreate({
      sourceProjectId: projectA, targetSlug: 'shr-test-b', kind: 'doc',
      docPath: 'docs/specs/custody.md', createdVia: 'cli',
      beforeGrantInsert: async () => {
        await expectBlockedSourceWrite(
          `DELETE FROM doc_chunks WHERE project_id=$1 AND path='docs/specs/custody.md'`, [projectA]
        );
        await expectBlockedSourceWrite(
          `INSERT INTO doc_chunks
             (project_id, kind, repo_root, path, doc_sha, chunk_index, start_line, end_line, heading_trail, content, content_hash)
           VALUES ($1,'spec','/tmp/new-root','docs/specs/custody.md','new-root',0,1,1,'New','phantom root','new')`,
          [projectA]
        );
      },
    });
    expect((await admin.query<{ body: string }>(
      `SELECT snapshot->>'body' AS body FROM project_shares WHERE artifact_kind='doc' AND status='active'`
    )).rows[0].body).toBe('FOREIGN-A spec: custody boundary details');
    await revokeAll();
  });

  it('revoke and replacement grant use project-before-share order without deadlock', async () => {
    // This scenario asserts the complete grant→revoke→regrant sequence, so do
    // not inherit revoked decisionA history from the preceding lock cases.
    await admin.query(
      `DELETE FROM share_events WHERE share_id IN (SELECT id FROM project_shares WHERE artifact_id=$1)`, [decisionA]
    );
    await admin.query(`DELETE FROM project_shares WHERE artifact_id=$1`, [decisionA]);
    const id = await share('decision', decisionA);
    const { shareCreate, shareRevoke } = await import('../shares.js');
    let release = (): void => {};
    let reached = (): void => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const atShareLock = new Promise<void>((resolve) => { reached = resolve; });
    const revoke = shareRevoke({
      shareId: id, reason: 'replace concurrently', via: 'cli', projectId: projectB,
      beforeShareLock: async () => { reached(); await held; },
    });
    await atShareLock;
    const regrant = shareCreate({
      sourceProjectId: projectA, targetSlug: 'shr-test-b', kind: 'decision', artifactId: decisionA, createdVia: 'cli',
    });
    try {
      await waitForProjectLockWait();
    } finally {
      release();
    }
    const [, regrantMessage] = await Promise.all([revoke, regrant]);
    const regrantPrefix = /share ([0-9a-f]{8})/.exec(regrantMessage)?.[1];
    if (!regrantPrefix) throw new Error(`no regrant id in: ${regrantMessage}`);
    const regrantId = (await admin.query<{ id: string }>(
      `SELECT id FROM project_shares WHERE id::text LIKE $1 || '%'`, [regrantPrefix]
    )).rows[0].id;
    const active = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM project_shares WHERE artifact_id=$1 AND status='active'`, [decisionA]
    );
    expect(Number(active.rows[0].n)).toBe(1);
    const events = await admin.query<{ event: string }>(
      `SELECT event FROM share_events WHERE share_id = ANY($1::uuid[]) ORDER BY created_at`, [[id, regrantId]]
    );
    expect(events.rows.map((row) => row.event)).toEqual(['grant', 'revoke', 'regrant']);
    await revokeAll();
  });
});

describe('two-key visibility (spec T1-T4, negative controls first)', () => {
  it('grant WITHOUT env link → invisible on EVERY agent surface (forbidden path fails)', async () => {
    await share('decision', decisionA);
    const { resolveVisibleShares, sharedQuery, primeSharedSection, sharesReadSection } = await import('../shares.js');
    expect(await resolveVisibleShares(projectB)).toHaveLength(0);
    expect(await sharedQuery({})).toContain('No linked projects');
    expect(await primeSharedSection(projectB)).toBeNull();
    expect(await sharesReadSection('vault custody boundary ruling', projectB)).toBeNull();
    const { unifiedSearch } = await import('../decisions.js');
    expect(await unifiedSearch({ query: 'vault custody', kind: 'all', limit: 20 })).not.toContain('[from ');
    await revokeAll();
  });

  it('env link WITHOUT grant → invisible on EVERY agent surface', async () => {
    await setLinked('shr-test-a');
    const { resolveVisibleShares, sharedQuery, primeSharedSection, sharesReadSection } = await import('../shares.js');
    expect(await resolveVisibleShares(projectB)).toHaveLength(0);
    expect(await sharedQuery({})).toContain('shared nothing visible');
    expect(await primeSharedSection(projectB)).toBeNull();
    expect(await sharesReadSection('vault custody boundary ruling', projectB)).toBeNull();
  });

  it('first-use runtime pinning cannot widen after an in-process env mutation', async () => {
    await setLinked('');
    const { linkedSlugsFromEnv, resolveVisibleShares } = await import('../shares.js');
    expect(linkedSlugsFromEnv()).toEqual([]); // first read pins the empty set
    process.env.MAI_LINKED_PROJECTS = 'shr-test-a'; // deliberately NO reset seam
    expect(linkedSlugsFromEnv()).toEqual([]);
    expect(await resolveVisibleShares(projectB)).toHaveLength(0);
  });

  it('BOTH keys → visible, and every rendered line carries the source label (mutation control)', async () => {
    await share('decision', decisionA);
    await setLinked('shr-test-a');
    const { resolveVisibleShares, sharedQuery, primeSharedSection, sharesReadSection } = await import('../shares.js');
    const visible = await resolveVisibleShares(projectB);
    expect(visible).toHaveLength(1);
    const list = await sharedQuery({});
    expect(list).toContain('[from shr-test-a · decision · ok]');
    expect(list).toContain('FOREIGN-A decision');
    const prime = await primeSharedSection(projectB);
    expect(prime).toContain('[from shr-test-a');
    const section = await sharesReadSection('vault custody boundary ruling', projectB);
    expect(section).not.toBeNull();
    for (const row of section?.fullRows ?? []) expect(row).toContain('[from shr-test-a');
    // Kind-specific snapshot fields reach the detail view (spec §3/§7.1).
    const detail = await sharedQuery({ id: visible[0].row.id.slice(0, 8) });
    for (const line of detail.split('\n').filter(Boolean)) {
      expect(line.startsWith('[from shr-test-a · decision · ok]')).toBe(true);
    }
    expect(detail).toContain('source: user-approved');
    expect(detail).toContain('confidence:');
    expect(detail).toContain('snapshot taken:');
    const { unifiedSearch } = await import('../decisions.js');
    const fullSearch = await unifiedSearch({ query: 'vault custody', kind: 'all', limit: 20 });
    expect(fullSearch).toContain(`mai_shared {id: "${visible[0].row.id.slice(0, 8)}"}`);
    const headlineSearch = await unifiedSearch({
      query: 'vault custody', kind: 'all', limit: 20, budget: { fullRows: 0, charBudget: 6000 },
    });
    expect(headlineSearch).toContain(`mai_shared {id: "${visible[0].row.id.slice(0, 8)}"}`);
    await revokeAll();
  });

  it('doc grants snapshot exactly the first ordered chunk, never the second', async () => {
    const id = await share('doc');
    await setLinked('shr-test-a');
    const stored = await admin.query<{ body: string }>(
      `SELECT snapshot->>'body' AS body FROM project_shares WHERE id=$1`, [id]
    );
    expect(stored.rows[0].body).toBe('FOREIGN-A spec: custody boundary details');
    expect(stored.rows[0].body).not.toContain('FORBIDDEN-SECOND-CHUNK-SENTINEL');
    const { sharedQuery, sharesOperatorView } = await import('../shares.js');
    expect(await sharedQuery({ id: id.slice(0, 8) })).not.toContain('FORBIDDEN-SECOND-CHUNK-SENTINEL');
    expect((await sharesOperatorView(projectB, 'in'))[0].body).not.toContain('FORBIDDEN-SECOND-CHUNK-SENTINEL');
    await revokeAll();
  });

  it('the real operator API carries every kind-specific snapshot field', async () => {
    await share('decision', decisionA);
    await share('handoff', handoffA);
    await share('idea', ideaA);
    await share('doc');
    await setLinked('shr-test-a');
    const { createShareGetHandlers } = await import('../web-share-handlers.js');
    const api = await createShareGetHandlers(async () => projectB)['/api/shares'](
      new URL('http://x/api/shares?direction=in')
    );
    const rows = api.rows;
    if (!Array.isArray(rows)) throw new Error('api rows missing');
    const isRecord = (v: unknown): v is Record<string, unknown> =>
      typeof v === 'object' && v !== null && !Array.isArray(v);
    const fieldsFor = (kind: string): Record<string, unknown> => {
      const row = rows.find((v) => isRecord(v) && v.kind === kind);
      if (!isRecord(row) || !isRecord(row.fields)) throw new Error(`operator fields missing for ${kind}`);
      return row.fields;
    };
    expect(fieldsFor('decision')).toMatchObject({ source: 'user-approved' });
    expect(fieldsFor('handoff')).toMatchObject({ author_agent: 'test@plan31', refs: [] });
    expect(fieldsFor('idea')).toMatchObject({ priority: 'someday', status: 'idea' });
    expect(fieldsFor('doc')).toMatchObject({ doc_kind: 'spec', heading_trail: 'Custody' });
    await revokeAll();
  });

  it('maximum legal handoff refs survive DB, paged agent detail, and operator API exactly', async () => {
    const maxRefs: Array<{ kind: 'file'; path: string }> = Array.from({ length: 8 }, (_, i) => ({
      kind: 'file', path: `docs/${i}-${'r'.repeat(505)}`,
    }));
    const maxHandoff = (await admin.query<{ id: string }>(
      `INSERT INTO agent_messages (project_id, author_agent, type, body, refs)
       VALUES ($1,'max@test','handoff',$2,$3::jsonb) RETURNING id`,
      [projectA, `MAXREF-HANDOFF-${'b'.repeat(735)}`, JSON.stringify(maxRefs)]
    )).rows[0].id;
    const id = await share('handoff', maxHandoff);
    await setLinked('shr-test-a');
    try {
      const stored = await admin.query<{ refs: unknown }>(
        `SELECT snapshot #> '{fields,refs}' AS refs FROM project_shares WHERE id=$1`, [id]
      );
      expect(stored.rows[0].refs).toEqual(maxRefs);

      const { sharedQuery } = await import('../shares.js');
      const { pageBudget, parseBudgetPage } = await import('../read-budget.js');
      const expected = await sharedQuery({ id: id.slice(0, 8) });
      let reconstructed = '';
      let part = 1;
      let total = 1;
      do {
        const text = await sharedQuery({ id: id.slice(0, 8), part }, pageBudget());
        const parsed = parseBudgetPage(text);
        expect(parsed?.kind).toBe('share');
        reconstructed += parsed?.body ?? '';
        const marker = new RegExp(`_Shared detail part ${part}/(\\d+);`).exec(text);
        if (!marker) throw new Error('missing share part marker');
        total = Number(marker[1]);
        part += 1;
      } while (part <= total);
      expect(total).toBeGreaterThan(1);
      expect(reconstructed).toBe(expected);
      expect(reconstructed).toContain(JSON.stringify(maxRefs));

      const { createShareGetHandlers } = await import('../web-share-handlers.js');
      const api = await createShareGetHandlers(async () => projectB)['/api/shares'](
        new URL('http://x/api/shares?direction=in')
      );
      const rows = api.rows;
      if (!Array.isArray(rows)) throw new Error('api rows missing');
      const isRecord = (v: unknown): v is Record<string, unknown> =>
        typeof v === 'object' && v !== null && !Array.isArray(v);
      const row = rows.find((v) => isRecord(v) && v.id === id);
      if (!isRecord(row) || !isRecord(row.fields)) {
        throw new Error('operator refs missing');
      }
      expect(row.fields.refs).toEqual(maxRefs);
    } finally {
      await revokeAll();
      await admin.query(`DELETE FROM agent_messages WHERE id=$1`, [maxHandoff]);
    }
  });

  it('non-doc snapshots over 4,000 chars round-trip exactly through mai_shared parts', async () => {
    const longReason = `LONG-START-${'x'.repeat(9000)}-LONG-END`;
    const longDecision = (await admin.query<{ id: string }>(
      `INSERT INTO code_decisions (project_id, decision_type, description, reasoning, source)
       VALUES ($1,'security','FOREIGN-A long decision',$2,'user-approved') RETURNING id`,
      [projectA, longReason]
    )).rows[0].id;
    const id = await share('decision', longDecision);
    await setLinked('shr-test-a');
    try {
      const { sharedQuery } = await import('../shares.js');
      const { pageBudget, parseBudgetPage } = await import('../read-budget.js');
      await expect(sharedQuery({ part: 1 }, pageBudget())).rejects.toThrow(/part requires id/);
      await expect(sharedQuery({ id: id.slice(0, 8), part: 0 }, pageBudget())).rejects.toThrow(/positive integer/);
      const expected = await sharedQuery({ id: id.slice(0, 8) });
      let reconstructed = '';
      let part = 1;
      let total = 1;
      do {
        const text = await sharedQuery({ id: id.slice(0, 8), part }, pageBudget());
        expect(text.length).toBeLessThanOrEqual(pageBudget().charBudget);
        const parsed = parseBudgetPage(text);
        expect(parsed?.kind).toBe('share');
        reconstructed += parsed?.body ?? '';
        const marker = new RegExp(`_Shared detail part ${part}/(\\d+);`).exec(text);
        if (!marker) throw new Error(`missing share part marker: ${text.slice(-200)}`);
        total = Number(marker[1]);
        part += 1;
      } while (part <= total);
      expect(reconstructed).toBe(expected);
      expect(reconstructed).toContain(longReason);

      // Exercise the registered MCP tools/call path, including the finalizer
      // and a real nudge. Direct sharedQuery coverage alone cannot prove the
      // atomic share-frame discriminator is wired at the server boundary.
      const nudge = `NUDGE ${'n'.repeat(494)}`;
      expect(nudge).toHaveLength(500);
      await withRealServer(nudge, async (call) => {
        let wireBody = '';
        let wirePart = 1;
        let wireTotal = 1;
        do {
          const text = await call('mai_shared', { id: id.slice(0, 8), part: wirePart });
          expect(text.length).toBeLessThanOrEqual(6000);
          const nudgeAt = text.lastIndexOf(`\n\n${nudge}`);
          expect(nudgeAt).toBeGreaterThan(0);
          const page = text.slice(0, nudgeAt);
          const parsed = parseBudgetPage(page);
          expect(parsed?.kind).toBe('share');
          wireBody += parsed?.body ?? '';
          const marker = new RegExp(`_Shared detail part ${wirePart}/(\\d+);`).exec(page);
          if (!marker) throw new Error(`missing wire share marker: ${page.slice(-200)}`);
          wireTotal = Number(marker[1]);
          wirePart += 1;
        } while (wirePart <= wireTotal);
        expect(wireBody).toBe(expected);
        expect(wireBody).toContain(longReason);
      });
      const stored = await admin.query<{ n: number }>(
        `SELECT length(snapshot->>'body')::integer AS n FROM project_shares WHERE id=$1`, [id]
      );
      expect(stored.rows[0].n).toBeGreaterThan(9000);
    } finally {
      await revokeAll();
      await admin.query(`DELETE FROM code_decisions WHERE id=$1`, [longDecision]);
    }
  });

  it('revoke → invisible on the very next read; audit row recorded (spec T4)', async () => {
    const id = await share('decision', decisionA);
    await setLinked('shr-test-a');
    const { shareRevoke, resolveVisibleShares } = await import('../shares.js');
    expect(await resolveVisibleShares(projectB)).toHaveLength(1);
    await shareRevoke({ shareId: id, reason: 'no longer relevant', via: 'cli', projectId: projectB });
    expect(await resolveVisibleShares(projectB)).toHaveLength(0);
    const ev = await admin.query(`SELECT 1 FROM share_events WHERE share_id = $1 AND event = 'revoke' AND note = 'no longer relevant'`, [id]);
    expect(ev.rows).toHaveLength(1);
  });

  it('share 101 remains directly openable and searchable past the presentation page', async () => {
    const seeded = await admin.query<{ id: string; description: string; reasoning: string }>(
      `INSERT INTO code_decisions (project_id, decision_type, description, reasoning, source, timestamp)
       SELECT $1,'security','overflow ' || g,
              CASE WHEN g=101 THEN 'needle-overflow-101' ELSE 'ordinary' END,
              'user-approved',NOW() - (g * INTERVAL '1 second')
         FROM generate_series(1,101) g
       RETURNING id, description, reasoning`,
      [projectA]
    );
    for (const row of seeded.rows) {
      const ordinal = Number(row.description.slice('overflow '.length));
      const snapshot = {
        headline: row.description,
        body: `${row.description}\n\n${row.reasoning}`,
        source_slug: 'shr-test-a',
        detail: 'security',
        fields: {},
      };
      const contentHash = crypto.createHash('sha256')
        .update(`${row.description}\n${row.reasoning}`).digest('hex');
      await admin.query(
        `INSERT INTO project_shares
           (source_project_id, target_project_id, artifact_kind, artifact_id, snapshot,
            content_hash, note, created_via, created_at)
         VALUES ($1,$2,'decision',$3,$4::jsonb,$5,'overflow','cli',
                 NOW() - ($6::integer * INTERVAL '1 second'))`,
        [projectA, projectB, row.id, JSON.stringify(snapshot), contentHash, ordinal]
      );
    }
    try {
      await setLinked('shr-test-a');
      const oldest = await admin.query<{ id: string }>(
        `SELECT id FROM project_shares WHERE note='overflow' ORDER BY created_at ASC LIMIT 1`
      );
      const { sharedQuery } = await import('../shares.js');
      expect(await sharedQuery({ id: oldest.rows[0].id.slice(0, 8) })).toContain('needle-overflow-101');
      const { unifiedSearch } = await import('../decisions.js');
      expect(await unifiedSearch({ query: 'needle-overflow-101', kind: 'all', limit: 20 }))
        .toContain(oldest.rows[0].id.slice(0, 8));
    } finally {
      await admin.query(`DELETE FROM project_shares WHERE note='overflow'`);
      await admin.query(`DELETE FROM code_decisions WHERE project_id=$1 AND description LIKE 'overflow %'`, [projectA]);
    }
  });
});

describe('lifecycle statuses (spec T5-T8, T16)', () => {
  it('retracted source → tombstone: reason present, body suppressed for agents, retained for the operator', async () => {
    const id = await share('decision', decisionA);
    await setLinked('shr-test-a');
    const reason = 'superseded by ruling 2\nUNTRUSTED SECOND LINE';
    await admin.query(
      `UPDATE code_decisions SET still_valid=false, retracted_at=NOW(), retraction_reason=$2 WHERE id=$1`,
      [decisionA, reason]
    );
    try {
      const { sharedQuery, sharesOperatorView, primeSharedSection, sharesReadSection } = await import('../shares.js');
      const detail = await sharedQuery({ id: id.slice(0, 8) });
      expect(detail).toContain('RETRACTED in source');
      expect(detail).toContain('superseded by ruling 2');
      expect(detail).toContain('UNTRUSTED SECOND LINE');
      expect(detail).not.toContain('because the products are separate'); // snapshot body withheld

      // The untrusted continuation must stay labelled on EVERY headline
      // surface, not only in detail. This fails if shareLine prefixes before
      // interpolating/splitting the reason.
      const list = await sharedQuery({});
      const prime = await primeSharedSection(projectB);
      const search = await sharesReadSection('vault custody boundary', projectB);
      const surfaces = [list, prime ?? '', ...(search?.fullRows ?? [])];
      const expectedPrefix = '- [from shr-test-a · decision · retracted]';
      for (const surface of surfaces) {
        const reasonLines = surface.split('\n').filter((line) =>
          line.includes('superseded by ruling 2') || line.includes('UNTRUSTED SECOND LINE')
        );
        expect(reasonLines).toHaveLength(2);
        expect(reasonLines.every((line) => line.startsWith(expectedPrefix))).toBe(true);
      }

      // Operator surface through the REAL web handler, not just the helper
      // (spec T5): the API payload carries the suppressed body.
      const { createShareGetHandlers } = await import('../web-share-handlers.js');
      const handlers = createShareGetHandlers(async () => projectB);
      const api = await handlers['/api/shares'](new URL('http://x/api/shares?project=shr-test-b&direction=in'));
      const rows = api.rows;
      if (!Array.isArray(rows)) throw new Error('api rows missing');
      const isRecord = (v: unknown): v is Record<string, unknown> =>
        typeof v === 'object' && v !== null && !Array.isArray(v);
      const first: unknown = rows[0];
      expect(isRecord(first) ? first.body : undefined).toContain('because the products are separate');
      const operator = await sharesOperatorView(projectB, 'in');
      expect(operator[0].body).toContain('because the products are separate'); // suppression is agent-surface only
    } finally {
      await admin.query(`UPDATE code_decisions SET still_valid=true, retracted_at=NULL, retraction_reason=NULL WHERE id=$1`, [decisionA]);
      await revokeAll();
    }
  });

  it('deleted artifact → deleted tombstone; edited artifact → updated flag; moved doc → moved', async () => {
    await setLinked('shr-test-a');
    const { resolveVisibleShares, sharedQuery } = await import('../shares.js');
    await share('handoff', handoffA);
    await share('idea', ideaA);
    await share('doc');
    // edited: handoff body changes → hash drift
    await admin.query(`UPDATE agent_messages SET body = body || ' (edited)' WHERE id=$1`, [handoffA]);
    // deleted: idea row removed
    await admin.query(`DELETE FROM ideas WHERE id=$1`, [ideaA]);
    // moved: doc chunks dropped
    await admin.query(`DELETE FROM doc_chunks WHERE project_id=$1 AND path='docs/specs/custody.md'`, [projectA]);
    const visible = await resolveVisibleShares(projectB);
    const byKind = new Map(visible.map((v) => [v.row.artifact_kind, v.live.status]));
    expect(byKind.get('handoff')).toBe('updated');
    expect(byKind.get('idea')).toBe('deleted');
    expect(byKind.get('doc')).toBe('moved');
    // Tombstone BYTES on the agent list surface (spec T6): the deleted idea's
    // headline renders, its snapshot detail/body text does not.
    const list = await sharedQuery({});
    expect(list).toContain('source artifact deleted');
    expect(list).toContain('FOREIGN-A idea');       // headline stays
    expect(list).not.toContain('pair-scoped');       // idea detail/body withheld
    await revokeAll();
  });

  it('a failed audit-event write rolls back the state change — neither half commits (atomicity)', async () => {
    const { shareCreate, shareRevoke } = await import('../shares.js');
    const before = await admin.query(`SELECT count(*) AS n FROM project_shares WHERE status='active'`);
    await admin.query(`ALTER TABLE share_events RENAME TO share_events_x`);
    try {
      await expect(shareCreate({
        sourceProjectId: projectA, targetSlug: 'shr-test-b', kind: 'decision', artifactId: decisionA, createdVia: 'cli',
      })).rejects.toThrow();
      const after = await admin.query(`SELECT count(*) AS n FROM project_shares WHERE status='active'`);
      expect(after.rows[0].n).toBe(before.rows[0].n); // grant did NOT survive its lost event
    } finally {
      await admin.query(`ALTER TABLE share_events_x RENAME TO share_events`);
    }
    const id = await share('decision', decisionA);
    await admin.query(`ALTER TABLE share_events RENAME TO share_events_x`);
    try {
      await expect(shareRevoke({ shareId: id, reason: 'atomic test', via: 'cli', projectId: projectB })).rejects.toThrow();
      const still = await admin.query(`SELECT status FROM project_shares WHERE id=$1`, [id]);
      expect(still.rows[0].status).toBe('active'); // revoke did NOT survive its lost event
    } finally {
      await admin.query(`ALTER TABLE share_events_x RENAME TO share_events`);
    }
    await revokeAll();
  });

  it('re-grant after revoke → new active row; a second simultaneous active share is refused (spec T16)', async () => {
    const first = await share('decision', decisionA);
    const { shareRevoke, shareCreate } = await import('../shares.js');
    await shareRevoke({ shareId: first, reason: 'cycle', via: 'cli', projectId: projectB });
    const second = await share('decision', decisionA);
    expect(second).not.toBe(first);
    const ev = await admin.query(`SELECT event FROM share_events WHERE share_id = $1`, [second]);
    expect(ev.rows[0].event).toBe('regrant');
    await expect(shareCreate({
      sourceProjectId: projectA, targetSlug: 'shr-test-b', kind: 'decision', artifactId: decisionA, createdVia: 'cli',
    })).rejects.toThrow(/already actively shared/);
    await revokeAll();
  });

  it('sharing an already-retracted artifact is refused (spec T11)', async () => {
    // Self-contained fixture: earlier lifecycle tests deleted ideaA.
    const re = await admin.query<{ id: string }>(
      `INSERT INTO ideas (project_id, title, status) VALUES ($1,'FOREIGN-A dropped idea','dropped') RETURNING id`, [projectA]);
    const { shareCreate } = await import('../shares.js');
    await expect(shareCreate({
      sourceProjectId: projectA, targetSlug: 'shr-test-b', kind: 'idea', artifactId: re.rows[0].id, createdVia: 'cli',
    })).rejects.toThrow(/tombstone is refused/);
  });
});

describe('non-transitivity + ownership (spec T9-T10)', () => {
  it('a project cannot share an artifact it does not own (B re-sharing an A-owned decision is refused)', async () => {
    const { shareCreate } = await import('../shares.js');
    await expect(shareCreate({
      sourceProjectId: projectB, targetSlug: 'shr-test-c', kind: 'decision', artifactId: decisionA, createdVia: 'cli',
    })).rejects.toThrow(/only a project's OWN artifacts/);
  });

  it('an A→B share is invisible from C under every env (no transitive visibility)', async () => {
    await share('decision', decisionA);
    const { resolveVisibleShares } = await import('../shares.js');
    await setLinked('shr-test-a,shr-test-b');
    expect(await resolveVisibleShares(projectC)).toHaveLength(0);
    await revokeAll();
  });
});

describe('built CLI pinned-project scope', () => {
  it('share/list/unshare resolve MAI_PROJECT_SLUG concretely and cannot revoke an unrelated pair', async () => {
    const created = await runMai(['share', 'decision', decisionB, '--to', 'shr-test-c']);
    const ownPrefix = /share ([0-9a-f]{8})/.exec(created.stdout)?.[1];
    if (!ownPrefix) throw new Error(`built CLI returned no share id: ${created.stdout}`);
    const listed = await runMai(['shares', '--outgoing']);
    expect(listed.stdout).toContain(ownPrefix);
    await runMai(['unshare', ownPrefix, '--reason', 'cli scope proof']);
    const own = await admin.query<{ status: string }>(
      `SELECT status FROM project_shares WHERE id::text LIKE $1 || '%'`, [ownPrefix]
    );
    expect(own.rows[0].status).toBe('revoked');

    const { shareCreate } = await import('../shares.js');
    const foreignMessage = await shareCreate({
      sourceProjectId: projectA, targetSlug: 'shr-test-c', kind: 'decision',
      artifactId: decisionA, createdVia: 'cli',
    });
    const foreignPrefix = /share ([0-9a-f]{8})/.exec(foreignMessage)?.[1];
    if (!foreignPrefix) throw new Error(`core returned no share id: ${foreignMessage}`);
    let rejected = false;
    try { await runMai(['unshare', foreignPrefix, '--reason', 'must not cross scope']); }
    catch { rejected = true; }
    expect(rejected).toBe(true);
    const foreign = await admin.query<{ status: string }>(
      `SELECT status FROM project_shares WHERE id::text LIKE $1 || '%'`, [foreignPrefix]
    );
    expect(foreign.rows[0].status).toBe('active');
    await admin.query(
      `UPDATE project_shares SET status='revoked', revoked_at=NOW(), revoked_reason='cli cleanup'
        WHERE id::text LIKE $1 || '%'`, [foreignPrefix]
    );
  });
});

describe('write-gate + counter isolation (spec T12-T13, invariant 4)', () => {
  it('a foreign shared decision id is NOT citable; the rejection is logged', async () => {
    await share('decision', decisionA);
    await setLinked('shr-test-a');
    const { unifiedSearch } = await import('../decisions.js');
    const out = await unifiedSearch({ query: 'vault custody', kind: 'all', limit: 20 });
    expect(out).toContain('[from shr-test-a'); // the share IS visible in search…
    // Guard the positive control's premise: the trigram lane must have minted
    // the LOCAL decision, or the control below fails for the wrong reason.
    expect(out).toContain(decisionB);
    const { verifyCatA } = await import('../write-gate.js');
    await expect(verifyCatA({
      bucket: 'decisions',
      citation: { kind: 'extends', extends_id: decisionA, how: 'cross-boundary attempt' },
      payloadFingerprint: 'plan31-test', toolName: 'mai_remember',
    })).rejects.toThrow(/not returned by any search/); // …but its id was never minted
    const viol = await admin.query(
      `SELECT 1 FROM write_violations WHERE violation_kind='invalid_citation' AND attempted_payload='plan31-test'`);
    expect(viol.rows.length).toBeGreaterThan(0);
    // control: the LOCAL id from the same search IS citable
    const local = await verifyCatA({
      bucket: 'decisions',
      citation: { kind: 'extends', extends_id: decisionB, how: 'local extension' },
      payloadFingerprint: 'plan31-test-local', toolName: 'mai_remember',
    });
    expect(local?.citedId).toBe(decisionB);
    await revokeAll();
  });

  it('source-row counters never tick from target-side reads', async () => {
    await share('decision', decisionA);
    await setLinked('shr-test-a');
    const before = await admin.query<{ surfaced_count: number; cited_count: number }>(
      `SELECT surfaced_count, cited_count FROM code_decisions WHERE id=$1`, [decisionA]);
    const { sharedQuery } = await import('../shares.js');
    const { unifiedSearch } = await import('../decisions.js');
    await sharedQuery({});
    await unifiedSearch({ query: 'vault custody boundary', kind: 'all', limit: 20 });
    const after = await admin.query<{ surfaced_count: number; cited_count: number }>(
      `SELECT surfaced_count, cited_count FROM code_decisions WHERE id=$1`, [decisionA]);
    expect(after.rows[0]).toEqual(before.rows[0]);
    await revokeAll();
  });
});

describe('fail-closed edges (spec T14-T15, T20)', () => {
  it('grant/revoke audit slugs are current after warmed-cache source+target renames', async () => {
    const source = (await admin.query<{ id: string }>(
      `INSERT INTO projects (slug, name) VALUES ('shr-cache-source','Cache source') RETURNING id`
    )).rows[0].id;
    const target = (await admin.query<{ id: string }>(
      `INSERT INTO projects (slug, name) VALUES ('shr-cache-target','Cache target') RETURNING id`
    )).rows[0].id;
    const decision = (await admin.query<{ id: string }>(
      `INSERT INTO code_decisions (project_id, decision_type, description, source)
       VALUES ($1,'security','cache rename decision','user-approved') RETURNING id`, [source]
    )).rows[0].id;
    const { resolveProjectId, projectSlugById } = await import('../db.js');
    await resolveProjectId('shr-cache-target'); // warm slug→id cache
    await projectSlugById(source);              // warm both id→slug entries
    await projectSlugById(target);
    await admin.query(`UPDATE projects SET slug='shr-cache-source-new' WHERE id=$1`, [source]);
    await admin.query(`UPDATE projects SET slug='shr-cache-target-new' WHERE id=$1`, [target]);
    try {
      const { shareCreate, shareRevoke } = await import('../shares.js');
      await expect(shareCreate({
        sourceProjectId: source, targetSlug: 'shr-cache-target', kind: 'decision',
        artifactId: decision, createdVia: 'cli',
      })).rejects.toThrow(/Project not found: shr-cache-target/);
      const message = await shareCreate({
        sourceProjectId: source, targetSlug: 'shr-cache-target-new', kind: 'decision',
        artifactId: decision, createdVia: 'cli',
      });
      const prefix = /share ([0-9a-f]{8})/.exec(message)?.[1];
      if (!prefix) throw new Error(`share id missing: ${message}`);
      const grant = await admin.query<{ id: string; source_slug: string; target_slug: string }>(
        `SELECT share_id AS id, source_slug, target_slug FROM share_events
          WHERE share_id::text LIKE $1 || '%' AND event='grant'`, [prefix]
      );
      expect(grant.rows[0]).toMatchObject({
        source_slug: 'shr-cache-source-new', target_slug: 'shr-cache-target-new',
      });
      await shareRevoke({ shareId: prefix, reason: 'rename audit proof', via: 'cli', projectId: source });
      const revoke = await admin.query<{ source_slug: string; target_slug: string }>(
        `SELECT source_slug, target_slug FROM share_events WHERE share_id=$1 AND event='revoke'`,
        [grant.rows[0].id]
      );
      expect(revoke.rows[0]).toEqual({
        source_slug: 'shr-cache-source-new', target_slug: 'shr-cache-target-new',
      });
    } finally {
      await admin.query(`DELETE FROM share_events WHERE source_project_id=$1 OR target_project_id=$2`, [source, target]);
      await admin.query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [[source, target]]);
    }
  });

  it('rename darkens, then an intentional current-slug relink restores every surface', async () => {
    const shareId = await share('decision', decisionA);
    await setLinked('shr-test-a');
    const { resolveVisibleShares, shareEventsForProject, shareLinkStates, sharesOperatorView } = await import('../shares.js');
    expect(await resolveVisibleShares(projectB)).toHaveLength(1);
    await admin.query(`UPDATE projects SET slug='shr-test-a-renamed' WHERE id=$1`, [projectA]);
    expect(await resolveVisibleShares(projectB)).toHaveLength(0);
    const audit = await shareEventsForProject(projectB);
    expect(audit.rows.some((e) => e.share_id === shareId)).toBe(true);
    const states = await shareLinkStates(projectB);
    expect(states.find((s) => s.source_slug === 'shr-test-a')).toMatchObject({
      current_source_slug: 'shr-test-a-renamed', state: 'dark',
    });

    // Operator intentionally accepts the renamed source. Runtime visibility
    // and operator classification now use the same current-slug predicate;
    // grant-time slug remains history, not a permanent-dark veto.
    await admin.query(
      `UPDATE projects SET metadata=jsonb_build_object('linked_projects', ARRAY['shr-test-a-renamed']) WHERE id=$1`,
      [projectB]
    );
    await setLinked('shr-test-a-renamed');
    expect(await resolveVisibleShares(projectB)).toHaveLength(1);
    const inbound = (await sharesOperatorView(projectB, 'in')).find((s) => s.id === shareId);
    expect(inbound).toMatchObject({
      source_slug: 'shr-test-a', current_source_slug: 'shr-test-a-renamed', link_state: 'linked',
    });
    const relinked = (await shareLinkStates(projectB)).filter((s) =>
      s.source_slug === 'shr-test-a' || s.current_source_slug === 'shr-test-a-renamed'
    );
    expect(relinked).toHaveLength(1); // no old-dark + new-linked duplicate banners
    expect(relinked[0]).toMatchObject({
      source_slug: 'shr-test-a', current_source_slug: 'shr-test-a-renamed', state: 'linked',
    });
    expect(relinked[0].detail).toContain("grant-time slug 'shr-test-a'");
    const cli = await runMai(['shares', '--incoming']);
    expect(cli.stdout).toContain(shareId.slice(0, 8));
    expect(cli.stdout).not.toContain('DARK (mai link)');

    await admin.query(`UPDATE projects SET slug='shr-test-a' WHERE id=$1`, [projectA]);
    await admin.query(
      `UPDATE projects SET metadata=jsonb_build_object('linked_projects', ARRAY['shr-test-a']) WHERE id=$1`,
      [projectB]
    );
    await setLinked('shr-test-a');
    await revokeAll();
  });

  it('deleting the source project cascades its shares; denormalized audit survives', async () => {
    const projectD = (await admin.query<{ id: string }>(
      `INSERT INTO projects (slug, name) VALUES ('shr-test-d','D') RETURNING id`)).rows[0].id;
    const dec = (await admin.query<{ id: string }>(
      `INSERT INTO code_decisions (project_id, decision_type, description, source)
       VALUES ($1,'api','FOREIGN-D decision','user-approved') RETURNING id`, [projectD])).rows[0].id;
    const { shareCreate } = await import('../shares.js');
    await admin.query(
      `UPDATE projects SET metadata=jsonb_build_object('linked_projects', ARRAY['shr-test-d']) WHERE id=$1`,
      [projectB]
    );
    await shareCreate({ sourceProjectId: projectD, targetSlug: 'shr-test-b', kind: 'decision', artifactId: dec, createdVia: 'cli' });
    await admin.query(`DELETE FROM projects WHERE id=$1`, [projectD]);
    const shares = await admin.query(`SELECT 1 FROM project_shares WHERE source_project_id=$1`, [projectD]);
    expect(shares.rows).toHaveLength(0);
    const { shareEventsForProject, shareLinkStates } = await import('../shares.js');
    const events = await shareEventsForProject(projectB);
    expect(events.rows.some((e) => e.source_project_id === projectD && e.event === 'grant')).toBe(true);
    expect(await shareLinkStates(projectB)).toContainEqual(expect.objectContaining({
      source_slug: 'shr-test-d', current_source_slug: null, state: 'dark',
    }));
    await admin.query(`UPDATE projects SET metadata='{}'::jsonb WHERE id=$1`, [projectB]);
  });

  it('invalid MAI_LINKED_PROJECTS entries drop with a warning, no throw, no leak (spec T20)', async () => {
    await setLinked('shr-test-a, NOT A SLUG ,UPPER');
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...parts: unknown[]) => { warnings.push(parts.map(String).join(' ')); };
    try {
      const { linkedSlugsFromEnv } = await import('../shares.js');
      expect(linkedSlugsFromEnv()).toEqual(['shr-test-a']); // valid entry survives, invalid drop
      expect(warnings.join('\n')).toContain('dropped invalid MAI_LINKED_PROJECTS');
    } finally {
      console.warn = realWarn;
    }
    // …and an env of ONLY garbage/unknown slugs leaks nothing on any surface.
    await setLinked('UPPER,shr-test-nonexistent');
    const { resolveVisibleShares, primeSharedSection } = await import('../shares.js');
    const { unifiedSearch } = await import('../decisions.js');
    expect(await resolveVisibleShares(projectB)).toHaveLength(0);
    expect(await primeSharedSection(projectB)).toBeNull();
    expect(await unifiedSearch({ query: 'vault custody', kind: 'all', limit: 20 })).not.toContain('[from ');
  });

  it('audit cursor retrieves event 201 without duplicates at equal timestamps (spec T21)', async () => {
    await admin.query(
      `INSERT INTO share_events
         (share_id, source_project_id, target_project_id, event, source_slug, target_slug,
          artifact_kind, headline, actor_surface, created_at)
       SELECT gen_random_uuid(),$1,$2,'grant','shr-test-a','shr-test-b','decision',
              'PAGE-PROOF-' || g,'cli','2026-08-18T12:00:00Z'::timestamptz
         FROM generate_series(1,201) g`,
      [projectA, projectB]
    );
    const { shareEventsForProject } = await import('../shares.js');
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await shareEventsForProject(projectB, { cursor, limit: 100 });
      seen.push(...page.rows.filter((e) => e.headline.startsWith('PAGE-PROOF-')).map((e) => e.id));
      cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined);
    expect(seen).toHaveLength(201);
    expect(new Set(seen).size).toBe(201);
    await admin.query(`DELETE FROM share_events WHERE headline LIKE 'PAGE-PROOF-%'`);
  });
});

describe('prepared prime shared source (plan 38)', () => {
  it('renders six rows full, five in the legacy lane, and a bounded labelled headline block', async () => {
    await revokeAll();
    for (let i = 0; i < 6; i++) {
      const d = (await admin.query<{ id: string }>(
        `INSERT INTO code_decisions (project_id, decision_type, description, source)
         VALUES ($1,'architecture',$2,'user-approved') RETURNING id`,
        [projectA, `FOREIGN-MAX ${i} vault custody ${'m'.repeat(260)}`])).rows[0].id;
      await share('decision', d);
    }
    await setLinked('shr-test-a');
    const { preparePrimeSharedSection, primeSharedSection, resolveVisibleShares, shareLine } =
      await import('../shares.js');
    const prepared = await preparePrimeSharedSection(projectB);
    const visible = await resolveVisibleShares(projectB);
    expect(visible.length).toBeGreaterThanOrEqual(6);

    // legacyFull: the historical first-five-plus-pointer string, byte-for-byte.
    const expectedLegacy = [
      '## Shared from linked projects (read-only)', '',
      ...visible.slice(0, 5).map(shareLine), '',
      '_More shares available — mai_shared for the list/detail. Foreign ids are not citable._',
    ].join('\n');
    expect(prepared.legacyFull).toBe(expectedLegacy);
    expect(await primeSharedSection(projectB)).toBe(expectedLegacy);

    // The allocated lane renders all six rows from the SAME resolver result.
    expect(prepared.full.length).toBeGreaterThan(400);
    expect(prepared.full.split('[from shr-test-a').length - 1).toBe(6);
    expect(prepared.full).toContain('6 share(s) visible');
    expect(prepared.render()).toBe(prepared.full);
    expect(prepared.render(prepared.full.length)).toBe(prepared.full);

    // The approved 400-char floor buys one LABELLED headline row plus the
    // literal mai_shared route (decision 43ef92f9); the foreign-id warning is
    // pinned in the recovery minimum and both complete renders, because a
    // warning line here costs 66 chars and would evict the label row.
    const shortened = prepared.render(400);
    expect(shortened.length).toBeLessThanOrEqual(400);
    expect(shortened).toContain('[from shr-test-a');
    expect(shortened).toContain('mai_shared');
    expect(shortened).not.toContain('m'.repeat(260));
    expect(prepared.render(prepared.minimum.length)).toBe(prepared.minimum);
    expect(prepared.minimum).toContain('foreign ids are not citable');
    expect(prepared.full).toContain('Foreign ids are not citable');
    expect(prepared.legacyFull).toContain('Foreign ids are not citable');
    await revokeAll();
  });

  it('produces a genuinely empty source when nothing resolves', async () => {
    await revokeAll();
    await setLinked('shr-test-a');
    const { preparePrimeSharedSection } = await import('../shares.js');
    const prepared = await preparePrimeSharedSection(projectB);
    expect(prepared.full).toBe('');
    expect(prepared.minimum).toBe('');
    expect(prepared.legacyFull).toBeNull();
    expect(prepared.render(0)).toBe('');
    expect(prepared.render()).toBe('');
  });
});
