// Operator display preferences (plan 30, spec 2026-08-18 §5). Server-side KV
// store, web surface only — no MCP tool; agents never read or write these.
// Keys are allowlisted with per-key validation so the table never accumulates
// junk; each new preference (e.g. plan 29's theme) is one registry entry.
import { getPool } from './db.js';

interface SettingSpec {
  defaultValue: unknown;
  /** Returns an error message, or null when the value is valid. */
  validate: (value: unknown) => string | null;
}

const REGISTRY: Record<string, SettingSpec> = {
  'roadmap.global_marker': {
    defaultValue: '🌊',
    validate: (value) => {
      if (typeof value !== 'string') return 'must be a string';
      if (!value.trim()) return 'must not be empty';
      if (value.length > 16) return 'must be at most 16 characters';
      return null;
    },
  },
  'graph.theme': {
    defaultValue: 'organism',
    validate: (value) => {
      if (typeof value !== 'string') return 'must be a string';
      if (!['organism', 'observatory', 'atlas', 'signal'].includes(value)) {
        return 'must be one of: organism, observatory, atlas, signal';
      }
      return null;
    },
  },
};

export const SETTING_KEYS = Object.keys(REGISTRY);

/** Route-layer validation: error message for a 400, or null when writable. */
export function settingsValidate(key: string, value: unknown): string | null {
  // `key` is untrusted route input. A normal object's prototype names are not
  // registered settings, even though property lookup can find them.
  const spec = Object.hasOwn(REGISTRY, key) ? REGISTRY[key] : undefined;
  if (!spec) return `unknown setting '${key}' — known keys: ${SETTING_KEYS.join(', ')}`;
  const error = spec.validate(value);
  return error ? `invalid value for '${key}': ${error}` : null;
}

/** All registered settings, defaults filled for unset keys. */
export async function settingsGetAll(): Promise<Record<string, unknown>> {
  const r = await getPool().query<{ key: string; value: unknown }>(
    `SELECT key, value FROM operator_settings WHERE key = ANY($1)`,
    [SETTING_KEYS]
  );
  const stored = new Map(r.rows.map((row) => [row.key, row.value]));
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(REGISTRY)) {
    const value = stored.get(key);
    // A stored value that no longer validates (registry tightened later) falls
    // back to the default rather than surfacing junk.
    out[key] = value !== undefined && spec.validate(value) === null ? value : spec.defaultValue;
  }
  return out;
}

/** Upsert one setting. Validates again (defense in depth behind the route). */
export async function settingsSet(key: string, value: unknown): Promise<void> {
  const error = settingsValidate(key, value);
  if (error) throw new Error(error);
  await getPool().query(
    `INSERT INTO operator_settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
}
