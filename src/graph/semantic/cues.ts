import { createHash } from 'node:crypto';
import type { CodeDocument } from './types.js';

export const CUE_VERSION = 'code-cues/2';
export interface CueEmbedding { version: typeof CUE_VERSION; fingerprint: string; embedding: number[] }
export function cueFingerprint(document: CodeDocument): string {
  return createHash('sha256').update(JSON.stringify([CUE_VERSION,document.mode,document.fingerprint,document.node.name])).digest('hex');
}
export function cueEmbedding(document: CodeDocument, embedding: number[]): CueEmbedding {
  return {version:CUE_VERSION,fingerprint:cueFingerprint(document),embedding};
}
export function boundCue(text: string, encode: (text:string)=>number[]): string {
  if (encode(text).length<=512) return text;
  let low=0,high=text.length,best=0;
  while (low<=high) {
    const middle=Math.floor((low+high)/2);
    if (encode(text.slice(0,middle)).length<=512) {best=middle;low=middle+1;} else high=middle-1;
  }
  let bounded=text.slice(0,best);
  const last=bounded.charCodeAt(bounded.length-1);
  if (last>=0xd800&&last<=0xdbff) bounded=bounded.slice(0,-1);
  if (encode(bounded).length>512) throw new Error('Cue token bound failed');
  return bounded;
}
