import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { exactKeys, isRecord } from './types.js';
interface EntryHandle { getPassword(): string | null; setPassword(password: string): void }
type EntryFactory = (account: string) => Promise<EntryHandle>;
async function nativeEntry(account: string): Promise<EntryHandle> {
  const { Entry } = await import('@napi-rs/keyring');
  return new Entry('mai-mcp/providers/v1', account,
    process.platform === 'linux' ? { linux: { store: 'secret-service' } } : undefined);
}
function canonicalMaster(value: string): boolean {
  const bytes = Buffer.from(value, 'base64');
  try { return bytes.length === 32 && bytes.toString('base64') === value; }
  finally { bytes.fill(0); }
}
export async function handleMasterRequest(raw: string, entryFactory: EntryFactory = nativeEntry): Promise<string> {
  try {
    if (Buffer.byteLength(raw) > 1024) throw Error('invalid');
    const input: unknown = JSON.parse(raw);
    if (!isRecord(input) || !exactKeys(input, ['operation', 'account'])
      || (input.operation !== 'read' && input.operation !== 'create')
      || typeof input.account !== 'string' || !/^[0-9a-f]{64}$/.test(input.account)) throw Error('invalid');
    const entry = await entryFactory(input.account);
    let value = entry.getPassword();
    if (value === null && input.operation === 'create') {
      const bytes = randomBytes(32);
      try { value = bytes.toString('base64'); } finally { bytes.fill(0); }
      entry.setPassword(value);
      if (entry.getPassword() !== value) throw Error('verification');
    }
    if (value !== null && !canonicalMaster(value)) throw Error('invalid');
    return JSON.stringify({ ok: true, master: value });
  } catch { return JSON.stringify({ ok: false, error: 'store_unavailable' }); }
}
async function main(): Promise<void> {
  const chunks: Buffer[] = []; let length = 0;
  try {
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > 1024) { process.stdin.destroy(); throw Error('limit'); }
      chunks.push(bytes);
    }
    process.stdout.write(await handleMasterRequest(Buffer.concat(chunks).toString('utf8')));
  } catch { process.stdout.write('{"ok":false,"error":"store_unavailable"}'); }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
