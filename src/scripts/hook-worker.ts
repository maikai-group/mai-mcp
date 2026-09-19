#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnArgv } from '../platform/commands.js';

const checkoutRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function launch(name: string, args: readonly string[], input?: string): Promise<void> {
  await new Promise<void>(resolve => {
    const child = spawnArgv(process.execPath, [path.join(checkoutRoot, 'build', 'scripts', `${name}.js`), ...args], {
      cwd: process.cwd(), env: process.env, stdio: ['pipe', 'inherit', 'inherit'], shell: false,
    });
    child.on('error', () => resolve());
    child.on('close', () => resolve());
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input ?? '');
  });
}

export interface WorkerCommand { name: string; args: readonly string[]; input: boolean; }

export function workerCommands(mode: string): readonly WorkerCommand[] {
  if (mode === 'session-end') return [
    { name: 'ingest-session', args: [], input: true },
    { name: 'sync-commits', args: [], input: false },
    { name: 'docs-sweep', args: [], input: false },
    { name: 'sweep-orphans', args: [], input: false },
    { name: 'graph-update', args: [], input: false },
  ];
  if (mode === 'codex-notify') return [
    { name: 'ingest-codex', args: ['--scan', '--since-days', '2'], input: false },
    { name: 'sync-commits', args: [], input: false },
    { name: 'docs-sweep', args: [], input: false },
    { name: 'graph-update-throttle', args: [], input: false },
  ];
  return [];
}

export async function runWorker(argv: readonly string[], input = ''): Promise<void> {
  for (const command of workerCommands(argv[0] ?? '')) {
    await launch(command.name, command.args, command.input ? input : undefined);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await runWorker(process.argv.slice(2), await readStdin());
}
