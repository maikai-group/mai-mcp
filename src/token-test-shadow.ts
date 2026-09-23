import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

type SkipReason = 'shape' | 'command' | 'failure' | 'summary' | 'small' | 'large';

export type ShadowDecision =
  | { kind: 'skip'; reason: SkipReason }
  | { kind: 'candidate'; originalStdout: string; summary: string; originalChars: number; originalBytes: number };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bashResponse(value: unknown): value is Record<string, unknown> & {
  stdout: string; stderr: string; interrupted: boolean; isImage: boolean;
} {
  return record(value) && typeof value.stdout === 'string' && typeof value.stderr === 'string'
    && typeof value.interrupted === 'boolean' && typeof value.isImage === 'boolean';
}

export function candidateBashResponse(value: unknown, stdout: string): Record<string, unknown> | null {
  return bashResponse(value) ? { ...value, stdout } : null;
}

function validText(value: string): boolean {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/u.test(value)) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function positiveCount(text: string): number | null {
  const count = Number(text);
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

function passingSummary(command: string, stdout: string): string | null {
  const lines = stdout.trimEnd().split(/\r?\n/u);
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (command.startsWith('npx vitest run')) {
    if (/^\s*(?:Duration|Time)\s+[^\r\n]+\s*$/u.test(lines[lines.length - 1] ?? '')) lines.pop();
    const tests = /^\s*Tests\s+(\d+)\s+passed\s+\((\d+)\)\s*$/u.exec(lines.pop() ?? '');
    const files = /^\s*Test Files\s+(\d+)\s+passed\s+\((\d+)\)\s*$/u.exec(lines.pop() ?? '');
    if (!tests || !files) return null;
    const testCount = positiveCount(tests[1]);
    const fileCount = positiveCount(files[1]);
    if (testCount === null || fileCount === null || testCount !== positiveCount(tests[2])
      || fileCount !== positiveCount(files[2])) return null;
    return `Vitest: ${fileCount} files, ${testCount} tests passed`;
  }
  const pytest = /^=+\s+(\d+)\s+passed\s+in\s+\d+(?:\.\d+)?s\s*=+\s*$/u.exec(lines.pop() ?? '');
  if (!pytest) return null;
  const count = positiveCount(pytest[1]);
  return count === null ? null : `pytest: ${count} tests passed`;
}

export function evaluateClaudeTestHook(value: unknown): ShadowDecision {
  if (!record(value) || value.hook_event_name !== 'PostToolUse' || value.tool_name !== 'Bash'
    || !record(value.tool_input) || typeof value.tool_input.command !== 'string'
    || !bashResponse(value.tool_response)) return { kind: 'skip', reason: 'shape' };
  const command = value.tool_input.command;
  const pathTokens = '(?: [A-Za-z0-9_./][A-Za-z0-9_./-]*)*';
  if (!(new RegExp(`^(?:npx vitest run|pytest)${pathTokens}$`, 'u')).test(command)) {
    return { kind: 'skip', reason: 'command' };
  }
  const response = value.tool_response;
  if (response.stderr !== '' || response.interrupted || response.isImage
    || (response.exitCode !== undefined && response.exitCode !== 0)) {
    return { kind: 'skip', reason: 'failure' };
  }
  const stdout = response.stdout;
  const bytes = Buffer.byteLength(stdout, 'utf8');
  if (bytes < 4097) return { kind: 'skip', reason: 'small' };
  if (bytes > 262144) return { kind: 'skip', reason: 'large' };
  if (!validText(stdout) || /fail|error|exception|not ok|unhandled|❯|×|✕|❌/iu.test(stdout)) {
    return { kind: 'skip', reason: 'failure' };
  }
  const summary = passingSummary(command, stdout);
  if (summary === null) return { kind: 'skip', reason: 'summary' };
  return { kind: 'candidate', originalStdout: stdout, summary, originalChars: stdout.length, originalBytes: bytes };
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function receiptRoot(): string {
  return process.env.MAI_TOKEN_RECEIPTS_DIR ?? join(homedir(), '.mai', 'token-shadow');
}

function ownerOnly(stat: { uid: number; mode: number }): boolean {
  return typeof process.getuid !== 'function' || (stat.uid === process.getuid() && (stat.mode & 0o077) === 0);
}

async function secureRoot(root: string, create: boolean): Promise<void> {
  if (create) await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !ownerOnly(stat)) {
    throw new Error('shadow receipt directory is not a private owned directory');
  }
}

function receiptPath(root: string, id: string): string {
  if (!UUID_PATTERN.test(id)) throw new Error('invalid shadow receipt ID');
  return join(root, `${id}.json`);
}

interface ShadowReceipt {
  schemaVersion: 1;
  sourceCategory: 'claude-passing-test';
  originalStdout: string;
  summary: string;
  sha256: string;
  byteCount: number;
  originalChars: number;
  candidateChars: number;
  createdAt: number;
  expiresAt: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function parseReceipt(value: unknown): ShadowReceipt {
  if (!record(value) || value.schemaVersion !== 1 || value.sourceCategory !== 'claude-passing-test'
    || typeof value.originalStdout !== 'string' || typeof value.summary !== 'string'
    || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.sha256)
    || !safeInteger(value.byteCount) || !safeInteger(value.originalChars)
    || !safeInteger(value.candidateChars) || !safeInteger(value.createdAt)
    || !safeInteger(value.expiresAt)) throw new Error('invalid shadow receipt');
  const originalStdout = value.originalStdout;
  const byteCount = Buffer.byteLength(originalStdout, 'utf8');
  if (byteCount > 262144 || byteCount !== value.byteCount || originalStdout.length !== value.originalChars
    || sha256(originalStdout) !== value.sha256 || value.expiresAt !== value.createdAt + WEEK_MS
    || value.candidateChars < 0 || value.candidateChars >= originalStdout.length) {
    throw new Error('shadow receipt integrity check failed');
  }
  return {
    schemaVersion: 1, sourceCategory: 'claude-passing-test', originalStdout,
    summary: value.summary, sha256: value.sha256, byteCount, originalChars: value.originalChars,
    candidateChars: value.candidateChars, createdAt: value.createdAt, expiresAt: value.expiresAt,
  };
}

async function loadReceipt(root: string, id: string): Promise<ShadowReceipt> {
  await secureRoot(root, false);
  const file = receiptPath(root, id);
  const pre = await lstat(file);
  if (!pre.isFile() || pre.isSymbolicLink() || !ownerOnly(pre)) throw new Error('shadow receipt is not a private owned file');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !ownerOnly(stat) || stat.size > 1_048_576) throw new Error('invalid shadow receipt file');
    const contents = await handle.readFile({ encoding: 'utf8' });
    let value: unknown;
    try { value = JSON.parse(contents); } catch { throw new Error('invalid shadow receipt JSON'); }
    return parseReceipt(value);
  } finally { await handle.close(); }
}

export async function storeShadowReceipt(
  root: string, id: string, originalStdout: string, summary: string, candidateChars: number, nowMs = Date.now(),
): Promise<void> {
  const file = receiptPath(root, id);
  const byteCount = Buffer.byteLength(originalStdout, 'utf8');
  if (byteCount > 262144 || !Number.isSafeInteger(candidateChars) || candidateChars < 0
    || candidateChars >= originalStdout.length || !Number.isSafeInteger(nowMs)) {
    throw new Error('invalid shadow receipt content');
  }
  await secureRoot(root, true);
  const receipt: ShadowReceipt = {
    schemaVersion: 1, sourceCategory: 'claude-passing-test', originalStdout, summary,
    sha256: sha256(originalStdout), byteCount, originalChars: originalStdout.length, candidateChars,
    createdAt: nowMs, expiresAt: nowMs + WEEK_MS,
  };
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.writeFile(JSON.stringify(receipt), { encoding: 'utf8' });
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(file).catch(() => {});
    throw error;
  }
}

export async function readShadowReceipt(root: string, id: string, nowMs = Date.now()): Promise<string> {
  const receipt = await loadReceipt(root, id);
  if (receipt.expiresAt <= nowMs) throw new Error('shadow receipt expired');
  return receipt.originalStdout;
}

export async function cleanupShadowReceipts(root: string, nowMs = Date.now()): Promise<number> {
  await secureRoot(root, true);
  let removed = 0;
  for (const name of await readdir(root)) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (!UUID_PATTERN.test(id)) continue;
    try {
      const receipt = await loadReceipt(root, id);
      if (receipt.expiresAt <= nowMs) {
        await unlink(receiptPath(root, id));
        removed++;
      }
    } catch { /* Unknown, symlinked, unowned or malformed entries are left alone. */ }
  }
  return removed;
}
