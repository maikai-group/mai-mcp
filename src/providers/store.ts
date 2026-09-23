import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { defaultPathOps, ensurePrivateDirectory, requireOwnedRegularOrAbsent } from '../platform/paths.js';
import type { PathOps } from '../platform/paths.js';
import { encryptKey } from './crypto.js';
import { API_PROVIDERS, ProviderConfigError, isProvider, isRevision, isProjectId, isSummaryRoute, isBrainRoute, isJevPolicy, isCheckResult, validateKey } from './types.js';
import type { ApiProvider, BrainRoute, CheckResult, Ciphertext, JevPolicy, StoredState, SummaryRoute } from './types.js';

const SCHEMA = `
CREATE TABLE provider_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1), revision INTEGER NOT NULL CHECK(revision>=0));
INSERT INTO provider_meta VALUES(1,1,0);
CREATE TABLE provider_credentials (provider TEXT PRIMARY KEY CHECK(provider IN ('typesafe','anthropic','openai','voyage')), revision INTEGER NOT NULL CHECK(revision>0), iv BLOB NOT NULL, tag BLOB NOT NULL, ciphertext BLOB NOT NULL);
CREATE TABLE provider_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, revision INTEGER NOT NULL);
CREATE TABLE provider_checks (provider TEXT PRIMARY KEY, credential_revision INTEGER NOT NULL, result TEXT NOT NULL);`;

// The path is stdin data; it is never interpolated into PowerShell source.
const ACL_SCRIPT = `$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd(); $acl=Get-Acl -LiteralPath $p; $me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; foreach($r in $acl.Access){ if($r.AccessControlType -eq 'Allow' -and ([int]$r.FileSystemRights -band 852310)){ $sid=$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; if($sid -ne $me -and $sid -ne 'S-1-5-18' -and $sid -ne 'S-1-5-32-544'){exit 1} } }; exit 0`;
function windowsPrivate(target: string): boolean {
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ACL_SCRIPT],
    { input: target, encoding: 'utf8', timeout: 5000, maxBuffer: 4096, windowsHide: true, shell: false });
  return !result.error && result.status === 0;
}
export interface StoreDependencies {
  pathOps: PathOps;
  privateWindowsPath(target: string): boolean;
  encrypt: typeof encryptKey;
}
function unavailable(): never { throw new ProviderConfigError('store_unavailable'); }
function emptyState(): StoredState {
  return { revision: 0, credentials: API_PROVIDERS.map(provider => ({ provider, saved: false, configured: false, revision: 0, source: 'missing', check: null })), summary: null, brain: null, jev: {} };
}
function parse(value: unknown): unknown {
  if (typeof value !== 'string') return unavailable();
  return JSON.parse(value);
}
function envelope(row: Record<string, unknown>): { revision: number; box: Ciphertext } {
  if (!isRevision(row.revision) || row.revision < 1 || !(row.iv instanceof Uint8Array) || row.iv.length !== 12
    || !(row.tag instanceof Uint8Array) || row.tag.length !== 16 || !(row.ciphertext instanceof Uint8Array)
    || row.ciphertext.length < 1 || row.ciphertext.length > 8192) return unavailable();
  return { revision: row.revision, box: { iv: Buffer.from(row.iv), tag: Buffer.from(row.tag), ciphertext: Buffer.from(row.ciphertext) } };
}

export class ProviderStore {
  private readonly file: string;
  private readonly deps: StoreDependencies;
  constructor(readonly root: string, deps: Partial<StoreDependencies> = {}) {
    this.file = path.join(root, 'providers.sqlite');
    this.deps = { pathOps: defaultPathOps(), privateWindowsPath: windowsPrivate, encrypt: encryptKey, ...deps };
  }
  private paths(write: boolean): boolean {
    const ops = this.deps.pathOps;
    const root = ops.lstat(this.root);
    if (!root) {
      if (!write) return false;
      ensurePrivateDirectory(this.root, ops);
    } else if (root.isSymbolicLink() || !root.isDirectory() || (ops.platform !== 'win32'
      && (root.uid !== ops.currentUid() || (root.mode & 0o777) !== 0o700))) return unavailable();
    if (ops.platform === 'win32' && !this.deps.privateWindowsPath(this.root)) return unavailable();
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const file = this.file + suffix;
      requireOwnedRegularOrAbsent(file, 'provider state', ops);
      const stat = ops.lstat(file);
      if (stat && (suffix === '-wal' || suffix === '-shm' || stat.nlink !== 1
        || (ops.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)
        || (ops.platform === 'win32' && !this.deps.privateWindowsPath(file)))) return unavailable();
    }
    return ops.lstat(this.file) !== null;
  }
  private access<T>(write: boolean, absent: () => T, fn: (db: DatabaseSync, fresh: boolean) => T): T {
    let db: DatabaseSync | undefined;
    try {
      const exists = this.paths(write);
      if (!exists && !write) return absent();
      let fresh = false;
      if (!exists) {
        try { fs.closeSync(fs.openSync(this.file, 'wx', 0o600)); fresh = true; }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
      }
      this.paths(false);
      db = new DatabaseSync(this.file, { readOnly: !write });
      db.exec('PRAGMA busy_timeout=1000');
      if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') return unavailable();
      // First initialization is durable independently of a rejected mutation.
      // Only the exclusive creator may initialize; pre-existing empty or corrupt
      // databases are never silently replaced. Credentials/configuration still
      // publish together in their own revision-checked transaction.
      if (fresh) {
        db.exec('BEGIN IMMEDIATE');
        try { db.exec(SCHEMA); db.exec('COMMIT'); }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      if (write) db.exec('BEGIN IMMEDIATE'); else db.exec('BEGIN');
      try {
        // Validate the complete state before permitting reads or mutations.
        this.decode(db);
        const result = fn(db, fresh);
        db.exec('COMMIT');
        return result;
      } catch (error) { if (db?.isTransaction) db.exec('ROLLBACK'); throw error; }
    } catch (error) {
      if (error instanceof ProviderConfigError) throw error;
      return unavailable();
    } finally { db?.close(); }
  }

  private decode(db: DatabaseSync): StoredState {
    const metas = db.prepare('SELECT * FROM provider_meta').all();
    const meta = metas[0];
    if (metas.length !== 1 || !meta || meta.id !== 1 || meta.version !== 1 || !isRevision(meta.revision)) return unavailable();
    const state = emptyState(); state.revision = meta.revision;
    for (const row of db.prepare('SELECT * FROM provider_credentials').all()) {
      if (!isProvider(row.provider)) return unavailable();
      const found = envelope(row);
      if (found.revision > state.revision) return unavailable();
      const item = state.credentials.find(item => item.provider === row.provider);
      if (!item || item.saved) return unavailable();
      Object.assign(item, { saved: true, configured: true, revision: found.revision, source: 'saved' });
    }
    const settings = new Set<string>();
    for (const row of db.prepare('SELECT * FROM provider_settings').all()) {
      if (typeof row.key !== 'string' || settings.has(row.key) || !isRevision(row.revision) || row.revision < 1 || row.revision > state.revision) return unavailable();
      settings.add(row.key);
      const value = parse(row.value);
      if (row.key === 'summary' && isSummaryRoute(value)) state.summary = value;
      else if (row.key === 'brain' && isBrainRoute(value)) state.brain = value;
      else if (row.key.startsWith('jev:') && isProjectId(row.key.slice(4)) && isJevPolicy(value)) state.jev[row.key.slice(4)] = value;
      else return unavailable();
    }
    for (const row of db.prepare('SELECT * FROM provider_checks').all()) {
      const value = parse(row.result);
      const item = state.credentials.find(item => item.provider === row.provider);
      if (!item?.saved || item.check || row.credential_revision !== item.revision || !isCheckResult(value) || value.credentialRevision !== item.revision) return unavailable();
      item.check = value;
    }
    return state;
  }
  readState(): StoredState { return this.access(false, emptyState, db => this.decode(db)); }
  readCiphertext(provider: ApiProvider): { revision: number; box: Ciphertext } | null {
    return this.access(false, () => null, db => {
      const row = db.prepare('SELECT * FROM provider_credentials WHERE provider=?').get(provider);
      return row ? envelope(row) : null;
    });
  }
  credentialCount(): number { return this.readState().credentials.filter(item => item.saved).length; }
  private mutate(expected: number, fn: (db: DatabaseSync, next: number) => boolean): number {
    if (!isRevision(expected)) throw new ProviderConfigError('invalid_input');
    return this.access(true, unavailable, db => {
      const current = this.decode(db).revision;
      if (current !== expected) throw new ProviderConfigError('conflict');
      if (!Number.isSafeInteger(current + 1)) return unavailable();
      if (!fn(db, current + 1)) return current;
      db.prepare('UPDATE provider_meta SET revision=? WHERE id=1').run(current + 1);
      return current + 1;
    });
  }
  replaceCredential(provider: ApiProvider, expected: number, key: string, master: Buffer): number {
    if (!isProvider(provider)) throw new ProviderConfigError('invalid_input');
    const valid = validateKey(key);
    return this.mutate(expected, (db, next) => {
      const box = this.deps.encrypt(valid, master, provider, next);
      db.prepare('INSERT OR REPLACE INTO provider_credentials VALUES(?,?,?,?,?)').run(provider, next, box.iv, box.tag, box.ciphertext);
      db.prepare('DELETE FROM provider_checks WHERE provider=?').run(provider); return true;
    });
  }
  removeCredential(provider: ApiProvider, expected: number): number {
    if (!isProvider(provider)) throw new ProviderConfigError('invalid_input');
    return this.mutate(expected, db => {
      db.prepare('DELETE FROM provider_checks WHERE provider=?').run(provider);
      return db.prepare('DELETE FROM provider_credentials WHERE provider=?').run(provider).changes !== 0;
    });
  }
  private setting(expected: number, key: string, value: SummaryRoute | BrainRoute | JevPolicy): number {
    return this.mutate(expected, (db, next) => {
      db.prepare('INSERT OR REPLACE INTO provider_settings VALUES(?,?,?)').run(key, JSON.stringify(value), next); return true;
    });
  }
  setSummary(expected: number, value: SummaryRoute): number {
    if (!isSummaryRoute(value)) throw new ProviderConfigError('invalid_input');
    return this.setting(expected, 'summary', value);
  }
  setBrain(expected: number, value: BrainRoute): number {
    if (!isBrainRoute(value)) throw new ProviderConfigError('invalid_input');
    return this.setting(expected, 'brain', value);
  }
  setJev(projectId: string, expected: number, value: JevPolicy): number {
    if (!isProjectId(projectId) || !isJevPolicy(value)) throw new ProviderConfigError('invalid_input');
    return this.setting(expected, `jev:${projectId}`, value);
  }
  recordCheck(provider: ApiProvider, revision: number, result: CheckResult): boolean {
    if (!isProvider(provider) || !isCheckResult(result) || result.credentialRevision !== revision) throw new ProviderConfigError('invalid_input');
    // A check never initializes an absent store.
    if (!this.readCiphertext(provider)) return false;
    return this.access(true, () => false, db => {
      const row = db.prepare('SELECT revision FROM provider_credentials WHERE provider=?').get(provider);
      if (row?.revision !== revision) return false;
      db.prepare('INSERT OR REPLACE INTO provider_checks VALUES(?,?,?)').run(provider, revision, JSON.stringify(result)); return true;
    });
  }
}
