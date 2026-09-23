import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireStateLock } from '../platform/locks.js';
import { ensurePrivateDirectory } from '../platform/paths.js';
import { ProviderConfigError, exactKeys, isRecord } from './types.js';

export function keyringChildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const names = new Set(['HOME','USER','USERPROFILE','LOCALAPPDATA','APPDATA','PATH','Path','SystemRoot','WINDIR','LANG','DBUS_SESSION_BUS_ADDRESS','XDG_RUNTIME_DIR']);
  for (const [key,value] of Object.entries(source)) if (names.has(key) || /^LC_[A-Z_]+$/.test(key)) env[key]=value;
  return env;
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProviderConfigError('cancelled');
}
function decode(raw: string): Buffer | null {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || !exactKeys(value,['ok','master']) || value.ok !== true) throw new ProviderConfigError('store_unavailable');
  if (value.master === null) return null;
  if (typeof value.master !== 'string') throw new ProviderConfigError('store_unavailable');
  const master = Buffer.from(value.master,'base64');
  if (master.length !== 32 || master.toString('base64') !== value.master) { master.fill(0); throw new ProviderConfigError('store_unavailable'); }
  return master;
}
export interface HelperOptions {
  executable?: string;
  helper?: string;
  args?: readonly string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  onSpawn?: (pid: number) => void;
}
// Only trusted construction/tests inject these options. No HTTP value selects an executable.
export function createKeyringHelper(options: HelperOptions = {}) {
  return (operation: 'read' | 'create', account: string, signal?: AbortSignal): Promise<Buffer | null> => {
    cancelled(signal);
    if (!/^[0-9a-f]{64}$/.test(account)) return Promise.reject(new ProviderConfigError('invalid_input'));
    return new Promise((resolve,reject) => {
      const child = spawn(options.executable ?? process.execPath,
        [options.helper ?? fileURLToPath(new URL('./keyring-worker.js',import.meta.url)), ...(options.args ?? [])],
        { shell:false, windowsHide:true, env:keyringChildEnv(options.env), stdio:['pipe','pipe','pipe'] });
      let output = ''; let stdoutBytes = 0; let stderrBytes = 0;
      let failure: 'store_unavailable' | 'cancelled' | null = null;
      const terminate = (code: 'store_unavailable' | 'cancelled') => {
        failure ??= code;
        child.kill('SIGKILL');
      };
      const abort = () => terminate('cancelled');
      const timer = setTimeout(() => terminate('store_unavailable'),options.timeoutMs ?? 5000);
      child.once('error', () => { failure ??= 'store_unavailable'; });
      child.once('exit', code => { if (code !== 0) failure ??= 'store_unavailable'; });
      child.once('close', code => {
        clearTimeout(timer); signal?.removeEventListener('abort',abort);
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        if (failure || code !== 0) { reject(new ProviderConfigError(failure ?? 'store_unavailable')); return; }
        try { resolve(decode(output)); } catch { reject(new ProviderConfigError('store_unavailable')); }
      });
      child.stdin.on('error', () => terminate('store_unavailable'));
      child.stdout.on('data', (bytes: Buffer) => {
        stdoutBytes += bytes.length;
        if (stdoutBytes > 4096) terminate('store_unavailable'); else output += bytes.toString('utf8');
      });
      child.stderr.on('data', (bytes: Buffer) => {
        stderrBytes += bytes.length; if (stderrBytes > 4096) terminate('store_unavailable');
      });
      signal?.addEventListener('abort',abort,{once:true});
      if (signal?.aborted) abort();
      if (child.pid !== undefined) options.onSpawn?.(child.pid);
      child.stdin.end(JSON.stringify({operation,account}));
    });
  };
}
interface MasterDependencies {
  read(signal?: AbortSignal): Promise<Buffer | null>;
  create(signal?: AbortSignal): Promise<Buffer>;
  lock(): Promise<{release():void}>;
}
export function createMasterService(deps: MasterDependencies) {
  return { async ensure(encryptedRows: number, signal: AbortSignal): Promise<Buffer> {
    cancelled(signal);
    let release: (()=>void) | undefined;
    try {
      const lock = await deps.lock(); release=()=>lock.release(); cancelled(signal);
      const existing = await deps.read(signal);
      if (existing) { if (signal.aborted) {existing.fill(0); cancelled(signal);} return existing; }
      if (encryptedRows > 0) throw new ProviderConfigError('recovery_required');
      cancelled(signal);
      try { return await deps.create(signal); }
      catch {
        // A killed native write can have committed. Reconcile once, with a new
        // bounded read even if the original request was cancelled; never retry create.
        const recovered = await deps.read();
        if (signal.aborted) { recovered?.fill(0); cancelled(signal); }
        if (recovered) return recovered;
        throw new ProviderConfigError('store_unavailable');
      }
    } catch (error) {
      if (error instanceof ProviderConfigError) throw error;
      throw new ProviderConfigError('store_unavailable');
    } finally {
      try { release?.(); } catch { throw new ProviderConfigError('store_unavailable'); }
    }
  }};
}
const helper = createKeyringHelper();
function accountFor(root: string): string { return createHash('sha256').update(fs.realpathSync.native(root)).digest('hex'); }
export async function readMaster(root: string, signal?: AbortSignal): Promise<Buffer | null> {
  cancelled(signal);
  try {
    try { fs.lstatSync(root); } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
    return await helper('read',accountFor(root),signal);
  } catch (error) {
    if (error instanceof ProviderConfigError) throw error;
    throw new ProviderConfigError('store_unavailable');
  }
}
export async function ensureMaster(root: string, encryptedRows: number, signal?: AbortSignal): Promise<Buffer> {
  cancelled(signal);
  try {
    ensurePrivateDirectory(root);
    const account = accountFor(root);
    const service = createMasterService({
      lock:()=>acquireStateLock(path.join(root,'providers-master-lock.sqlite'),1000),
      read:s=>helper('read',account,s),
      async create(s) { const master=await helper('create',account,s); if (!master) throw new ProviderConfigError('store_unavailable'); return master; },
    });
    return await service.ensure(encryptedRows,signal ?? new AbortController().signal);
  } catch (error) {
    if (error instanceof ProviderConfigError) throw error;
    throw new ProviderConfigError('store_unavailable');
  }
}
