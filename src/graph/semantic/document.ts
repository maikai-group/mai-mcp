import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { getPool } from '../../db.js';
import { eligiblePhysicalPath, identityContext } from './identity.js';
import { DOCUMENT_VERSION, LIMITS, type StableNode, type CodeDocument, type SourceEvidence } from './types.js';

export function frameDocument(node: StableNode, body: string): string {
  return [`Kind: ${node.kind}`,`Symbol: ${node.qualifiedName}`,`Language: ${node.language ?? 'unknown'}`,body].join('\n').slice(0,LIMITS.documentChars);
}
export function documentFingerprint(text: string): string {
  return createHash('sha256').update(JSON.stringify([DOCUMENT_VERSION,text])).digest('hex');
}
export function forbiddenSource(file: string): boolean {
  const segments = file.split(/[\\/]/);
  return segments.some(segment => /^(?:\.env(?:\..*)?|\.git|node_modules|vendor|dist|build|\.ssh|\.gnupg|certs|certificates|secrets)$/i.test(segment))
    || /\.(?:pem|key|p12|pfx|crt|cer|keystore)$/i.test(file);
}
export async function buildDocument(node: StableNode): Promise<CodeDocument | null> {
 return readDocument(node);
}
export interface CachedDocumentEvidence { source_evidence?:unknown;source_hash:string|null;fingerprint:string;document_mode:string }
export async function buildCachedDocument(node:StableNode,cached:CachedDocumentEvidence|undefined):Promise<CodeDocument|null> {
 if(!cached)return null;
 const evidence=readEvidence(cached.source_evidence,node,cached.document_mode);
 if(!evidence)return null;
 const document=await readDocument(node,evidence);
 return document&&document.sourceHash===cached.source_hash&&document.fingerprint===cached.fingerprint&&document.mode===cached.document_mode?document:null;
}
function readEvidence(raw:unknown,node:StableNode,mode:string):SourceEvidence|null {
 if(raw===null||typeof raw!=='object'||Array.isArray(raw))return null;
 const values=Object.fromEntries(Object.entries(raw));
 if(Object.keys(values).length!==5||values.version!=='source-span/1'||values.name!==node.name||values.line!==node.line)return null;
 const {start,end}=values;
 if(mode==='metadata'&&start===null&&end===null)return {version:'source-span/1',name:node.name,line:node.line,start:null,end:null};
 if(mode==='declaration'&&node.physicalPath!==null&&typeof start==='number'&&Number.isSafeInteger(start)&&start>=0&&typeof end==='number'&&Number.isSafeInteger(end)&&end>start&&end<=LIMITS.sourceBytes)return {version:'source-span/1',name:node.name,line:node.line,start,end};
 return null;
}
async function readDocument(node:StableNode,cached?:SourceEvidence):Promise<CodeDocument|null> {
  let range:{start:number;end:number}|null=null;
  let sourceHash: string | null = null, body = '', mode: CodeDocument['mode'] = 'metadata';
  if (node.physicalPath !== null) {
    const roots = await identityContext(node.projectId);
    const physical = eligiblePhysicalPath(node.physicalPath,roots);
    if (!physical || physical !== node.physicalPath || forbiddenSource(physical)) return null;
    const files = await getPool().query<{file_path:string; content_hash:string|null}>(`SELECT file_path,content_hash FROM graph_nodes
      WHERE project_id=$1 AND kind='file' AND extracted_by=$2 AND file_path=$3 LIMIT 2`,[node.projectId,node.extractedBy,physical]);
    const owners = files.rows.filter(row => eligiblePhysicalPath(row.file_path,roots) === physical);
    if (owners.length !== 1 || !owners[0].content_hash || !/^[0-9a-f]{64}$/.test(owners[0].content_hash)) return null;
    try {
      if (await realpath(physical) !== physical) return null;
      const before = await stat(physical);
      if (!before.isFile() || before.size > LIMITS.sourceBytes) return null;
      const handle = await open(physical,constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (before.ino !== opened.ino || before.dev !== opened.dev || !opened.isFile()) return null;
        // Keep one growth sentinel byte without reserving the maximum for every small file.
        const bytes = Buffer.alloc(Math.min(opened.size,LIMITS.sourceBytes) + 1);
        let size = 0;
        while (size < bytes.length) {
          const read = await handle.read(bytes,size,bytes.length-size,size);
          if (read.bytesRead === 0) break;
          size += read.bytesRead;
        }
        const after = await handle.stat();
        if (size > LIMITS.sourceBytes || size !== opened.size || after.size !== opened.size
          || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || await realpath(physical) !== physical) return null;
        const current = await stat(physical);
        if (current.ino !== opened.ino || current.dev !== opened.dev) return null;
        // TypeScript's reader strips BOM; filesystem-based extractors retain it.
        const source = new TextDecoder('utf-8',{fatal:true,ignoreBOM:node.extractedBy!=='ts'}).decode(bytes.subarray(0,size));
        sourceHash = createHash('sha256').update(source).digest('hex');
        if (sourceHash !== owners[0].content_hash) return null;
        if(cached){
          if(cached.start!==null&&cached.end!==null){
            if(cached.end>source.length)return null;
            range={start:cached.start,end:cached.end};
          }
        }else{
          const {declarationRange}=await import('./declarations.js');
          range=declarationRange(physical,source,node);
        }
        if (range) { mode = 'declaration'; body = source.slice(range.start,range.end); }
        else body = `Path: ${physical}\nSignature: ${node.signature ?? ''}`;
      } finally { await handle.close(); }
    } catch { return null; }
  }
  const unbounded = [`Kind: ${node.kind}`,`Symbol: ${node.qualifiedName}`,`Language: ${node.language ?? 'unknown'}`,body].join('\n');
  const text = frameDocument(node,body);
  return {node,version:DOCUMENT_VERSION,mode,sourceHash,fingerprint:documentFingerprint(text),text,truncated:unbounded.length>text.length,
    sourceEvidence:{version:'source-span/1',name:node.name,line:node.line,start:range?.start??null,end:range?.end??null}};
}
