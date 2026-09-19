import { afterAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { Client, Pool } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';

const DB = requireDisposableTestDbUrl();
process.env.MAI_DB_URL = DB;
const admin = new Pool({ connectionString: DB });
afterAll(async () => {
  await admin.end();
  await (await import('../db.js')).closePool();
});

function exitOf(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

describe('graph writer session fencing', () => {
  it('uses the lock session across queries and transactions, and restores nested scopes', async () => {
    const { withGraphWriter } = await import('../graph/writer.js');
    const { getPool } = await import('../db.js');
    const shared = getPool();
    const key = crypto.randomUUID();
    await withGraphWriter(key, async () => {
      const scoped = getPool();
      expect(scoped).not.toBe(shared);
      const pid = (await scoped.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const lock = await admin.query<{ pid: number }>(
        `SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=1735553392::oid
         AND objid=hashtext($1)::oid AND objsubid=2 AND granted`, [key],
      );
      expect(lock.rows.map(row => row.pid)).toEqual([pid]);
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        expect((await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid).toBe(pid);
        await client.query('COMMIT');
      } finally { client.release(); }
      expect((await getPool().query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid).toBe(pid);
      const failure = new Error('nested failure');
      await expect(withGraphWriter(crypto.randomUUID(), async () => {
        expect(getPool()).not.toBe(scoped);
        expect((await getPool().query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid).not.toBe(pid);
        throw failure;
      })).rejects.toBe(failure);
      expect(getPool()).toBe(scoped);
    });
    expect(getPool()).toBe(shared);
    const pools = await Promise.all([1, 2].map(async () => withGraphWriter(crypto.randomUUID(), async () => {
      const scoped = getPool();
      await new Promise(resolve => setImmediate(resolve));
      expect(getPool()).toBe(scoped);
      return scoped;
    })));
    expect(pools[0]).not.toBe(pools[1]);
    expect(getPool()).toBe(shared);
    await expect(pools[0].query('SELECT 1')).rejects.toThrow();
  });

  it('stops instead of replacing a retired writer session', async () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { withGraphWriter } from './build/graph/writer.js';
      import { getPool } from './build/db.js';
      await withGraphWriter(process.env.MAI_WRITER_TEST_KEY, async () => {
        const client = await getPool().connect();
        client.release(true);
        await getPool().query('SELECT 1');
        console.log('UNSAFE-RECONNECTED');
      });
    `], { cwd: process.cwd(), env: { ...process.env, MAI_DB_URL: DB, MAI_WRITER_TEST_KEY: crypto.randomUUID() }, stdio: ['ignore', 'pipe', 'pipe'] });
    const done = exitOf(child);
    let output = '';
    let errors = '';
    child.stdout?.on('data', chunk => { output += String(chunk); });
    child.stderr?.on('data', chunk => { errors += String(chunk); });
    const deadline = setTimeout(() => child.kill('SIGKILL'), 8000);
    try {
      expect(await done).toEqual({ code: 1, signal: null });
      expect(output).not.toContain('UNSAFE-RECONNECTED');
      expect(errors).toContain('Graph writer lease lost');
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await done;
    }
  });

  it('fences real writes when silent lease loss lets a replacement acquire the project', async () => {
    const url = new URL(DB);
    const key = crypto.randomUUID();
    const replacement = new Client({ connectionString: DB });
    const sockets = new Set<net.Socket>();
    let first: net.Socket | undefined;
    let isolated = false;
    let connections = 0;
    let isolatedBytes = 0;
    const proxy = net.createServer({ allowHalfOpen: true }, downstream => {
      connections++;
      const isOwner = first === undefined;
      if (isOwner) first = downstream;
      const upstream = net.connect({ host: url.hostname, port: Number(url.port) });
      sockets.add(downstream); sockets.add(upstream);
      downstream.on('data', chunk => {
        if (isOwner && isolated) isolatedBytes += chunk.length;
        else upstream.write(chunk);
      });
      upstream.on('data', chunk => { if (!(isOwner && isolated)) downstream.write(chunk); });
      upstream.on('end', () => { if (!(isOwner && isolated)) downstream.end(); });
      downstream.on('end', () => upstream.end());
      for (const socket of [downstream, upstream]) socket.on('error', () => {});
    });
    let child: ChildProcess | undefined;
    let done: ReturnType<typeof exitOf> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let stdout = '';
    let stderr = '';
    try {
      await admin.query('CREATE TABLE IF NOT EXISTS graph_writer_fencing_test (id uuid PRIMARY KEY, marker text NOT NULL)');
      await admin.query('INSERT INTO graph_writer_fencing_test VALUES ($1, $2)', [key, 'initial']);
      await replacement.connect();
      await new Promise<void>((resolve, reject) => {
        proxy.once('error', reject);
        proxy.listen(0, '127.0.0.1', resolve);
      });
      const address = proxy.address();
      if (!address || typeof address === 'string') throw new Error('missing proxy address');
      const proxied = new URL(url);
      proxied.hostname = '127.0.0.1'; proxied.port = String(address.port);
      child = spawn(process.execPath, ['--input-type=module', '-e', `
        import { withGraphWriter } from './build/graph/writer.js';
        import { getPool, closePool } from './build/db.js';
        await withGraphWriter(process.env.MAI_WRITER_TEST_KEY, async () => {
          console.log('HELD');
          await new Promise(resolve => process.stdin.once('data', resolve));
          console.log('ATTEMPT');
          await getPool().query('UPDATE graph_writer_fencing_test SET marker=$2 WHERE id=$1', [process.env.MAI_WRITER_TEST_KEY, 'stale']);
          console.log('STALE-WRITTEN');
          await new Promise(resolve => setTimeout(resolve, 10000));
        });
        await closePool();
      `], { cwd: process.cwd(), env: { ...process.env, MAI_DB_URL: proxied.href, MAI_WRITER_TEST_KEY: key }, stdio: ['pipe', 'pipe', 'pipe'] });
      done = exitOf(child);
      child.stdout?.on('data', chunk => { stdout += String(chunk); });
      child.stderr?.on('data', chunk => { stderr += String(chunk); });
      const ownedChild = child;
      deadline = setTimeout(() => ownedChild.kill('SIGKILL'), 12000);
      await vi.waitFor(() => expect(stdout).toContain('HELD'), { timeout: 4000, interval: 20 });
      const holder = await admin.query<{ pid: number }>(
        `SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
         WHERE a.datname=current_database() AND a.application_name='mai-graph-writer'
         AND l.locktype='advisory' AND l.classid=1735553392::oid
         AND l.objid=hashtext($1)::oid AND l.objsubid=2 AND l.granted`, [key],
      );
      expect(holder.rows).toHaveLength(1);
      isolated = true;
      await admin.query('SELECT pg_terminate_backend($1)', [holder.rows[0].pid]);
      await vi.waitFor(async () => {
        expect((await admin.query('SELECT pid FROM pg_stat_activity WHERE pid=$1', [holder.rows[0].pid])).rows).toHaveLength(0);
      }, { timeout: 3000, interval: 20 });
      expect((await replacement.query<{ held: boolean }>('SELECT pg_try_advisory_lock(1735553392,hashtext($1)) AS held', [key])).rows[0].held).toBe(true);
      await replacement.query('UPDATE graph_writer_fencing_test SET marker=$2 WHERE id=$1', [key, 'replacement']);
      child.stdin?.write('write now\n');
      await vi.waitFor(() => {
        expect(stdout).toContain('ATTEMPT');
        expect(isolatedBytes > 0 || stdout.includes('STALE-WRITTEN')).toBe(true);
      }, { timeout: 3000, interval: 20 });
      expect((await admin.query<{ marker: string }>('SELECT marker FROM graph_writer_fencing_test WHERE id=$1', [key])).rows[0].marker).toBe('replacement');
      expect(stdout).not.toContain('STALE-WRITTEN');
      expect(connections).toBe(1);
      first?.destroy();
      expect(await done).toEqual({ code: 1, signal: null });
      expect(stderr).toContain('Graph writer lease lost');
    } finally {
      if (deadline) clearTimeout(deadline);
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (done) await done;
      for (const socket of sockets) socket.destroy();
      if (proxy.listening) await new Promise<void>(resolve => proxy.close(() => resolve()));
      await replacement.end();
      await admin.query('DELETE FROM graph_writer_fencing_test WHERE id=$1', [key]);
    }
  }, 20000);
});
