import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ActivityRow } from '../../lib/types';

// Mock the api client + project context so Home renders against fixtures.
const activity: ActivityRow[] = [
  { kind: 'decision', ts: new Date().toISOString(), id: 'dddddddd1111', detail: 'chose X over Y' },
  { kind: 'decision', ts: new Date().toISOString(), id: 'dddddddd2222', detail: 'chose A over B' },
  { kind: 'session', ts: new Date().toISOString(), id: 'ssssssss1111', detail: 'a work session' },
  { kind: 'commit', ts: new Date().toISOString(), id: 'cccccccc1111', detail: 'feat: thing' },
];

vi.mock('../../lib/api', () => ({
  apiGet: vi.fn((path: string) => {
    if (path === '/activity') return Promise.resolve({ rows: activity });
    if (path === '/report') return Promise.resolve({ markdown: '# report' });
    if (path === '/graph/stale') return Promise.resolve({ markdown: '# stale' });
    return Promise.resolve({});
  }),
}));

vi.mock('../../shell/project', () => ({
  useProjects: () => ({ project: 'demo', projects: [], setProject: vi.fn() }),
}));

import { Home } from './Home';

describe('Home', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => cleanup());

  it('derives stat chips from activity kinds and renders the feed', async () => {
    render(<Home onNavigate={vi.fn()} reviewCount={3} />);
    // Feed rows render once activity loads.
    expect(await screen.findByText('chose X over Y')).toBeTruthy();
    // Two decisions, one session, one commit in the fixture.
    expect(screen.getByText('decisions · 14d')).toBeTruthy();
    // Review CTA appears when reviewCount > 0.
    expect(screen.getByText(/3 decisions need review/)).toBeTruthy();
  });

  it('shows a review CTA only when the count is positive', async () => {
    render(<Home onNavigate={vi.fn()} reviewCount={0} />);
    await screen.findByText('chose X over Y');
    expect(screen.queryByText(/need review/)).toBeNull();
  });
});
