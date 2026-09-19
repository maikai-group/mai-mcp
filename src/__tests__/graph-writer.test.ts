import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { Client, Pool, type QueryConfig } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';

const DB = requireDisposableTestDbUrl();
process.env.MAI_DB_URL = DB;
const admin = new Pool({ connectionString: DB });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await admin.end();
  const { closePool } = await import('../db.js');
  await closePool();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function childExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

describe('complete graph writer lease', () => {
  it('excludes same-project work while another project and reads proceed', async () => {
    const { withGraphWriter, GraphWriterBusyError } = await import('../graph/writer.js');
    const key = crypto.randomUUID();
    const entered = deferred<void>();
    const release = deferred<void>();
    const first = withGraphWriter(key, async () => { entered.resolve(); await release.promise; return 11; });
    try {
      await entered.promise;
      let competed = false;
      await expect(withGraphWriter(key.toUpperCase(), async () => { competed = true; }))
        .rejects.toBeInstanceOf(GraphWriterBusyError);
      expect(competed).toBe(false);
      expect(await withGraphWriter(crypto.randomUUID(), async () => 22)).toBe(22);
      expect((await admin.query<{ n: number }>('SELECT 1::integer AS n')).rows[0].n).toBe(1);
    } finally { release.resolve(); await first; }
    expect(await withGraphWriter(key, async () => 33)).toBe(33);
  });

  it('releases after work fails and preserves its error', async () => {
    const { withGraphWriter } = await import('../graph/writer.js');
    const key = crypto.randomUUID();
    const failure = new Error('owned test work failed');
    await expect(withGraphWriter(key, async () => { throw failure; })).rejects.toBe(failure);
    expect(await withGraphWriter(key, async () => 'reacquired')).toBe('reacquired');
  });

  it('closes an uncertain acquisition result without starting work or leaking its lock', async () => {
    const { withGraphWriter } = await import('../graph/writer.js');
    const key = crypto.randomUUID();
    const originalQuery: (config: string | QueryConfig) => Promise<unknown> = Client.prototype.query;
    let backend = 0;
    vi.spyOn(Client.prototype, 'query').mockImplementationOnce(async function (
      this: Client, config: string | QueryConfig,
    ) {
      await originalQuery.call(this, config); // Server really acquired the session lock.
      const rows = await admin.query<{ pid: number }>(
        `SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid
         WHERE a.datname = current_database() AND a.application_name = 'mai-graph-writer'
           AND l.locktype = 'advisory' AND l.classid = 1735553392::oid
           AND l.objid = hashtext($1)::oid AND l.objsubid = 2 AND l.granted`, [key],
      );
      expect(rows.rows).toHaveLength(1);
      backend = rows.rows[0].pid;
      throw new Error('uncertain-result-secret'); // Transport result was lost after acquisition.
    });
    let ran = false;
    await expect(withGraphWriter(key, async () => { ran = true; }))
      .rejects.toThrow('Cannot acquire graph writer lease; check the brain database and retry.');
    expect(ran).toBe(false);
    expect(backend).toBeGreaterThan(0);
    await vi.waitFor(async () => {
      expect((await admin.query('SELECT pid FROM pg_stat_activity WHERE pid=$1', [backend])).rows).toHaveLength(0);
    }, { timeout: 3000, interval: 25 });
    expect(await withGraphWriter(key, async () => 'reacquired')).toBe('reacquired');
  });

  it('finishes closing if the dedicated socket is interrupted during shutdown', async () => {
    const { withGraphWriter } = await import('../graph/writer.js');
    const key = crypto.randomUUID();
    const originalEnd: () => Promise<void> = Client.prototype.end;
    let backend = 0;
    vi.spyOn(Client.prototype, 'end').mockImplementationOnce(async function (this: Client) {
      this.connection.stream.destroy(new Error('owned closing fault'));
      await originalEnd.call(this);
    });
    expect(await withGraphWriter(key, async () => {
      const rows = await admin.query<{ pid: number }>(
        `SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid
         WHERE a.datname = current_database() AND a.application_name = 'mai-graph-writer'
           AND l.locktype = 'advisory' AND l.classid = 1735553392::oid
           AND l.objid = hashtext($1)::oid AND l.objsubid = 2 AND l.granted`, [key],
      );
      expect(rows.rows).toHaveLength(1);
      backend = rows.rows[0].pid;
      return 77;
    })).toBe(77);
    await vi.waitFor(async () => {
      expect((await admin.query('SELECT pid FROM pg_stat_activity WHERE pid=$1', [backend])).rows).toHaveLength(0);
    }, { timeout: 3000, interval: 25 });
    expect(await withGraphWriter(key, async () => 'reacquired')).toBe('reacquired');
  });

  it.each(['build', 'update'])('guards %s before even reading an invalid project', async (verb) => {
    const { withGraphWriter, GraphWriterBusyError } = await import('../graph/writer.js');
    const key = crypto.randomUUID(); // No project row: without the guard this fails with missing project/roots.
    const run = verb === 'build'
      ? (await import('../graph/build.js')).runGraphBuild
      : (await import('../graph/update.js')).runGraphUpdate;
    await withGraphWriter(key, async () => {
      await expect(run({ projectId: key, slug: 'writer-test' })).rejects.toBeInstanceOf(GraphWriterBusyError);
    });
    await expect(run({ projectId: key, slug: 'writer-test' })).rejects.not.toBeInstanceOf(GraphWriterBusyError);
    expect(await withGraphWriter(key, async () => true)).toBe(true);
  });

  it('terminates a child on lease loss instead of letting its callback continue', async () => {
    const key = crypto.randomUUID();
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { withGraphWriter } from './build/graph/writer.js';
      await withGraphWriter(process.env.MAI_WRITER_TEST_KEY, async () => {
        process.stdout.write('HELD\\n');
        setInterval(() => {}, 1000);
        await new Promise(resolve => setTimeout(resolve, 15000));
        process.stdout.write('UNSAFE-CONTINUATION\\n');
      });
    `], { cwd: process.cwd(), env: { ...process.env, MAI_DB_URL: DB, MAI_WRITER_TEST_KEY: key }, stdio: ['ignore', 'pipe', 'pipe'] });
    const done = childExit(child);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    const deadline = setTimeout(() => { child.kill('SIGKILL'); }, 10000);
    try {
      await new Promise<void>((resolve, reject) => {
        const poll = setInterval(() => {
          if (stdout.includes('HELD\n')) { clearInterval(poll); resolve(); }
        }, 20);
        void done.then(() => { clearInterval(poll); reject(new Error('writer child exited before HELD')); }, reject);
      });
      const holder = await admin.query<{ pid: number }>(
        `SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid
         WHERE a.datname = current_database() AND a.application_name = 'mai-graph-writer'
           AND l.locktype = 'advisory' AND l.classid = 1735553392::oid
           AND l.objid = hashtext($1)::oid AND l.objsubid = 2 AND l.granted`, [key],
      );
      expect(holder.rows).toHaveLength(1);
      await admin.query('SELECT pg_terminate_backend($1)', [holder.rows[0].pid]);
      const result = await done;
      expect(result).toEqual({ code: 1, signal: null });
      expect(stderr).toContain('Graph writer lease lost');
      expect(stdout).not.toContain('UNSAFE-CONTINUATION');
      const { withGraphWriter } = await import('../graph/writer.js');
      expect(await withGraphWriter(key, async () => 'recovered')).toBe('recovered');
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await done;
    }
  }, 20000);
});
