import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { Profile } from './Profile';
import { ToastProvider } from '../../shell/toast';
import type { FactRow } from '../../lib/types';

const fact = (id: string, category: FactRow['category'], text: string, source = 'user-approved'): FactRow => ({
  id,
  category,
  fact: text,
  detail: null,
  source,
  evidence: `learned in ${id}`,
  retracted_at: null,
  retraction_reason: null,
  created_at: '2026-08-06T00:00:00.000Z',
});

function mockApi(facts: FactRow[], factCandidates = 0) {
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes('/api/facts')
      ? { ok: true, rows: facts }
      : {
          ok: true,
          rows: Array.from({ length: factCandidates }, (_, i) => ({
            kind: 'fact',
            id: `cand-${i}`,
            decision_type: 'workflow',
            description: 'a candidate',
            reasoning: null,
            confidence: 0.5,
            source: 'agent-inferred',
            keywords: [],
            timestamp: '2026-08-06T00:00:00.000Z',
          })),
        };
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
  });
}

const renderProfile = () =>
  render(
    <ToastProvider>
      <Profile />
    </ToastProvider>
  );

describe('Profile', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('groups approved facts by category and offers a retract action', async () => {
    mockApi([
      fact('f1', 'preference', 'Explicit git paths, never broad staging.'),
      fact('f2', 'tooling', 'Runs the brain on port 54334.'),
    ]);
    renderProfile();

    await waitFor(() => expect(screen.getAllByTestId('fact-row')).toHaveLength(2));
    expect(screen.getByText('preference')).toBeDefined();
    expect(screen.getByText('tooling')).toBeDefined();
    expect(screen.getByText('Explicit git paths, never broad staging.')).toBeDefined();
    expect(screen.getByText('learned in f1')).toBeDefined();
    expect(screen.getAllByRole('button', { name: 'retract' })).toHaveLength(2);
  });

  it('hides unapproved candidates and shows the empty state instead', async () => {
    mockApi([fact('f3', 'identity', 'Not approved yet.', 'agent-inferred')]);
    renderProfile();

    await waitFor(() => expect(screen.getByText(/no approved facts yet/i)).toBeDefined());
    expect(screen.queryByTestId('fact-row')).toBeNull();
  });

  it('links the pending fact candidates to Review', async () => {
    mockApi([fact('f4', 'workflow', 'An approved fact.')], 3);
    renderProfile();

    await waitFor(() => expect(screen.getByText(/3 candidates awaiting review/)).toBeDefined());
  });
});
