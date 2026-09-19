export function requireDisposableTestDbUrl(): string {
  const raw = process.env.MAI_TEST_DB_URL;
  if (!raw) throw new Error('MAI_TEST_DB_URL is required — use scripts/run-with-disposable-db.sh');
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { throw new Error('MAI_TEST_DB_URL must be a valid URL'); }
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!/^mai_plan23_[a-z0-9_]+$/.test(dbName) || dbName === 'mai_brain') {
    throw new Error(`refusing non-disposable test database: ${dbName || '(empty)'}`);
  }
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error(`refusing non-local test database host: ${parsed.hostname}`);
  }
  return raw;
}
