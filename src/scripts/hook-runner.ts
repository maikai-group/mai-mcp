#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import type { HookMode } from '../hook-wiring.js';
import {
  MAI_HOOK_MODES, canonicalCodexNotify, canonicalHookCommand,
} from '../hook-wiring.js';
import { findExecutable, spawnArgv } from '../platform/commands.js';
import { hookLogPath, ensurePrivateDirectory, openPrivateAppendLog } from '../platform/paths.js';
import { claudeChatBootstrap } from '../session-identity.js';

export type { HookMode } from '../hook-wiring.js';
export { canonicalCodexNotify, canonicalHookCommand } from '../hook-wiring.js';

export interface HookRunnerIO {
  env: NodeJS.ProcessEnv;
  stdin(): Promise<string>;
  spawnDetached(modulePath: string, args: readonly string[], options: HookChildOptions): void;
  runNode(modulePath: string, args: readonly string[], options: HookChildOptions): Promise<HookChildResult>;
  runExternal(command: string, args: readonly string[], options: HookChildOptions): void;
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

export interface HookChildOptions {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  input?: string;
  logPath?: string;
}

export interface HookChildResult { status: number; stdout: string; stderr: string; }

const checkoutRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const startupFallback = [
  'mai-mcp is active for this project. Call mai_prime("<what you\'re about to do>")',
  'before working — it loads project context, the prior-session handoff, and',
  'relevant decisions/lessons, and unlocks brain writes.',
].join('\n') + '\n';

function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function writeInput(child: ChildProcess, input: string | undefined): void {
  if (!child.stdin) return;
  child.stdin.on('error', () => undefined);
  child.stdin.end(input ?? '');
}

function defaultIO(): HookRunnerIO {
  return {
    env: process.env,
    stdin: readStdin,
    spawnDetached(modulePath, args, options) {
      let logFd: number | undefined;
      try {
        if (options.logPath) {
          ensurePrivateDirectory(path.dirname(options.logPath));
          logFd = openPrivateAppendLog(options.logPath);
        }
        const child = spawnArgv(process.execPath, [modulePath, ...args], {
          cwd: options.cwd,
          env: options.env,
          detached: true,
          stdio: ['pipe', logFd ?? 'ignore', logFd ?? 'ignore'],
          shell: false,
          windowsHide: true,
        });
        child.on('error', () => undefined);
        writeInput(child, options.input);
        child.unref();
      } finally {
        if (logFd !== undefined) fs.closeSync(logFd);
      }
    },
    runNode(modulePath, args, options) {
      return new Promise(resolve => {
        const child = spawnArgv(process.execPath, [modulePath, ...args], {
          cwd: options.cwd,
          env: options.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', chunk => { stdout += chunk; });
        child.stderr?.on('data', chunk => { stderr += chunk; });
        child.on('error', error => resolve({ status: 1, stdout, stderr: `${stderr}${error.message}` }));
        child.on('close', code => resolve({ status: code ?? 1, stdout, stderr }));
        writeInput(child, options.input);
      });
    },
    runExternal(command, args, options) {
      const child = spawnArgv(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
      });
      child.on('error', () => undefined);
      child.unref();
    },
    writeStdout: value => process.stdout.write(value),
    writeStderr: value => process.stderr.write(value),
  };
}

export function parseHookArgs(argv: readonly string[]): { mode: HookMode; project?: string } {
  const mode = MAI_HOOK_MODES.find(entry => entry.mode === argv[0])?.mode;
  if (!mode) throw new Error('unknown hook mode');
  if (argv.length === 1) return { mode };
  if (argv.length === 3 && argv[1] === '--project' && argv[2]) return { mode, project: argv[2] };
  throw new Error('invalid hook arguments');
}

function objectString(value: unknown, keys: readonly string[]): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  for (const key of keys) {
    const field = Reflect.get(value, key);
    if (typeof field === 'string' && field.length > 0) return field;
  }
  return null;
}

function managedSlug(raw: string): string | null {
  const marker = '[mcp_servers.mai-mcp]';
  const start = raw.indexOf(marker);
  if (start === -1) return null;
  const endMatch = /^# \/mai-mcp-block v\d+$/m.exec(raw.slice(start));
  if (!endMatch || endMatch.index === undefined) return null;
  const block = raw.slice(start, start + endMatch.index + endMatch[0].length);
  const envTable = block.indexOf('[mcp_servers.mai-mcp.env]');
  if (envTable === -1) return null;
  const tail = block.slice(envTable);
  const matches = [...tail.matchAll(/^MAI_PROJECT_SLUG\s*=\s*("(?:[^"\\]|\\.)*")\s*$/gm)];
  if (matches.length !== 1) return null;
  try {
    const value: unknown = JSON.parse(matches[0][1]);
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export async function resolveCodexNotifyTarget(
  payload: unknown,
  options: { codexHome?: string; nowMs?: number } = {},
): Promise<{ cwd: string; slug: string } | null> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  let cwd = objectString(payload, ['cwd', 'turn-cwd']);
  if (cwd === null) {
    const sessionId = objectString(payload, ['thread-id', 'thread_id', 'session-id', 'session_id']);
    if (sessionId === null) return null;
    const [{ collectRollouts }, { readRolloutMeta, codexHome }] = await Promise.all([
      import('./ingest-codex.js'), import('../capture/codex.js'),
    ]);
    const root = options.codexHome ?? codexHome();
    const cutoff = (options.nowMs ?? Date.now()) - 2 * 86_400_000;
    for (const rollout of await collectRollouts(path.join(root, 'sessions'), cutoff)) {
      const meta = await readRolloutMeta(rollout.file);
      if (meta?.sessionId === sessionId) { cwd = meta.cwd; break; }
    }
  }
  if (cwd === null) return null;
  let raw: string;
  try {
    const file = path.join(cwd, '.codex', 'config.toml');
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size > 1_048_576) return null;
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
  const slug = managedSlug(raw);
  return slug === null ? null : { cwd, slug };
}

export async function runHook(argv: readonly string[], supplied?: HookRunnerIO): Promise<number> {
  const io = supplied ?? defaultIO();
  let parsed: { mode: HookMode; project?: string };
  const parseArgv = argv[0] === 'codex-notify' || argv[0] === 'codex-notify-chain'
    ? argv.slice(0, 1) : argv;
  try { parsed = parseHookArgs(parseArgv); } catch (error) {
    io.writeStderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 0;
  }
  const inherited = { ...io.env };
  if (supplied === undefined) {
    try { process.loadEnvFile(path.join(checkoutRoot, '.env')); } catch { /* optional */ }
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env, ...inherited, ...(parsed.project ? { MAI_PROJECT_SLUG: parsed.project } : {}),
  };
  const modulePath = (name: string) => path.join(checkoutRoot, 'build', 'scripts', `${name}.js`);
  if (parsed.mode === 'session-start') {
    // Native session ID comes from this hook's stdin, never a latest-log guess.
    // This is emitted independently of DB-backed priming, including fallback.
    let source: string | null = null;
    try {
      const payload: unknown = JSON.parse(await io.stdin());
      source = objectString(payload, ['source']);
      const bootstrap = claudeChatBootstrap(payload, env);
      if (bootstrap) io.writeStdout(bootstrap);
    } catch { /* startup is advisory */ }
    // Resuming/compacting already carries the prior briefing. Refresh only the
    // native identity hint; don't repeat the DB work or rehydrate broad context.
    if (source === 'resume' || source === 'clear' || source === 'compact') return 0;
    try {
      const result = await io.runNode(modulePath('session-prime'), [], { env });
      io.writeStdout(result.status === 0 && result.stdout ? result.stdout : startupFallback);
    } catch {
      try { io.writeStdout(startupFallback); } catch { /* advisory */ }
    }
    return 0;
  }
  if (parsed.mode === 'session-stop' || parsed.mode === 'pre-edit') {
    try {
      const input = await io.stdin();
      const target = parsed.mode === 'session-stop'
        ? modulePath('stop-nudge') : path.join(checkoutRoot, 'build', 'coordination', 'claim-warn.js');
      const result = await io.runNode(target, [], { env, input });
      if (result.stdout) io.writeStdout(result.stdout);
    } catch { /* advisory */ }
    return 0;
  }
  if (parsed.mode === 'session-end') {
    try {
      const input = await io.stdin();
      io.spawnDetached(modulePath('hook-worker'), ['session-end'], {
        env, cwd: env.CLAUDE_PROJECT_DIR || process.cwd(), input, logPath: hookLogPath('session-end', env),
      });
    } catch { /* advisory */ }
    return 0;
  }
  try {
    let payload: unknown;
    try { payload = JSON.parse(argv[1] ?? ''); } catch { return 0; }
    if (parsed.mode === 'codex-notify-chain') {
      const client = env.MAI_CODEX_NOTIFY_CLIENT;
      if (client && path.isAbsolute(client) && findExecutable(client, { env })) {
        try { io.runExternal(client, ['turn-ended', ...argv.slice(1)], { env }); } catch { /* advisory */ }
      }
    }
    const target = await resolveCodexNotifyTarget(payload);
    if (target === null) return 0;
    io.spawnDetached(modulePath('hook-worker'), ['codex-notify', '--project', target.slug], {
      env: { ...env, MAI_PROJECT_SLUG: target.slug }, cwd: target.cwd,
      logPath: hookLogPath('codex-notify', env),
    });
  } catch { /* advisory */ }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await runHook(process.argv.slice(2));
}
