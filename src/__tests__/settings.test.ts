/** Operator settings store (plan 30). The table has no project_id, so the
 * suite MUST run only against the repository's validated disposable DB
 * (lesson 1d270618: never mutate a shared live namespace from a test). */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';

process.env.MAI_PROJECT_SLUG = 'settings-test';
process.env.MAI_DB_URL = requireDisposableTestDbUrl();

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });
const KEY = 'roadmap.global_marker';
const THEME_KEY = 'graph.theme';
const TEST_KEYS = [KEY, THEME_KEY];

beforeAll(async () => {
  await admin.query(`DELETE FROM operator_settings WHERE key = ANY($1::text[])`, [TEST_KEYS]);
});

afterAll(async () => {
  await admin.query(`DELETE FROM operator_settings WHERE key = ANY($1::text[])`, [TEST_KEYS]);
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
});

describe('settingsGetAll', () => {
  it('fills the default when no row exists', async () => {
    const { settingsGetAll } = await import('../settings.js');
    const all = await settingsGetAll();
    expect(all[KEY]).toBe('🌊');
    expect(all[THEME_KEY]).toBe('organism');
  });
});

describe('settingsSet', () => {
  it('round-trips a valid value through upsert (insert then update)', async () => {
    const { settingsGetAll, settingsSet } = await import('../settings.js');
    await settingsSet(KEY, '🧭');
    expect((await settingsGetAll())[KEY]).toBe('🧭');
    await settingsSet(KEY, '★');
    expect((await settingsGetAll())[KEY]).toBe('★');
    await settingsSet(THEME_KEY, 'atlas');
    expect((await settingsGetAll())[THEME_KEY]).toBe('atlas');
    await settingsSet(THEME_KEY, 'signal');
    expect((await settingsGetAll())[THEME_KEY]).toBe('signal');
  });

  it('rejects ordinary and prototype-named unknown keys', async () => {
    const { settingsSet } = await import('../settings.js');
    await expect(settingsSet('nope.unknown', 'x')).rejects.toThrow(/unknown setting/);
    await expect(settingsSet('toString', 'x')).rejects.toThrow(/unknown setting/);
    await expect(settingsSet('__proto__', 'x')).rejects.toThrow(/unknown setting/);
  });

  it('rejects invalid marker values', async () => {
    const { settingsSet } = await import('../settings.js');
    await expect(settingsSet(KEY, 7)).rejects.toThrow(/must be a string/);
    await expect(settingsSet(KEY, '   ')).rejects.toThrow(/must not be empty/);
    await expect(settingsSet(KEY, 'x'.repeat(17))).rejects.toThrow(/at most 16/);
    await expect(settingsSet(THEME_KEY, 7)).rejects.toThrow(/must be a string/);
    await expect(settingsSet(THEME_KEY, 'riverbed')).rejects.toThrow(/must be one of/);
  });
});

describe('settingsValidate', () => {
  it('returns null for a writable value and a message otherwise', async () => {
    const { settingsValidate } = await import('../settings.js');
    expect(settingsValidate(KEY, '🌊')).toBeNull();
    expect(settingsValidate(KEY, '')).toMatch(/must not be empty/);
    expect(settingsValidate('nope.unknown', 'x')).toMatch(/unknown setting/);
    expect(settingsValidate(THEME_KEY, 'observatory')).toBeNull();
    expect(settingsValidate(THEME_KEY, 'riverbed')).toMatch(/must be one of/);
  });
});

describe('settingsGetAll with a stale stored value', () => {
  it('falls back to the default when the stored value no longer validates', async () => {
    const { settingsGetAll } = await import('../settings.js');
    await admin.query(
      `INSERT INTO operator_settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [KEY, JSON.stringify(42)]
    );
    await admin.query(
      `INSERT INTO operator_settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [THEME_KEY, JSON.stringify('riverbed')]
    );
    const all = await settingsGetAll();
    expect(all[KEY]).toBe('🌊');
    expect(all[THEME_KEY]).toBe('organism');
  });
});
