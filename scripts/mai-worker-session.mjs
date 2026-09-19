#!/usr/bin/env node
// A private filesystem channel to one foreground MCP server process.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REQUEST_LIMIT = 1024 * 1024;
const WIRE_LIMIT = 4 * 1024 * 1024; // One JSON frame, excluding its newline.
const RESULT_LIMIT = WIRE_LIMIT + 1024; // Bounded private correlation envelope.
const POLL_MS = 50;
const CALL_MS = 120000;
const LIFETIME_MS = 4 * 60 * 60 * 1000;
const HEARTBEAT_MS = 30000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const REQUEST_NAME = /^request-([a-f0-9-]{36})\.json$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const outputText = result => Array.isArray(result?.content)
  ? result.content.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '';

function callBudget(env) {
  const ms = env.MAI_BRIDGE_TIMEOUT_MS === undefined ? CALL_MS : Number(env.MAI_BRIDGE_TIMEOUT_MS);
  if (!Number.isSafeInteger(ms) || ms < 100 || ms > CALL_MS) throw new Error('MAI_BRIDGE_TIMEOUT_MS must be 100..120000');
  return ms;
}

function contract(env) {
  if (!env.MAI_PROJECT_SLUG || !env.MAI_PROJECT_ROOT || !path.isAbsolute(env.MAI_PROJECT_ROOT)) {
    throw new Error('MAI_PROJECT_SLUG and absolute MAI_PROJECT_ROOT are required');
  }
  return { project: env.MAI_PROJECT_SLUG, root: fs.realpathSync.native(env.MAI_PROJECT_ROOT) };
}

function privateDirectory(dir) {
  if (!path.isAbsolute(dir)) throw new Error('session directory must be absolute');
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('session directory must be a real directory');
  if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())) {
    throw new Error('session directory must be private and owned by this user');
  }
}

function readJson(file, limit) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) {
    throw new Error('invalid or oversized session file');
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit || stat.ino !== before.ino || stat.dev !== before.dev) {
      throw new Error('session file changed while opening');
    }
    const buffer = Buffer.alloc(limit + 1);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (count > limit) throw new Error('oversized session file');
    return JSON.parse(buffer.subarray(0, count).toString('utf8'));
  } finally { fs.closeSync(fd); }
}

function publish(dir, name, value, limit) {
  privateDirectory(dir);
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > limit) throw new Error('oversized session response');
  const temporary = path.join(dir, `.write-${randomUUID()}`);
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, path.join(dir, name));
  } finally { try { fs.unlinkSync(temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}

function metadata(dir, env, allowClosed = false) {
  privateDirectory(dir);
  const meta = readJson(path.join(dir, 'session.json'), 16384);
  const expected = contract(env);
  if (!object(meta) || meta.version !== 1 || !UUID.test(meta.id) || meta.project !== expected.project
    || meta.root !== expected.root || !Number.isSafeInteger(meta.pid) || meta.pid <= 0) {
    throw new Error('session identity or project mismatch');
  }
  if (!allowClosed && meta.state !== 'ready') throw new Error('session is not ready; do not fall back to a one-shot server');
  return meta;
}

export async function requestSession(dir, request, env = process.env) {
  const meta = metadata(dir, env);
  const id = randomUUID();
  const filename = `request-${id}.json`;
  const response = path.join(dir, `response-${id}.json`);
  const deadline = Date.now() + callBudget(env);
  publish(dir, filename, { ...request, id, session: meta.id, deadline }, REQUEST_LIMIT);
  try {
    while (Date.now() <= deadline) {
      try {
        const result = readJson(response, RESULT_LIMIT);
        if (!object(result) || result.id !== id || result.session !== meta.id || !object(result.result)) {
          throw new Error('invalid session response');
        }
        return result.result;
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const current = metadata(dir, env, true);
      if (current.id !== meta.id || current.state === 'failed') throw new Error('session failed; tool outcome may be unknown; do not retry a write');
      if (current.state === 'closed' && request.op !== 'close') throw new Error('session closed before response');
      await delay(POLL_MS);
    }
    throw new Error('session request timed out; outcome may be unknown; do not retry a write');
  } finally {
    for (const file of [response, path.join(dir, filename)]) {
      try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
}

function connectServer(env) {
  const budget = callBudget(env);
  const child = spawn(process.execPath, [path.join(HERE, '..', 'build', 'index.js')], {
    env: { ...env, MAI_AGENT_ID: env.MAI_AGENT_ID || 'worker@bridge' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let serial = 0;
  let buffer = '';
  let failed;
  const pending = new Map();
  const fail = error => {
    failed ??= error;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(failed); }
    pending.clear();
  };
  child.on('error', fail);
  child.on('exit', () => fail(new Error('MCP server exited; outstanding tool outcome may be unknown')));
  child.stdin.on('error', fail);
  child.stderr.on('data', () => {});
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (Buffer.byteLength(line) > WIRE_LIMIT) { fail(new Error('MCP response exceeds session bound')); child.kill('SIGTERM'); return; }
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { fail(new Error('invalid MCP JSON')); child.kill('SIGTERM'); return; }
      if (!object(message) || message.jsonrpc !== '2.0'
        || (message.id === undefined ? typeof message.method !== 'string' : !Number.isSafeInteger(message.id))
        || (message.error !== undefined && !object(message.error))) {
        fail(new Error('invalid MCP message shape')); child.kill('SIGTERM'); return;
      }
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`MCP protocol error: ${message.error.code}`));
      else if (!object(message.result)) entry.reject(new Error('invalid MCP result'));
      else entry.resolve(message.result);
    }
    if (Buffer.byteLength(buffer) > WIRE_LIMIT) { fail(new Error('MCP response exceeds session bound')); child.kill('SIGTERM'); }
  });
  const send = (method, params, timeout = budget) => new Promise((resolve, reject) => {
    if (failed) { reject(failed); return; }
    const id = ++serial;
    const timer = setTimeout(() => {
      fail(new Error('MCP call timed out; outcome may be unknown'));
      child.kill('SIGTERM');
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return {
    child,
    async initialize() {
      await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mai-worker-session', version: '1.0.0' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    },
    call: (name, args, timeout) => send('tools/call', { name, arguments: args }, timeout),
    check() { if (failed) throw failed; },
    async close() {
      child.stdin.end();
      if (child.exitCode !== null || child.signalCode !== null) return;
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(1000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
  };
}

const errorResult = message => ({ isError: true, content: [{ type: 'text', text: message }] });

export async function serveSession(dir, env = process.env) {
  const pinned = contract(env);
  if (!path.isAbsolute(dir)) throw new Error('session directory must be absolute');
  fs.mkdirSync(dir, { mode: 0o700 }); // Existing directories, including symlinks, are rejected.
  privateDirectory(dir);
  const meta = { version: 1, id: randomUUID(), pid: process.pid, ...pinned, state: 'starting', cleanupVerified: false };
  const save = () => publish(dir, 'session.json', meta, 16384);
  save();
  const rpc = connectServer(env);
  let primed = false;
  let stopping = false;
  let shutdownTimer;
  let exitCode = 0;
  let nextHeartbeat = Date.now() + HEARTBEAT_MS;
  const began = Date.now();
  const signal = () => {
    stopping = true;
    shutdownTimer ??= setTimeout(() => rpc.child.kill('SIGKILL'), 10000);
  };
  const lifetimeTimer = setTimeout(signal, LIFETIME_MS);
  process.on('SIGTERM', signal); process.on('SIGINT', signal);
  const release = async () => {
    if (!primed) { meta.cleanupVerified = true; return; }
    const result = await rpc.call('mai_claim', { release_all: true }, 8000);
    if (result.isError || !/^(released \d+ claim\(s\):|no active claims of yours to release\.)/.test(outputText(result))) {
      throw new Error('could not verify release of this session claims');
    }
    meta.cleanupVerified = true;
  };
  try {
    await rpc.initialize();
    meta.state = 'ready'; save();
    process.stdout.write(JSON.stringify({ state: 'ready', session: meta.id }) + '\n');
    while (!stopping) {
      rpc.check();
      if (Date.now() - began >= LIFETIME_MS) throw new Error('worker session lifetime exceeded');
      privateDirectory(dir);
      const requests = fs.readdirSync(dir).filter(name => REQUEST_NAME.test(name));
      if (requests.length > 32) throw new Error('session request queue exceeds 32');
      for (const name of requests) {
        if (stopping) break;
        const id = name.match(REQUEST_NAME)[1];
        if (!UUID.test(id)) throw new Error('invalid request filename');
        const file = path.join(dir, name);
        const request = readJson(file, REQUEST_LIMIT);
        fs.unlinkSync(file);
        let result;
        if (!object(request) || request.id !== id || request.session !== meta.id
          || !Number.isSafeInteger(request.deadline) || request.deadline < Date.now()
          || request.deadline > Date.now() + CALL_MS + 1000) {
          result = errorResult('invalid, stale, or expired session request');
        } else if (request.op === 'close') {
          await release(); stopping = true;
          result = { content: [{ type: 'text', text: 'worker session closed; claim cleanup verified' }] };
        } else if (request.op !== 'call' || typeof request.tool !== 'string' || !/^mai_[a-z_]+$/.test(request.tool) || !object(request.args)) {
          result = errorResult('expected a mai tool name and argument object');
        } else if (!primed && request.tool !== 'mai_prime') {
          result = errorResult('call mai_prime first on this worker session');
        } else {
          result = await rpc.call(request.tool, request.args, Math.max(1, request.deadline - Date.now()));
          if (request.tool === 'mai_prime' && !result.isError) primed = true;
          if (request.tool === 'mai_claim' && request.args.release && !result.isError
            && !/^released 1 claim\(s\):/.test(outputText(result))) {
            result = { ...result, isError: true };
          }
          nextHeartbeat = Date.now() + HEARTBEAT_MS;
        }
        publish(dir, `response-${id}.json`, { id, session: meta.id, result }, RESULT_LIMIT);
      }
      if (!stopping && primed && Date.now() >= nextHeartbeat) {
        const result = await rpc.call('mai_claims', {});
        if (result.isError) throw new Error('worker session heartbeat failed');
        nextHeartbeat = Date.now() + HEARTBEAT_MS;
      }
      if (!stopping) await delay(POLL_MS);
    }
    if (!meta.cleanupVerified) await release();
    meta.state = 'closed';
  } catch (error) {
    exitCode = 1;
    meta.state = 'failed';
    try { await release(); } catch { meta.cleanupVerified = false; }
    process.stderr.write(`mai-worker-session: ${error.message}; cleanupVerified=${meta.cleanupVerified}\n`);
  } finally {
    clearTimeout(shutdownTimer);
    clearTimeout(lifetimeTimer);
    process.off('SIGTERM', signal); process.off('SIGINT', signal);
    await rpc.close();
    save();
  }
  return exitCode;
}

async function main() {
  const [action, dir] = process.argv.slice(2);
  if (process.argv.length !== 4 || !['serve', 'close', 'status'].includes(action)) {
    throw new Error('usage: node mai-worker-session.mjs serve|close|status <absolute-session-directory>');
  }
  if (action === 'serve') return serveSession(dir);
  if (action === 'status') { process.stdout.write(JSON.stringify(metadata(dir, process.env, true)) + '\n'); return 0; }
  const result = await requestSession(dir, { op: 'close' });
  process.stdout.write(outputText(result) + '\n');
  return result.isError ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { process.stderr.write(`mai-worker-session: ${error.message}\n`); process.exitCode = 1; }
}
