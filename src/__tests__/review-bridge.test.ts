/** mai-review-bridge e2e: a REAL server over stdio JSON-RPC, disposable DB. */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../db.js';

const exec = promisify(execFile);
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bridge = path.join(repoRoot, 'scripts', 'mai-review-bridge.mjs');
const SLUG = 'bridge-e2e';
const tempRoots: string[] = [];

beforeAll(async () => {
  // The server does NOT bootstrap unknown slugs — getProjectId throws
  // "Project not found for pinned slug" (db.ts:95-108, verified) — so seed
  // the row exactly like the other DB suites (context-budget precedent).
  await getPool().query(
    `INSERT INTO projects (slug, name) VALUES ($1, 'Bridge E2E') ON CONFLICT (slug) DO NOTHING`,
    [SLUG]
  );
});

afterAll(async () => {
  await closePool();
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
});

describe('mai-review-bridge', () => {
  it('spawns the built server and completes a tools/call roundtrip (exit 0)', async () => {
    // mai_claims is project-pinned and read-only; MAI_DB_URL flows from the
    // disposable-DB wrapper environment into the spawned server.
    const { stdout } = await exec(process.execPath, [bridge, 'mai_claims', '{}'], {
      env: {
        ...process.env,
        MAI_PROJECT_SLUG: SLUG,
        MAI_PROJECT_ROOT: repoRoot,
        MAI_AGENT_ID: 'bridge-e2e@test',
      },
      timeout: 60_000,
    });
    expect(stdout).toContain('claim'); // "No matching claims. Claim your lane…"
  });

  it('refuses to run without the env contract — exit 2 + usage, never a hang', async () => {
    const env = { ...process.env };
    delete env.MAI_PROJECT_SLUG;
    await expect(
      exec(process.execPath, [bridge, 'mai_claims', '{}'], { env, timeout: 10_000 })
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringMatching(/MAI_PROJECT_SLUG=.*MAI_PROJECT_ROOT=/),
    });
  });

  it('runs the documented quoted shell form from a foreign cwd and drains large text blocks', async () => {
    // Both checkout and consumer paths contain a space and an apostrophe. This
    // is the executable discriminator for the dispatcher snippet in Task 2.
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mai review bridge's checkout-"));
    tempRoots.push(fixtureRoot);
    const scriptsDir = path.join(fixtureRoot, 'scripts');
    const buildDir = path.join(fixtureRoot, 'build');
    const consumerRoot = path.join(fixtureRoot, "consumer repo's root");
    fs.mkdirSync(scriptsDir);
    fs.mkdirSync(buildDir);
    fs.mkdirSync(consumerRoot);
    const fixtureBridge = path.join(scriptsDir, 'mai-review-bridge.mjs');
    fs.copyFileSync(bridge, fixtureBridge);
    const payloadPath = path.join(consumerRoot, "reviewer's payload.json");
    fs.writeFileSync(payloadPath, '{}');
    const first = 'x'.repeat(131_072);
    const second = 'y'.repeat(131_072);
    const third = 'brain text: café 😀 done';
    fs.writeFileSync(path.join(buildDir, 'index.js'), `
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === 1) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\\n');
    } else if (msg.id === 2) {
      const response = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 2, result: {
        content: [
          { type: 'text', text: ${JSON.stringify(first)} },
          { type: 'text', text: ${JSON.stringify(second)} },
          { type: 'text', text: ${JSON.stringify(third)} }
        ]
      } }) + '\\n');
      const emoji = Buffer.from('😀');
      const splitAt = response.indexOf(emoji) + 2;
      process.stdout.write(response.subarray(0, splitAt));
      setTimeout(() => process.stdout.write(response.subarray(splitAt)), 10);
    }
  }
});
`);

    const shellCommand = [
      'MAI_PROJECT_SLUG="$slug"',
      'MAI_PROJECT_ROOT="$consumer_repo"',
      '"$node_bin"',
      '"$mai_mcp_root/scripts/mai-review-bridge.mjs"',
      '"$tool"',
      '--file "$payload_json"',
    ].join(' ');
    const { stdout } = await exec('/bin/sh', ['-c', shellCommand], {
      cwd: consumerRoot,
      env: {
        ...process.env,
        slug: SLUG,
        consumer_repo: consumerRoot,
        node_bin: process.execPath,
        mai_mcp_root: fixtureRoot,
        tool: 'large_result',
        payload_json: payloadPath,
        MAI_AGENT_ID: 'bridge-drain@test',
      },
      timeout: 10_000,
    });
    expect(stdout).toBe(`${first}\n${second}\n${third}\n`);
  });
});
