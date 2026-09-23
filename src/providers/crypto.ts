import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { ApiProvider, Ciphertext } from './types.js';
function aad(provider: ApiProvider, revision: number): Buffer {
  if (!Number.isSafeInteger(revision) || revision < 1) throw Error('invalid revision');
  return Buffer.from(JSON.stringify(['mai-provider-secret/1', provider, revision]), 'utf8');
}
export function encryptKey(key: string, master: Buffer, provider: ApiProvider, revision: number): Ciphertext {
  if (master.length !== 32) throw Error('invalid master');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', master, iv);
  cipher.setAAD(aad(provider, revision));
  const plaintext = Buffer.from(key, 'utf8');
  try {
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { iv, tag: cipher.getAuthTag(), ciphertext };
  } finally { plaintext.fill(0); }
}
export function decryptKey(box: Ciphertext, master: Buffer, provider: ApiProvider, revision: number): string {
  if (master.length !== 32 || box.iv.length !== 12 || box.tag.length !== 16
      || box.ciphertext.length < 1 || box.ciphertext.length > 8192) throw Error('invalid envelope');
  const decipher = createDecipheriv('aes-256-gcm', master, box.iv);
  decipher.setAAD(aad(provider, revision));
  decipher.setAuthTag(box.tag);
  const plaintext = Buffer.concat([decipher.update(box.ciphertext), decipher.final()]);
  try { return plaintext.toString('utf8'); } finally { plaintext.fill(0); }
}
