import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellQuote, tomlString } from './command-encoding.js';
import type { InitHookEntry } from './coordination-api.js';

export type HookMode = 'session-start' | 'session-end' | 'session-stop' | 'pre-edit'
  | 'codex-notify' | 'codex-notify-chain';
export interface MaiHookDescriptor {
  event: 'SessionEnd' | 'SessionStart' | 'Stop' | 'PreToolUse';
  mode: HookMode;
  matcher?: string;
  projectScoped: boolean;
}
export interface MaiHookModeEntry {
  mode: HookMode;
  delegate: string;
  claude: Omit<MaiHookDescriptor, 'mode'> | null;
}
export const MAI_HOOK_MODES: readonly MaiHookModeEntry[] = [
  { mode: 'session-start', delegate: 'session-start-prime.sh', claude: { event: 'SessionStart', matcher: 'startup|resume|clear|compact', projectScoped: true } },
  { mode: 'session-end', delegate: 'session-end-ingest.sh', claude: { event: 'SessionEnd', projectScoped: true } },
  { mode: 'session-stop', delegate: 'session-stop-nudge.sh', claude: { event: 'Stop', projectScoped: false } },
  { mode: 'pre-edit', delegate: 'pre-edit-claim-warn.sh', claude: { event: 'PreToolUse', matcher: 'Edit|Write|MultiEdit|NotebookEdit', projectScoped: true } },
  { mode: 'codex-notify', delegate: 'codex-notify-ingest.sh', claude: null },
  { mode: 'codex-notify-chain', delegate: 'codex-notify-chain.sh', claude: null },
];
export const MAI_HOOKS: readonly MaiHookDescriptor[] = MAI_HOOK_MODES.flatMap(
  entry => entry.claude === null ? [] : [{ mode: entry.mode, ...entry.claude }],
);
export const MAI_HOOK_DELEGATES: readonly string[] = MAI_HOOK_MODES.map(entry => entry.delegate);
const checkoutRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function canonicalHookCommand(mode: HookMode, project?: string, maiRoot = checkoutRoot): string {
  const args = [path.join(maiRoot, 'build', 'scripts', 'hook-runner.js'), mode];
  if (project !== undefined) args.push('--project', project);
  return `node ${args.map(shellQuote).join(' ')}`;
}
export function canonicalMaiHooks(slug: string, maiRoot = checkoutRoot): InitHookEntry[] {
  return MAI_HOOKS.map(({ event, mode, matcher, projectScoped }) => ({
    event,
    entry: {
      ...(matcher === undefined ? {} : { matcher }),
      hooks: [{ type: 'command', command: canonicalHookCommand(mode, projectScoped ? slug : undefined, maiRoot) }],
    },
  }));
}
export function canonicalCodexNotify(maiRoot = checkoutRoot, chain = false): readonly string[] {
  const entry = MAI_HOOK_MODES.find(row => row.mode === (chain ? 'codex-notify-chain' : 'codex-notify'));
  if (!entry || entry.claude !== null) throw new Error('missing Codex mode');
  return ['node', path.join(maiRoot, 'build', 'scripts', 'hook-runner.js'), entry.mode];
}
export function buildCodexNotifyLine(maiRoot = checkoutRoot, chain = false): string {
  return `notify = [${canonicalCodexNotify(maiRoot, chain).map(tomlString).join(', ')}]`;
}

function words(command: string): string[] | null {
  const out: string[] = [];
  let word = '', active = false, quoted = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'") { quoted = !quoted; active = true; continue; }
    if (quoted) { word += c; continue; }
    if (c === '\\' && command[i + 1] === "'") { word += "'"; i++; active = true; continue; }
    if (/\s/.test(c)) {
      if (active) { out.push(word); word = ''; active = false; }
    } else if (/[A-Za-z0-9_./:=+-]/.test(c)) { word += c; active = true; }
    else return null;
  }
  if (quoted) return null;
  if (active) out.push(word);
  return out;
}
function absolutePortable(p: string): boolean {
  return path.posix.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]+\\[^\\]+\\/.test(p);
}
function runnerPath(p: string): boolean {
  return absolutePortable(p) && p.replaceAll('\\', '/').endsWith('/build/scripts/hook-runner.js');
}
function delegateMode(p: string): HookMode | null {
  if (!absolutePortable(p)) return null;
  const normalized = p.replaceAll('\\', '/');
  return MAI_HOOK_MODES.find(e => normalized.endsWith(`/hooks/${e.delegate}`))?.mode ?? null;
}
export interface ManagedHookCommand { mode: HookMode; project?: string; legacy: boolean; }
export function readManagedHookCommand(command: string): ManagedHookCommand | null {
  const argv = words(command);
  if (!argv) return null;
  if (argv[0] === 'node' && runnerPath(argv[1] ?? '')) {
    const entry = MAI_HOOK_MODES.find(e => e.mode === argv[2]);
    if (!entry || (argv.length !== 3 && !(argv.length === 5 && argv[3] === '--project'))) return null;
    return { mode: entry.mode, legacy: false, ...(argv.length === 5 ? { project: argv[4] } : {}) };
  }
  while (argv[0] && /^[A-Za-z_]\w*=/.test(argv[0])) argv.shift();
  if (argv.length !== 2 || argv[0] !== 'bash') return null;
  const mode = delegateMode(argv[1]);
  return mode === null ? null : { mode, legacy: true };
}
export function isMaiHookCommand(command: string): boolean { return readManagedHookCommand(command) !== null; }
export function isLegacyMaiHookCommand(command: string): boolean { return readManagedHookCommand(command)?.legacy === true; }

export type NotifySetting = { kind: 'absent' } | { kind: 'foreign' }
  | { kind: 'managed'; mode: HookMode; legacy: boolean; start: number; end: number };
export function readCodexNotify(raw: string): NotifySetting {
  if (raw.includes('"""') || raw.includes("'''")) return { kind: 'foreign' };
  let offset = 0;
  let found: NotifySetting = { kind: 'absent' };
  for (const line of raw.split('\n')) {
    if (/^\s*\[/.test(line)) break;
    if (/^\s*(?:notify|"notify"|'notify')\s*=/.test(line)) {
      if (found.kind !== 'absent') return { kind: 'foreign' };
      const match = /^\s*notify\s*=\s*(\[.*\])\s*(?:#.*)?$/.exec(line);
      if (!match) return { kind: 'foreign' };
      let value: unknown;
      try { value = JSON.parse(match[1]); } catch { return { kind: 'foreign' }; }
      if (!Array.isArray(value) || !value.every((v: unknown) => typeof v === 'string')) return { kind: 'foreign' };
      const argv: string[] = value;
      let mode: HookMode | null = null;
      if (argv.length === 3 && argv[0] === 'node' && runnerPath(argv[1])) {
        mode = MAI_HOOK_MODES.find(e => e.mode === argv[2] && e.claude === null)?.mode ?? null;
      } else if (argv.length === 2 && argv[0] === 'bash') {
        const candidate = delegateMode(argv[1]);
        if (MAI_HOOK_MODES.some(e => e.mode === candidate && e.claude === null)) mode = candidate;
      }
      if (mode === null) return { kind: 'foreign' };
      found = { kind: 'managed', mode, legacy: argv[0] === 'bash', start: offset, end: offset + line.length };
    }
    offset += line.length + 1;
  }
  return found;
}
