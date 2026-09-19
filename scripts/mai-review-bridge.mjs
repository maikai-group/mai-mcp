#!/usr/bin/env node
// One-shot brain access for headless reviewers. Use MAI_BRIDGE_SESSION_DIR for a worker holding claims; native MCP availability depends on the host.
//
// Dispatcher shell variables are passed through env/argv fields; quote every
// expansion so spaces and apostrophes remain data:
//   MAI_PROJECT_SLUG="$slug" MAI_PROJECT_ROOT="$consumer_repo" \
//     "$node_bin" "$mai_mcp_root/scripts/mai-review-bridge.mjs" \
//       "$tool" --file "$payload_json"
//   … or replace the last two arguments with "$json_args" (small payloads).
//
// MAI_AGENT_ID (default reviewer@bridge) sets board/review attribution.
// MAI_BRIDGE_TIMEOUT_MS (default 120000) bounds the whole call.
// The server entry resolves relative to THIS script (../build/index.js), so
// the bridge works unchanged in the repo and in the assembled public artifact
// (both carry scripts/ beside build/). Proven pattern: plan-35 gauntlet
// passes 3/5/6/8/9 all posted their atomic reviews through it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tool = process.argv[2];
const slug = process.env.MAI_PROJECT_SLUG;
const root = process.env.MAI_PROJECT_ROOT;
if (!tool || !slug || !root) {
  console.error(
    'usage: MAI_PROJECT_SLUG=<slug> MAI_PROJECT_ROOT=<repo> node mai-review-bridge.mjs <tool> <json|--file path>'
  );
  process.exit(2);
}
const args = process.argv[3] === '--file'
  ? JSON.parse(fs.readFileSync(process.argv[4], 'utf8'))
  : JSON.parse(process.argv[3] || '{}');

if (process.env.MAI_BRIDGE_SESSION_DIR !== undefined) {
  const budget = process.env.MAI_BRIDGE_TIMEOUT_MS === undefined ? 120000 : Number(process.env.MAI_BRIDGE_TIMEOUT_MS);
  if (!Number.isSafeInteger(budget) || budget < 100 || budget > 120000) process.exit(2);
  let writer;
  // Only the owned output child touches potentially blocking stdout/stderr.
  // The deadline owner never writes a diagnostic into a possibly blocked pipe.
  const deadlineTimer = setTimeout(() => {
    writer?.kill('SIGKILL');
    process.exit(1);
  }, budget);
  const drain = (output, destination) => new Promise((resolve, reject) => {
    writer = spawn(process.execPath, ['-e',
      `process.stdin.on('error',()=>process.exit(1));process.${destination}.on('error',()=>process.exit(1));process.stdin.pipe(process.${destination});`,
    ], { stdio: ['pipe', 'inherit', 'inherit'] });
    writer.once('error', reject);
    writer.once('exit', code => code === 0 ? resolve() : reject(new Error('output writer failed')));
    writer.stdin.on('error', error => { writer.kill('SIGKILL'); reject(error); });
    writer.stdin.end(output);
  });
  let code = 1;
  try {
    const { requestSession } = await import('./mai-worker-session.mjs');
    const result = await requestSession(process.env.MAI_BRIDGE_SESSION_DIR, { op: 'call', tool, args });
    const blocks = (result.content ?? []).filter(block => block?.type === 'text').map(block => block.text);
    const output = blocks.length ? blocks.map(value => value + '\n').join('') : JSON.stringify(result, null, 2) + '\n';
    await drain(output, 'stdout');
    code = result.isError ? 1 : 0;
  } catch (error) {
    // One bounded diagnostic attempt; never reopen/retry a tool call.
    if (!writer) {
      try { await drain(`mai-review-bridge: ${error.message}\n`, 'stderr'); } catch { /* exit nonzero */ }
    }
  }
  clearTimeout(deadlineTimer);
  process.exit(code);
}

const serverEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build', 'index.js');
const timeoutMs = Number(process.env.MAI_BRIDGE_TIMEOUT_MS || 120000);

const child = spawn(process.execPath, [serverEntry], {
  env: {
    ...process.env,
    MAI_PROJECT_SLUG: slug,
    MAI_PROJECT_ROOT: root,
    MAI_AGENT_ID: process.env.MAI_AGENT_ID || 'reviewer@bridge',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
let buf = '';
let done = false;
const startedAt = Date.now();
let callTimer;
const finish = (code, output = '') => {
  if (done) return;
  done = true;
  clearTimeout(callTimer);
  child.kill('SIGTERM');
  if (!output) {
    process.exit(code);
    return;
  }
  // process.exit() before the write callback can discard buffered stdout.
  // Preserve the whole-call bound: a reader that never drains cannot hold
  // this process beyond the configured deadline.
  const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
  const drainTimer = setTimeout(() => process.exit(code), remainingMs);
  process.stdout.write(output, () => {
    clearTimeout(drainTimer);
    process.exit(code);
  });
};

child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => {
  buf += d;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === 1) {
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } });
    } else if (msg.id === 2) {
      if (msg.error) {
        console.error(JSON.stringify(msg.error));
        finish(1);
        return;
      }
      const res = msg.result;
      const text = (res?.content ?? [])
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text);
      const output = text.length > 0
        ? text.map((value) => value + '\n').join('')
        : JSON.stringify(res, null, 2) + '\n';
      finish(res?.isError ? 1 : 0, output);
      return;
    }
  }
});
child.stderr.on('data', () => {});
child.on('exit', () => finish(1));
child.on('error', () => finish(1));
callTimer = setTimeout(() => {
  console.error(`mai-review-bridge: timeout after ${timeoutMs}ms`);
  finish(1);
}, timeoutMs).unref?.();

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'mai-review-bridge', version: '1.0.0' },
  },
});
