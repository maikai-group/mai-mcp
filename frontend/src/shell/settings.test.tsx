import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => {
  const push = vi.fn();
  return { apiGet: vi.fn(), apiPost: vi.fn(), push, toast: { push } };
});
vi.mock('../lib/api', () => ({ apiGet: mocks.apiGet, apiPost: mocks.apiPost }));
vi.mock('./toast', () => ({ useToast: () => mocks.toast }));

import { SettingsProvider, useSettings, type SettingKey } from './settings';

const KEY: SettingKey = 'roadmap.global_marker';
const THEME_KEY: SettingKey = 'graph.theme';

let captured: ReturnType<typeof useSettings> | null = null;
function Probe() {
  captured = useSettings();
  return (
    <>
      <span data-testid="marker">{captured.settings[KEY]}</span>
      <span data-testid="theme">{captured.settings[THEME_KEY]}</span>
    </>
  );
}

describe('SettingsProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured = null;
  });
  afterEach(cleanup);

  it('serves the default, then merges the fetched value', async () => {
    mocks.apiGet.mockResolvedValue({ settings: { [KEY]: '🧭', [THEME_KEY]: 'atlas' } });
    render(<SettingsProvider><Probe /></SettingsProvider>);
    await waitFor(() => expect(screen.getByTestId('marker').textContent).toBe('🧭'));
    expect(screen.getByTestId('theme').textContent).toBe('atlas');
  });

  it('keeps the default when the fetch fails', async () => {
    mocks.apiGet.mockRejectedValue(new Error('offline'));
    render(<SettingsProvider><Probe /></SettingsProvider>);
    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalled());
    expect(screen.getByTestId('marker').textContent).toBe('🌊');
    expect(screen.getByTestId('theme').textContent).toBe('organism');
  });

  it('setSetting persists optimistically and rolls back on failure', async () => {
    mocks.apiGet.mockResolvedValue({ settings: {} });
    mocks.apiPost.mockRejectedValue(new Error('invalid'));
    render(<SettingsProvider><Probe /></SettingsProvider>);
    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalled());
    const api = captured;
    if (!api) throw new Error('SettingsProvider did not render the probe');
    let ok = true;
    await act(async () => { ok = await api.setSetting(THEME_KEY, 'signal'); });
    expect(ok).toBe(false);
    expect(screen.getByTestId('theme').textContent).toBe('organism');
    expect(mocks.push).toHaveBeenCalledWith('error', 'invalid');
  });

  it('setSetting trims, posts, and adopts the authoritative response', async () => {
    mocks.apiGet.mockResolvedValue({ settings: {} });
    mocks.apiPost.mockResolvedValue({ settings: { [THEME_KEY]: 'observatory' } });
    render(<SettingsProvider><Probe /></SettingsProvider>);
    await waitFor(() => expect(mocks.apiGet).toHaveBeenCalled());
    const api = captured;
    if (!api) throw new Error('SettingsProvider did not render the probe');
    let ok = false;
    await act(async () => { ok = await api.setSetting(THEME_KEY, '  signal  '); });
    expect(ok).toBe(true);
    expect(mocks.apiPost).toHaveBeenCalledWith('/settings', { key: THEME_KEY, value: 'signal' });
    expect(screen.getByTestId('theme').textContent).toBe('observatory');
  });
});
