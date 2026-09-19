import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export interface ModelArtifact { file:string; bytes:number; sha256:string }
export async function verifyArtifact(name:string,artifact:ModelArtifact):Promise<void> {
  const info=await stat(name);
  if(!info.isFile()||info.size!==artifact.bytes)throw new Error('Model artifact size mismatch');
  const hash=createHash('sha256');let size=0;
  for await(const bytes of createReadStream(name)){
    size+=bytes.length;
    if(size>artifact.bytes)throw new Error('Model artifact grew during verification');
    hash.update(bytes);
  }
  if(size!==artifact.bytes||hash.digest('hex')!==artifact.sha256)throw new Error('Model artifact checksum mismatch');
}
