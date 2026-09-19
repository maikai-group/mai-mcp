import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Card } from './Card';
import { DenyModal } from './DenyModal';
import type { ReviewRow, CurationCard, DecisionReviewRow, FactReviewRow } from '../../lib/types';

const row = (over: Partial<DecisionReviewRow | FactReviewRow> = {}): DecisionReviewRow | FactReviewRow => ({
  kind: 'decision',
  id: '11111111-2222-3333-4444-555555555555',
  decision_type: 'arch',
  description: 'a queued candidate',
  reasoning: null,
  confidence: 0.5,
  source: 'agent-inferred',
  keywords: [],
  timestamp: '2026-08-06T00:00:00.000Z',
  ...over,
});

const renderCard = (r: ReviewRow) =>
  render(<Card row={r} focused={false} selected={false} onClick={() => {}} />);

describe('review Card kind badge', () => {
  afterEach(() => cleanup());

  it('renders a fact/<category> chip for fact rows', () => {
    renderCard(row({ kind: 'fact', decision_type: 'preference' }));
    expect(screen.getByTestId('kind-chip').textContent).toBe('fact/preference');
  });

  it('renders the plain decision-type chip for decision rows', () => {
    renderCard(row());
    expect(screen.queryByTestId('kind-chip')).toBeNull();
    expect(screen.getByText('arch')).toBeDefined();
  });
});
const curationRow = (over: Partial<CurationCard> = {}): ReviewRow => ({
  kind: 'curation',
  id: 'lesson:99999999-2222-3333-4444-555555555555',
  decision_type: 'never-cited',
  description: 'a rule nobody has ever cited',
  // NON-NULL on purpose: with reasoning:null the fixture hid the fact that
  // Card.tsx's pre-existing paragraph rendered the same body the chips render
  // (findings 18429b17 and fb1682b5). Kept populated so the next reader sees
  // the real payload, and so the suppression below is actually exercised.
  reasoning: 'surfaced ×4 / cited ×0 · last surfaced 2026-07-13 21:12',
  confidence: 0,
  source: 'usage-telemetry',
  keywords: ['curation'],
  timestamp: '2026-08-06T00:00:00.000Z',
  curation: {
    basis: 'never-cited',
    targetKind: 'lesson',
    targetId: '99999999-2222-3333-4444-555555555555',
    targetSummary: 'a rule nobody has ever cited',
    isGlobal: false,
    globalNote: null,
    surfacedCount: 4,
    citedCount: 0,
    lastSurfacedAt: null,
    relearnedCount: null,
    proposedBy: null,
    evidence: null,
    replacementId: null,
    replacementSummary: null,
    candidateId: null,
    citationId: null,
    approveLabel: 'Keep entry',
    approveAction: 'keep',
    denyLabel: 'Retire entry',
    denyAction: 'retire',
    ...over,
  },
});

describe('review Card — curation rows (plan 22 §5.1)', () => {
  afterEach(() => cleanup());

  it('renders the SERVER labels, never promote/retract wording', () => {
    renderCard(curationRow());
    const actions = screen.getByTestId('curation-actions').textContent ?? '';
    expect(actions).toContain('Keep entry');
    expect(actions).toContain('Retire entry');
    expect(actions).not.toMatch(/promote/i);
    expect(screen.getByTestId('kind-chip').textContent).toBe('curation/never-cited');
    // The body renders ONCE: the generic reasoning paragraph is suppressed for
    // curation rows, so the telemetry appears only in its own chip.
    const card = screen.getByTestId('review-card').textContent ?? '';
    expect(card.split('surfaced ×4 / cited ×0').length - 1).toBe(1);
    // ...and the mono id slot shows eight searchable hex chars, not the literal
    // 'lesson:f' that shortId() yields on the composite row id.
    expect(card).toContain('99999999');
  });

  it('a supersede proposal shows the INVERTED labels and the replacement entry', () => {
    renderCard(
      curationRow({
        basis: 'agent-evidence',
        citationId: 'aaaaaaaa-2222-3333-4444-555555555555',
        proposedBy: 'fable@codex',
        evidence: 'the measured protocol contradicts it',
        replacementSummary: 'zebra hydration protocol, measured version',
        approveLabel: 'Apply supersession',
        approveAction: 'apply',
        denyLabel: 'Dismiss proposal',
        denyAction: 'dismiss',
      })
    );
    const actions = screen.getByTestId('curation-actions').textContent ?? '';
    expect(actions).toContain('Apply supersession');
    expect(actions).toContain('Dismiss proposal');
    expect(screen.getByTestId('replacement').textContent).toContain('measured version');
  });

  it('the DENY modal repeats the every-project consequence and names the right noun', () => {
    // The modal is fixed inset-0 and covers the card, so the disclosure has to
    // survive the transition to the confirm step (finding 23b759eb).
    const note = 'GLOBAL lesson — retiring it removes this rule from EVERY project, not just this one.';
    render(<DenyModal count={1} noun="lesson" globalNote={note} onCancel={() => {}} onConfirm={() => {}} />);
    expect(screen.getByTestId('deny-global-consequence').textContent).toBe(note);
    expect(screen.getByText(/Deny 1 lesson/)).toBeDefined();
  });

  it('a GLOBAL lesson shows the badge AND the every-project consequence', () => {
    const note = 'GLOBAL lesson — retiring it removes this rule from EVERY project, not just this one.';
    renderCard(curationRow({ isGlobal: true, globalNote: note }));
    expect(screen.getByTestId('global-badge').textContent).toBe('GLOBAL');
    expect(screen.getByTestId('global-consequence').textContent).toBe(note);
  });

  it('a graduation proposal shows the relearned chip, not usage telemetry (plan 27)', () => {
    renderCard(
      curationRow({
        basis: 'graduate',
        relearnedCount: 6,
        approveLabel: 'Promote to project rule',
        approveAction: 'promote',
        denyLabel: 'Not a rule',
        denyAction: 'reject',
      })
    );
    expect(screen.getByTestId('telemetry').textContent).toBe('relearned \u00d76');
    // The usage-telemetry wording must be absent entirely \u2014 including from the
    // fixture's populated `reasoning`, which Card.tsx suppresses for curation
    // rows. A graduate card is proposed on relearn count, never on usage.
    const card = screen.getByTestId('review-card').textContent ?? '';
    expect(card).not.toContain('surfaced \u00d7');
    expect(card).not.toContain('cited \u00d7');
    expect(card).not.toContain('last surfaced');
  });
});
