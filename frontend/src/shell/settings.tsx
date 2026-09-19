// Operator display preferences — server-backed (/api/settings), operator-level.
// Fetched once at shell mount; SETTING_DEFAULTS cover fetch failure so a
// missing server value can never block the dashboard. Plan 29's theme picker
// plugs in here by adding its key (mirroring the src/settings.ts registry).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { apiGet, apiPost } from '../lib/api';
import { useToast } from './toast';

export const SETTING_DEFAULTS = {
  'roadmap.global_marker': '🌊',
  'graph.theme': 'organism',
};
export type SettingKey = keyof typeof SETTING_DEFAULTS;
const SETTING_KEY_LIST: SettingKey[] = ['roadmap.global_marker', 'graph.theme'];

interface SettingsApi {
  settings: Record<SettingKey, string>;
  /** Persist one setting; false (with an error toast) when the save failed. */
  setSetting: (key: SettingKey, value: string) => Promise<boolean>;
}

const SettingsContext = createContext<SettingsApi | null>(null);

function mergeRegisteredSettings(
  previous: Record<SettingKey, string>,
  incoming: Record<string, unknown>
): Record<SettingKey, string> {
  const next = { ...previous };
  for (const key of SETTING_KEY_LIST) {
    const value = incoming[key];
    if (typeof value === 'string' && value.trim()) next[key] = value;
  }
  return next;
}

export function useSettings(): SettingsApi {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within <SettingsProvider>');
  return ctx;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [settings, setSettings] = useState<Record<SettingKey, string>>({ ...SETTING_DEFAULTS });

  useEffect(() => {
    let live = true;
    apiGet<{ settings: Record<string, unknown> }>('/settings')
      .then((r) => {
        if (!live) return;
        setSettings((prev) => mergeRegisteredSettings(prev, r.settings));
      })
      .catch(() => { /* offline / no token — defaults stand */ });
    return () => { live = false; };
  }, []);

  const setSetting = useCallback(
    async (key: SettingKey, value: string): Promise<boolean> => {
      const trimmed = value.trim();
      if (!trimmed) return false;
      const previous = settings[key];
      // Optimistic, with rollback — the server is the source of truth.
      setSettings((s) => ({ ...s, [key]: trimmed }));
      try {
        const response = await apiPost<{ settings: Record<string, unknown> }>(
          '/settings', { key, value: trimmed }
        );
        setSettings((s) => mergeRegisteredSettings(s, response.settings));
        return true;
      } catch (err) {
        setSettings((s) => ({ ...s, [key]: previous }));
        toast.push('error', err instanceof Error ? err.message : 'Could not save the setting');
        return false;
      }
    },
    [settings, toast]
  );

  const api = useMemo(() => ({ settings, setSetting }), [settings, setSetting]);
  return <SettingsContext.Provider value={api}>{children}</SettingsContext.Provider>;
}
