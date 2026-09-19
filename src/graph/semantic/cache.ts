import { CUE_VERSION, cueFingerprint } from './cues.js';
import { vectorIsValid } from './ranking.js';
import { DOCUMENT_VERSION, type CodeDocument } from './types.js';
export interface VectorEvidence {
  model: string; document_version: string; fingerprint: string;
  source_hash: string|null; document_mode: string; embedding: number[];
  cue_version: string|null; cue_fingerprint: string|null; cue_embedding: number[]|null;
}
export function modelDimensions(model: string): number {
  return model.startsWith('local:')?384:model==='voyage-3'?1024:1536;
}
export function completeVectors(row: VectorEvidence, model: string): boolean {
  return row.model===model&&row.document_version===DOCUMENT_VERSION&&vectorIsValid(row.embedding,modelDimensions(model))
    &&(!model.startsWith('local:')||(row.cue_version===CUE_VERSION&&typeof row.cue_fingerprint==='string'
      &&/^[0-9a-f]{64}$/.test(row.cue_fingerprint)&&vectorIsValid(row.cue_embedding,384)));
}
export function currentVectors(row: VectorEvidence|undefined, document: CodeDocument, model: string): boolean {
  return !!row&&completeVectors(row,model)&&row.fingerprint===document.fingerprint&&row.source_hash===document.sourceHash
    &&row.document_mode===document.mode&&(!model.startsWith('local:')||row.cue_fingerprint===cueFingerprint(document));
}
