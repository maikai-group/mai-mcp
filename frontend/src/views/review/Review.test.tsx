import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CurationReviewRow } from '../../lib/types';

const mocks = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn(), push: vi.fn() }));

vi.mock('../../lib/api', () => ({ apiGet: mocks.apiGet, apiPost: mocks.apiPost }));
vi.mock('../../shell/project', () => ({
  useProjects: () => ({ project: 'demo', projects: [], setProject: vi.fn() }),
}));
vi.mock('../../shell/toast', () => ({ useToast: () => ({ push: mocks.push }) }));

import { Review } from './Review';

const row: CurationReviewRow = {
  kind: 'curation',
  id: 'decision:11111111-2222-3333-4444-555555555555',
  decision_type: 'agent-evidence',
  description: 'old memory', reasoning: null, confidence: 0.4,
  source: 'agent-inferred', keywords: [], timestamp: '2026-08-06T00:00:00.000Z',
  curation: {
    basis: 'agent-evidence', targetKind: 'decision',
    targetId: '11111111-2222-3333-4444-555555555555', targetSummary: 'old memory',
    isGlobal: false, globalNote: null, surfacedCount: 0, citedCount: 0,
    lastSurfacedAt: null, relearnedCount: null,
    proposedBy: 'agent@test', evidence: 'replacement is measured',
    replacementId: '22222222-3333-4444-5555-666666666666',
    replacementSummary: 'new memory', candidateId: null,
    citationId: '33333333-4444-5555-6666-777777777777',
    approveLabel: 'Apply supersession', approveAction: 'apply',
    denyLabel: 'Dismiss proposal', denyAction: 'dismiss',
  },
};

describe('Review curation intent boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiGet.mockResolvedValue({ rows: [row] });
    mocks.apiPost.mockResolvedValue({ message: 'ok' });
  });
  afterEach(() => cleanup());

  it('Approve selects approveAction — apply, never denyAction/dismiss', async () => {
    render(<Review />);
    await screen.findByText('old memory');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith(
      '/curation/apply',
      { citation_id: row.curation.citationId, note: undefined },
    ));
    expect(mocks.apiPost).not.toHaveBeenCalledWith('/curation/dismiss', expect.anything());
  });

  it('Deny selects denyAction — dismiss, never approveAction/apply', async () => {
    render(<Review />);
    await screen.findByText('old memory');
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    fireEvent.change(screen.getByPlaceholderText(/why these don't belong/), {
      target: { value: 'keep the old memory' },
    });
    const denyButtons = screen.getAllByRole('button', { name: 'Deny' });
    fireEvent.click(denyButtons[denyButtons.length - 1]);
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith(
      '/curation/dismiss',
      { citation_id: row.curation.citationId, note: 'keep the old memory' },
    ));
    expect(mocks.apiPost).not.toHaveBeenCalledWith('/curation/apply', expect.anything());
  });
});

const graduateRow: CurationReviewRow = {
  kind: 'curation',
  id: 'lesson:44444444-5555-6666-7777-888888888888',
  decision_type: 'graduate',
  description: 'always release the client before rendering',
  reasoning: null, confidence: 0, source: 'usage-telemetry',
  keywords: [], timestamp: '2026-08-14T00:00:00.000Z',
  curation: {
    basis: 'graduate', targetKind: 'lesson',
    targetId: '44444444-5555-6666-7777-888888888888',
    targetSummary: 'always release the client before rendering',
    isGlobal: false, globalNote: null, surfacedCount: 0, citedCount: 0,
    lastSurfacedAt: null, relearnedCount: 6, proposedBy: null, evidence: null,
    replacementId: null, replacementSummary: null, candidateId: null,
    citationId: null,
    approveLabel: 'Promote to project rule', approveAction: 'promote',
    denyLabel: 'Not a rule', denyAction: 'reject',
  },
};

describe('Review graduation rows (plan 27)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.apiGet.mockResolvedValue({ rows: [graduateRow] });
    mocks.apiPost.mockResolvedValue({ message: 'ok' });
  });
  afterEach(() => cleanup());

  it('renders the SERVER-provided graduation controls, not generic curation wording', async () => {
    render(<Review />);
    await screen.findByText('always release the client before rendering');
    const actions = screen.getByTestId('curation-actions').textContent ?? '';
    expect(actions).toContain('Promote to project rule');
    expect(actions).toContain('Not a rule');
    expect(actions).not.toContain('Keep entry');
    expect(actions).not.toContain('Retire entry');
  });

  it('Approve dispatches promote with target_id and no citation', async () => {
    render(<Review />);
    await screen.findByText('always release the client before rendering');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalledWith(
      '/curation/promote',
      { target_id: graduateRow.curation.targetId, note: undefined },
    ));
    expect(mocks.apiPost).not.toHaveBeenCalledWith('/curation/reject', expect.anything());
  });
});
