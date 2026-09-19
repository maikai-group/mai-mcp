/** Real process/DB regression for per-worker MCP ownership, not model output. */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db.js';

const exec = promisify(execFile);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bridge = path.join(root, 'scripts', 'mai-review-bridge.mjs');
const sessionScript = path.join(root, 'scripts', 'mai-worker-session.mjs');
const SLUG = 'worker-session-e2e';
const roots: string[] = [];
const children: ChildProcess[] = [];
const cleanups: Array<() => Promise<unknown>> = [];
const baseEnv = () => ({ ...process.env, MAI_PROJECT_SLUG: SLUG, MAI_PROJECT_ROOT: root, MAI_AGENT_ID: 'worker-session@test' });

beforeAll(async () => {
  await getPool().query('INSERT INTO projects (slug,name,path) VALUES ($1,$2,$3) ON CONFLICT (slug) DO NOTHING', [SLUG, 'Worker Session E2E', root]);
});

afterAll(async () => {
  for (const cleanup of cleanups) { try { await cleanup(); } catch { /* Forced teardown below never establishes success. */ } }
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 12000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
  await closePool();
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

async function start(extra: NodeJS.ProcessEnv = {}, runtimeRoot = root) {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "worker session's ")));
  roots.push(parent);
  const dir = path.join(parent, 'session');
  const env = { ...baseEnv(), ...extra, MAI_BRIDGE_SESSION_DIR: dir };
  const child = spawn(process.execPath, [path.join(runtimeRoot, 'scripts', 'mai-worker-session.mjs'), 'serve', dir], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let errors = '';
  child.stderr?.on('data', data => { errors += data.toString(); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('session readiness timeout: ' + errors)), 20000);
    let output = '';
    child.stdout?.on('data', data => {
      output += data.toString();
      if (output.includes('"state":"ready"')) { clearTimeout(timer); resolve(); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`session exited ${code}: ${errors}`)); });
  });
  const call = (tool: string, args: Record<string, unknown>, override: NodeJS.ProcessEnv = {}) =>
    exec(process.execPath, [path.join(runtimeRoot, 'scripts', 'mai-review-bridge.mjs'), tool, JSON.stringify(args)], { env: { ...env, ...override }, timeout: 25000, maxBuffer: 5 * 1024 * 1024 });
  const callFile = (tool: string, args: Record<string, unknown>) => {
    const file = path.join(parent, 'payload.json');
    fs.writeFileSync(file, JSON.stringify(args), { mode: 0o600 });
    return exec(process.execPath, [path.join(runtimeRoot, 'scripts', 'mai-review-bridge.mjs'), tool, '--file', file], { env, timeout: 25000 });
  };
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      await exec(process.execPath, [sessionScript, 'close', dir], { env, timeout: 12000 });
    }
  });
  const close = async () => {
    const result = await exec(process.execPath, [sessionScript, 'close', dir], { env, timeout: 20000 });
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('exit', resolve));
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'))).toMatchObject({ state: 'closed', cleanupVerified: true });
    return result;
  };
  return { call, callFile, close, dir, env, child };
}

function claimId(text: string): string {
  const id = /(?:claimed |already claimed as )([a-f0-9-]{36})/.exec(text)?.[1];
  if (!id) throw new Error('missing claim id: ' + text);
  return id;
}

async function state(id: string) {
  const result = await getPool().query<{ status: string; author_session: string; last_heartbeat_at: Date }>(
    'SELECT status,author_session,last_heartbeat_at FROM agent_claims WHERE id=$1', [id]);
  if (!result.rows[0]) throw new Error('missing stored claim');
  return result.rows[0];
}

describe('worker session bridge', () => {
  it('requires prime, preserves ownership across separate shell calls, and proves release in storage', async () => {
    const worker = await start();
    await expect(worker.call('mai_claims', {})).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('mai_prime first') });
    await worker.call('mai_prime', { task_description: 'Worker session lifecycle regression' });
    const args = { paths: ['probe/worker-one.ts'], intent: 'worker session lifecycle regression' };
    const first = await worker.call('mai_claim', args);
    const id = claimId(first.stdout);
    const before = await state(id);
    const again = await worker.call('mai_claim', args);
    expect(claimId(again.stdout)).toBe(id);
    const after = await state(id);
    expect(after.author_session).toBe(before.author_session);
    expect(after.last_heartbeat_at.getTime()).toBeGreaterThanOrEqual(before.last_heartbeat_at.getTime());
    expect((await worker.call('mai_claims', {})).stdout).toContain('(YOU)');
    await worker.call('mai_claim', { release: id });
    expect((await state(id)).status).toBe('released');
    await expect(worker.call('mai_claim', { release: id })).rejects.toMatchObject({ code: 1 });
    await worker.close();
  });

  it('closes forgotten claims on the same owning process', async () => {
    const worker = await start();
    await worker.call('mai_prime', { task_description: 'Worker session cleanup regression' });
    const id = claimId((await worker.call('mai_claim', { paths: ['probe/forgotten.ts'], intent: 'forgotten claim' })).stdout);
    await worker.close();
    expect((await state(id)).status).toBe('released');
    await expect(worker.call('mai_claims', {})).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('session is not ready') });
  });

  it('keeps two workers distinct and rejects a foreign release with nonzero exit', async () => {
    const left = await start();
    const right = await start();
    await left.call('mai_prime', { task_description: 'left worker identity' });
    await right.call('mai_prime', { task_description: 'right worker identity' });
    const id = claimId((await left.call('mai_claim', { paths: ['probe/left.ts'], intent: 'left-owned lane' })).stdout);
    await expect(right.call('mai_claim', { release: id })).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('YOUR active claims') });
    expect((await state(id)).status).toBe('active');
    await right.close();
    expect((await state(id)).status).toBe('active');
    await left.close();
    expect((await state(id)).status).toBe('released');
  });

  it('rejects wrong project binding, existing directories, and a public POSIX session directory', async () => {
    const worker = await start();
    await expect(worker.call('mai_prime', { task_description: 'wrong scope' }, { MAI_PROJECT_SLUG: 'other-project' })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('mismatch') });
    await expect(exec(process.execPath, [sessionScript, 'serve', worker.dir], { env: worker.env })).rejects.toMatchObject({ code: 1 });
    await worker.close();
    if (process.platform !== 'win32') {
      fs.chmodSync(worker.dir, 0o755);
      await expect(worker.call('mai_prime', { task_description: 'unsafe permissions' })).rejects.toMatchObject({ code: 1 });
      fs.chmodSync(worker.dir, 0o700);
    }
  });

  it('refuses oversized payloads and does not silently fall back for a missing session', async () => {
    const worker = await start();
    await expect(worker.callFile('mai_prime', { task_description: 'x'.repeat(1100000) })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('oversized') });
    await expect(worker.call('mai_claims', {}, { MAI_BRIDGE_SESSION_DIR: path.join(worker.dir, 'missing') })).rejects.toMatchObject({ code: 1 });
    await worker.close();
  });

  it.skipIf(process.platform === 'win32')('releases claims on SIGTERM and keeps session data private', async () => {
    const worker = await start();
    await worker.call('mai_prime', { task_description: 'signal cleanup regression' });
    const id = claimId((await worker.call('mai_claim', { paths: ['probe/signal.ts'], intent: 'signal cleanup' })).stdout);
    const exited = new Promise(resolve => worker.child.once('exit', resolve));
    worker.child.kill('SIGTERM');
    await exited;
    expect(worker.child.exitCode).toBe(0);
    expect((await state(id)).status).toBe('released');
    if (process.platform !== 'win32') {
      expect(fs.statSync(worker.dir).mode & 0o077).toBe(0);
      expect(fs.statSync(path.join(worker.dir, 'session.json')).mode & 0o077).toBe(0);
    }
  });

  it('heartbeats while the worker makes no brain calls', async () => {
    const worker = await start();
    await worker.call('mai_prime', { task_description: 'idle worker heartbeat' });
    const id = claimId((await worker.call('mai_claim', { paths: ['probe/heartbeat.ts'], intent: 'idle heartbeat' })).stdout);
    const before = (await state(id)).last_heartbeat_at.getTime();
    const deadline = Date.now() + 75000;
    let after = before;
    while (after === before && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
      after = (await state(id)).last_heartbeat_at.getTime();
    }
    expect(after).toBeGreaterThan(before);
    await worker.close();
  }, 90000);

  it('rejects a symlink descriptor without following it', async () => {
    if (process.platform === 'win32') return; // Symlink creation can require a host privilege.
    const worker = await start();
    await worker.close();
    const descriptor = path.join(worker.dir, 'session.json');
    const original = path.join(worker.dir, 'saved.json');
    fs.renameSync(descriptor, original);
    fs.symlinkSync(original, descriptor);
    await expect(worker.call('mai_prime', { task_description: 'symlink rejection' })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('invalid or oversized') });
  });
});

// Only these copied-runtime fixtures simulate protocol frames. Ownership above uses the real DB/server.
const protocolFixture = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const log = value => fs.appendFileSync(path.join(__dirname, 'calls.log'), value + '\n');
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const content = text => ({ content: [{ type: 'text', text }] });
fs.writeFileSync(path.join(__dirname, 'pid'), String(process.pid));
readline.createInterface({ input: process.stdin }).on('close', () => process.exit(0)).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return reply(m.id, {});
  if (m.method !== 'tools/call') return;
  const { name, arguments: args } = m.params;
  log('begin:' + name);
  const done = result => { log('end:' + name); reply(m.id, result); };
  if (name === 'mai_prime') return done(content('primed fixture'));
  if (name === 'mai_claim') return done(content('no active claims of yours to release.'));
  if (args.mode === 'timeout') return;
  if (args.mode === 'crash') return process.exit(9);
  if (args.mode === 'malformed') return process.stdout.write(args.frame + '\n');
  if (args.mode === 'wait') return setTimeout(() => done(content('waited')), 500);
  if (args.mode === 'large') return done(content('水🙂'.repeat(150000)));
  if (args.mode === 'boundary' || args.mode === 'over' || args.mode === 'multi') {
    const envelope = JSON.stringify({ jsonrpc: '2.0', id: m.id, result: content('') });
    const size = 4 * 1024 * 1024 + (args.mode === 'over' ? 1 : 0);
    const frame = JSON.stringify({ jsonrpc: '2.0', id: m.id, result: content('x'.repeat(size - Buffer.byteLength(envelope))) });
    const notification = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { text: 'x'.repeat(3000000) } });
    return process.stdout.write((args.mode === 'multi' ? notification + '\n' : '') + frame + '\n');
  }
  done(content('ok'));
});
`;

async function fixture() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-protocol-')));
  roots.push(dir);
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'build'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}');
  fs.copyFileSync(sessionScript, path.join(dir, 'scripts', 'mai-worker-session.mjs'));
  fs.copyFileSync(bridge, path.join(dir, 'scripts', 'mai-review-bridge.mjs'));
  fs.writeFileSync(path.join(dir, 'build', 'index.js'), protocolFixture);
  const worker = await start({}, dir);
  await worker.call('mai_prime', { task_description: 'protocol fixture only' });
  return { ...worker, fixtureRoot: dir, log: () => fs.readFileSync(path.join(dir, 'build', 'calls.log'), 'utf8') };
}

async function exited(child: ChildProcess, ms = 12000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('owned process did not exit')), ms);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

function descriptor(dir: string) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
}

async function pollUntil(predicate: () => boolean, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function rawRequest(dir: string, session: string, op = 'call') {
  const id = randomUUID();
  const file = path.join(dir, `request-${id}.json`);
  const temporary = path.join(dir, `.test-${id}`);
  fs.writeFileSync(temporary, JSON.stringify({ id, session, deadline: Date.now() + 10000, op, tool: 'mai_probe', args: {} }), { mode: 0o600 });
  fs.renameSync(temporary, file);
  return id;
}

describe('worker session transport failures', () => {
  it.each(['null', '[]', 'true', '{"jsonrpc":"1.0","id":2}', '{broken'])('records controlled failure for frame %s', async frame => {
    const worker = await fixture();
    await expect(worker.call('mai_probe', { mode: 'malformed', frame })).rejects.toMatchObject({ code: 1 });
    await exited(worker.child);
    expect(worker.child.exitCode).toBe(1);
    expect(descriptor(worker.dir)).toMatchObject({ state: 'failed', cleanupVerified: false });
    const pid = Number(fs.readFileSync(path.join(worker.fixtureRoot, 'build', 'pid'), 'utf8'));
    await pollUntil(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  });

  it.each(['timeout', 'crash'])('does not retry an uncertain %s', async mode => {
    const worker = await fixture();
    await expect(worker.call('mai_probe', { mode }, { MAI_BRIDGE_TIMEOUT_MS: '500' })).rejects.toMatchObject({ code: 1 });
    await exited(worker.child);
    expect(descriptor(worker.dir)).toMatchObject({ state: 'failed', cleanupVerified: false });
    expect(worker.log().split('\n').filter(line => line === 'begin:mai_probe')).toHaveLength(1);
  });

  it('drains complete multibyte output and bounds an unread stdout pipe', async () => {
    const worker = await fixture();
    expect((await worker.call('mai_probe', { mode: 'large' })).stdout).toBe('水🙂'.repeat(150000) + '\n');
    const child = spawn(process.execPath, [path.join(worker.fixtureRoot, 'scripts', 'mai-review-bridge.mjs'), 'mai_probe', '{"mode":"large"}'], {
      env: { ...worker.env, MAI_BRIDGE_TIMEOUT_MS: '500' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    child.stderr?.resume(); // Deliberately never drain stdout.
    await exited(child, 5000);
    expect(child.exitCode).toBe(1);
    expect(worker.log().split('\n').filter(line => line === 'begin:mai_probe')).toHaveLength(2);
    await worker.close();
  });

  it.each(['boundary', 'multi'])('accepts an exact-limit frame (%s) with private-envelope overhead', async mode => {
    const worker = await fixture();
    const output = (await worker.call('mai_probe', { mode })).stdout;
    expect(output.length).toBeGreaterThan(4 * 1024 * 1024 - 200);
    expect(output.endsWith('\n')).toBe(true);
    await worker.close();
  });

  it('rejects a frame one byte above the wire limit', async () => {
    const worker = await fixture();
    await expect(worker.call('mai_probe', { mode: 'over' })).rejects.toMatchObject({ code: 1 });
    await exited(worker.child);
    expect(descriptor(worker.dir)).toMatchObject({ state: 'failed', cleanupVerified: false });
  });

  it('serializes concurrent callers without overlapping server work', async () => {
    const worker = await fixture();
    await Promise.all([1, 2, 3].map(() => worker.call('mai_probe', { mode: 'wait' })));
    expect(worker.log().split('\n').filter(line => line.endsWith(':mai_probe'))).toEqual([
      'begin:mai_probe', 'end:mai_probe', 'begin:mai_probe', 'end:mai_probe', 'begin:mai_probe', 'end:mai_probe',
    ]);
    await worker.close();
  });

  it('rejects a mismatched nonce without reaching the server', async () => {
    const worker = await fixture();
    const id = rawRequest(worker.dir, randomUUID());
    const response = path.join(worker.dir, `response-${id}.json`);
    await pollUntil(() => fs.existsSync(response));
    expect(JSON.parse(fs.readFileSync(response, 'utf8')).result.isError).toBe(true);
    expect(worker.log()).not.toContain('mai_probe');
    await worker.close();
  });

  it('fails a queue over 32 requests and verifies same-session cleanup', async () => {
    const worker = await fixture();
    const held = worker.call('mai_probe', { mode: 'wait' });
    await pollUntil(() => worker.log().includes('begin:mai_probe'));
    const nonce = descriptor(worker.dir).id;
    for (let n = 0; n < 33; n++) rawRequest(worker.dir, nonce);
    await held;
    await exited(worker.child);
    expect(worker.child.exitCode).toBe(1);
    expect(descriptor(worker.dir)).toMatchObject({ state: 'failed', cleanupVerified: true });
    expect(worker.log().split('\n').filter(line => line === 'begin:mai_probe')).toHaveLength(1);
  });

  it.skipIf(process.platform !== 'win32')('does not report cleanup success after Windows force termination', async () => {
    const worker = await fixture();
    worker.child.kill('SIGTERM');
    await exited(worker.child);
    expect(worker.child.exitCode).not.toBe(0);
    expect(descriptor(worker.dir).cleanupVerified).toBe(false);
  });
});
