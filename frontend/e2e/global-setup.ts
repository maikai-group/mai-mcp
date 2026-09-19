// Seeds e2e-dash into the validated disposable Playwright database before the smoke suite runs.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { requireDisposableTestDbUrl } from '../../src/__tests__/test-db-url.js';

export default function globalSetup(): void {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const dbUrl = requireDisposableTestDbUrl();
  const seed = path.join(dir, 'seed.sql');
  const runAndRead = (): string => {
    execFileSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-f', seed], { stdio: 'inherit' });
    return execFileSync('psql', [dbUrl, '-qAtc', `
      SELECT title || '|' || priority || '|' || sort_order::text
      FROM ideas
      WHERE source = 'user' AND title LIKE 'E2E P42 %'
      ORDER BY CASE priority WHEN 'now' THEN 0 WHEN 'next' THEN 1 WHEN 'later' THEN 2 ELSE 3 END,
               CASE WHEN project_id IS NULL THEN 1 ELSE 0 END,
               sort_order, title
    `], { encoding: 'utf8' });
  };
  const once = runAndRead();
  const twice = runAndRead();
  if (once.trim().split('\n').length !== 9 || twice !== once) {
    throw new Error('Plan 42 E2E seed is not idempotent');
  }
}
