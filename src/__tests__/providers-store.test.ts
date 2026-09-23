import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { encryptKey, decryptKey } from '../providers/crypto.js';
import { ProviderStore } from '../providers/store.js';
import { defaultPathOps } from '../platform/paths.js';
import { isSummaryRoute, type CheckResult } from '../providers/types.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, {recursive:true,force:true}); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-providers-store-')); roots.push(root);
  return {root, db:new ProviderStore(root)};
}
const master = randomBytes(32);
const check: CheckResult = {state:'valid', checkedAt:'2026-09-20T00:00:00Z', operation:'auth', credentialRevision:1, reason:'accepted'};
function sql(root: string, source: string) {
  const db = new DatabaseSync(path.join(root, 'providers.sqlite'));
  try { db.exec(source); } finally { db.close(); }
}
describe('provider local storage', () => {
  it('keeps an absent store usable after stale and failed first writes', () => {
    const {root,db}=fixture();
    expect(() => db.replaceCredential('openai',1,'first',master)).toThrow('conflict');
    expect(db.readState().revision).toBe(0);
    const failing = new ProviderStore(root,{encrypt(){throw Error('synthetic failure');}});
    expect(() => failing.replaceCredential('openai',0,'first',master)).toThrow('store_unavailable');
    expect(fs.readdirSync(root)).toEqual(['providers.sqlite']);
    expect(db.readState().revision).toBe(0);
    expect(db.replaceCredential('openai',0,'retry',master)).toBe(1);
    expect(fs.readdirSync(root)).toEqual(['providers.sqlite']);
  });
  it('keeps a fresh store usable after its first encryption fails', () => {
    const {root,db}=fixture();
    const failing=new ProviderStore(root,{encrypt(){throw Error('synthetic failure');}});
    expect(()=>failing.replaceCredential('openai',0,'first',master)).toThrow('store_unavailable');
    expect(db.readState().revision).toBe(0);
    expect(db.replaceCredential('openai',0,'retry',master)).toBe(1);
  });
  it('rejects a JSON array masquerading as a summary provider', () => {
    expect(isSummaryRoute({enabled:true,provider:['openai'],model:null,fallback:null})).toBe(false);
    const {root,db}=fixture(); db.setSummary(0,{enabled:true,provider:'openai',model:null,fallback:null});
    sql(root, `UPDATE provider_settings SET value='{"enabled":true,"provider":["openai"],"model":null,"fallback":null}'`);
    expect(() => db.readState()).toThrow('store_unavailable');
  });
  it('does not write on absent-root or unconfigured reads', () => {
    const {root, db} = fixture();
    expect(db.readState().revision).toBe(0);
    expect(fs.readdirSync(root)).toEqual([]);
    const absent = path.join(root, 'absent');
    expect(new ProviderStore(absent).credentialCount()).toBe(0);
    expect(fs.existsSync(absent)).toBe(false);
  });
  it('binds encrypted envelopes to provider/revision and rejects malformed/tampered boxes', () => {
    const box = encryptKey('secret-value', master, 'openai', 1);
    expect(decryptKey(box, master, 'openai', 1)).toBe('secret-value');
    expect(() => decryptKey(box, master, 'voyage', 1)).toThrow();
    expect(() => decryptKey(box, master, 'openai', 2)).toThrow();
    for (const broken of [{...box,tag:Buffer.alloc(16)}, {...box,iv:Buffer.alloc(0)}, {...box,ciphertext:Buffer.alloc(8193)}]) {
      expect(() => decryptKey(broken, master, 'openai', 1)).toThrow();
    }
  });
  it('publishes atomically, refuses stale writers and exposes no plaintext', () => {
    const {root,db} = fixture(); const other = new ProviderStore(root);
    expect(db.replaceCredential('openai',0,'unique-test-secret',master)).toBe(1);
    expect(() => other.replaceCredential('voyage',0,'other',master)).toThrow('conflict');
    expect(other.readState().revision).toBe(1);
    expect(JSON.stringify(other.readState())).not.toContain('unique-test-secret');
    for (const file of fs.readdirSync(root)) expect(fs.readFileSync(path.join(root,file)).includes(Buffer.from('unique-test-secret'))).toBe(false);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(root,'providers.sqlite')).mode & 0o777).toBe(0o600);
  });
  it('rolls back a failed encryption without changing the old credential', () => {
    const {root,db} = fixture(); db.replaceCredential('openai',0,'original',master);
    const failing = new ProviderStore(root,{encrypt(){throw Error('sensitive failure');}});
    expect(() => failing.replaceCredential('openai',1,'replacement',master)).toThrow('store_unavailable');
    expect(db.readState().revision).toBe(1);
    const row = db.readCiphertext('openai'); if (!row) throw Error('missing fixture');
    expect(decryptKey(row.box,master,'openai',row.revision)).toBe('original');
  });
  it('rejects invalid keys before creating files', () => {
    const {root,db} = fixture();
    for (const key of ['', 'a b', 'a\nb', 'é', '\x7f', 'x'.repeat(8193)]) expect(() => db.replaceCredential('openai',0,key,master)).toThrow('invalid_input');
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it('keeps checks tied to a credential and removes without a master', () => {
    const {db} = fixture(); db.replaceCredential('openai',0,'first',master);
    expect(db.recordCheck('openai',1,check)).toBe(true);
    expect(db.readState().revision).toBe(1);
    expect(db.readState().credentials.find(c=>c.provider==='openai')?.check).toEqual(check);
    db.replaceCredential('openai',1,'second',master);
    expect(db.recordCheck('openai',1,check)).toBe(false);
    expect(db.readState().credentials.find(c=>c.provider==='openai')?.check).toBeNull();
    expect(db.removeCredential('openai',2)).toBe(3);
    expect(db.removeCredential('openai',3)).toBe(3);
    expect(() => db.removeCredential('openai',2)).toThrow('conflict');
    expect(db.credentialCount()).toBe(0);
  });
  it('persists independent routing and project policy without enabling from a key', () => {
    const {db} = fixture(); db.replaceCredential('openai',0,'first',master);
    expect(db.readState()).toMatchObject({summary:null,brain:null,jev:{}});
    db.setSummary(1,{enabled:true,provider:'openai',model:null,fallback:null});
    db.setBrain(2,{enabled:true,provider:'local'});
    db.setJev('00000000-0000-4000-8000-000000000001',3,{enabled:false,model:'jev-1.13.0'});
    expect(db.readState().revision).toBe(4);
  });
  it.each([
    "PRAGMA ignore_check_constraints=ON; UPDATE provider_meta SET version=2",
    "UPDATE provider_settings SET value='{}'",
    "UPDATE provider_credentials SET tag=x'00'",
    "UPDATE provider_settings SET key='unknown'",
    "UPDATE provider_settings SET value='not json'",
  ])('fails closed on malformed rows: %s', source => {
    const {root,db} = fixture(); db.replaceCredential('openai',0,'original',master);
    db.setBrain(1,{enabled:false,provider:'local'}); sql(root,source);
    expect(() => db.readState()).toThrow('store_unavailable');
    expect(() => db.removeCredential('openai',2)).toThrow('store_unavailable');
  });
  it('does not replace a malformed file', () => {
    const {root,db} = fixture(); const file=path.join(root,'providers.sqlite'); fs.writeFileSync(file,'malformed',{mode:0o600});
    expect(() => db.replaceCredential('openai',0,'first',master)).toThrow('store_unavailable');
    expect(fs.readFileSync(file,'utf8')).toBe('malformed');
  });
  it('rejects symlinks, hardlinks and suspicious sidecars', () => {
    const {root,db}=fixture(); const real=path.join(root,'real'); fs.writeFileSync(real,'sentinel',{mode:0o600});
    const file=path.join(root,'providers.sqlite'); fs.symlinkSync(real,file);
    expect(() => db.readState()).toThrow('store_unavailable'); fs.unlinkSync(file);
    fs.linkSync(real,file); expect(() => db.readState()).toThrow('store_unavailable'); fs.unlinkSync(file);
    db.replaceCredential('openai',0,'first',master);
    fs.symlinkSync(real,file+'-journal'); expect(() => db.readState()).toThrow('store_unavailable');
    expect(fs.readFileSync(real,'utf8')).toBe('sentinel');
  });
  it('rejects foreign ownership through injected path checks', () => {
    const {root}=fixture(); const ops=defaultPathOps();
    const db=new ProviderStore(root,{pathOps:{...ops,platform:'linux',currentUid:()=>-1}});
    expect(() => db.readState()).toThrow('store_unavailable');
  });
  it('requires a proven private Windows ACL without changing it', () => {
    const {root}=fixture(); const ops=defaultPathOps();
    const db=new ProviderStore(root,{pathOps:{...ops,platform:'win32'},privateWindowsPath:()=>false});
    expect(() => db.replaceCredential('openai',0,'first',master)).toThrow('store_unavailable');
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
