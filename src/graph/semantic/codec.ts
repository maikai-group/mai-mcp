import { object, text, integer, SemanticError } from './validation.js';
import { decodePolicy } from './policy.js';
import type { CodeSearch, CodeHit } from './types.js';
import type { IndexJob } from './store.js';
import type { SemanticStatus } from './runtime.js';
function nullable(value:unknown):string|null { return value===null?null:text(value,10000); }
function bool(value:unknown):boolean { if(typeof value!=='boolean')throw new SemanticError('Invalid worker boolean',500);return value; }
function number(value:unknown):number { if(typeof value!=='number'||!Number.isFinite(value))throw new SemanticError('Invalid worker number',500);return value; }
function pick<const T extends string>(raw:unknown,values:readonly T[]):T {
  for(const value of values)if(value===raw)return value;
  throw new SemanticError('Invalid worker enum',500);
}
export function decodeCoverage(raw:unknown):CodeSearch['coverage'] {
  const r=object(raw,['eligible','current','skipped','capped','declaration','metadata','complete']);
  const counts=(raw:unknown)=>{const c=object(raw,['eligible','current']);return {eligible:integer(c.eligible,0,20000),current:integer(c.current,0,20000)};};
  return {eligible:integer(r.eligible,0,20000),current:integer(r.current,0,20000),skipped:integer(r.skipped,0,40000),
    capped:bool(r.capped),complete:bool(r.complete),declaration:counts(r.declaration),metadata:counts(r.metadata)};
}
function decodeHit(raw:unknown):CodeHit {
  const r=object(raw,['id','identity','name','kind','qualified_name','file_path','line','method','document_mode','score','excerpt','freshness']);
  const f=object(r.freshness,['state','source_hash','document_fingerprint','document_version','indexed_at','verified_at']);
  return {id:text(r.id,36),identity:text(r.identity,64),name:text(r.name,10000),kind:text(r.kind,64),qualified_name:text(r.qualified_name,10000),
    file_path:nullable(r.file_path),line:r.line===null?null:integer(r.line,1,2147483647),method:pick(r.method,['semantic','lexical']),
    document_mode:r.document_mode===null?null:pick(r.document_mode,['declaration','metadata']),score:number(r.score),excerpt:nullable(r.excerpt),
    freshness:{state:pick(f.state,['verified','metadata_only','unverified']),source_hash:nullable(f.source_hash),document_fingerprint:nullable(f.document_fingerprint),
      document_version:nullable(f.document_version),indexed_at:nullable(f.indexed_at),verified_at:nullable(f.verified_at)}};
}
export function decodeSearch(raw:unknown):CodeSearch {
  const r=object(raw,['state','reasons','model','coverage','nodes']);
  if(!Array.isArray(r.nodes)||r.nodes.length>30||!Array.isArray(r.reasons))throw new SemanticError('Invalid worker result',500);
  return {state:pick(r.state,['ready','partial','fallback']),model:nullable(r.model),coverage:decodeCoverage(r.coverage),nodes:r.nodes.map(decodeHit),
    reasons:r.reasons.map(reason=>pick(reason,['off','not_indexed','model_missing','provider_unavailable','worker_busy','stale_source','corpus_limit',
      'coverage_incomplete','policy_changed','no_semantic_hits','query_timeout','database_unavailable']))};
}
export function decodeJob(raw:unknown):IndexJob {
  const r=object(raw,['id','state','scanned','written','reused','skipped','reason']);
  return {id:text(r.id,36),state:pick(r.state,['running','completed','partial','cancelled','failed']),scanned:integer(r.scanned,0,40000),
    written:integer(r.written,0,40000),reused:integer(r.reused,0,40000),skipped:integer(r.skipped,0,40000),reason:nullable(r.reason)};
}
export function decodeStatus(raw:unknown):SemanticStatus {
  const r=object(raw,['policy','model','coverage','job']),p=object(r.policy,['provider','revision','consentVersion']);
  return {policy:decodePolicy({provider:p.provider,revision:p.revision,consent_version:p.consentVersion}),model:nullable(r.model),
    coverage:decodeCoverage(r.coverage),job:r.job===null?null:decodeJob(r.job)};
}
