import { describe, expect, it } from 'vitest';
import {
  curationNoUndoMessage,
  curationRequest,
  curationRequestForIntent,
  curationUndoRequest,
} from './review-actions';
import type { CurationAction, CurationCard } from '../../lib/types';

const card = (over: Partial<CurationCard> = {}): CurationCard => ({
  basis: 'never-cited', targetKind: 'lesson', targetId: 'target-id',
  targetSummary: 'target', isGlobal: false, globalNote: null,
  surfacedCount: 1, citedCount: 0, lastSurfacedAt: null, relearnedCount: null,
  proposedBy: null, evidence: null, replacementId: null, replacementSummary: null,
  candidateId: null, citationId: null,
  approveLabel: 'Keep entry', approveAction: 'keep',
  denyLabel: 'Retire entry', denyAction: 'retire', ...over,
});

describe('production curation action mapping', () => {
  it('prune approve maps exactly to keep', () => {
    expect(curationRequestForIntent(card({ approveAction: 'keep', denyAction: 'retire' }), 'approve', '')).toEqual({
      path: '/curation/keep',
      body: { target_kind: 'lesson', target_id: 'target-id', basis: 'never-cited', note: undefined },
    });
  });
  it('prune deny maps exactly to retire', () => {
    expect(curationRequestForIntent(card({ approveAction: 'keep', denyAction: 'retire' }), 'deny', 'operator reason')).toEqual({
      path: '/curation/retire',
      body: { target_kind: 'lesson', target_id: 'target-id', reason: 'operator reason' },
    });
  });
  it('supersede approve maps exactly to apply', () => {
    expect(curationRequestForIntent(card({
      citationId: 'citation-id', approveAction: 'apply', denyAction: 'dismiss',
    }), 'approve', '')).toEqual({
      path: '/curation/apply', body: { citation_id: 'citation-id', note: undefined },
    });
  });
  it('supersede deny maps exactly to dismiss', () => {
    expect(curationRequestForIntent(card({
      citationId: 'citation-id', approveAction: 'apply', denyAction: 'dismiss',
    }), 'deny', 'keep old')).toEqual({
      path: '/curation/dismiss', body: { citation_id: 'citation-id', note: 'keep old' },
    });
  });
  it('only retire has an undo request; no curation request can reach promote/retract', () => {
    expect(curationUndoRequest(card())).toEqual({
      path: '/curation/unretire', body: { target_kind: 'lesson', target_id: 'target-id' },
    });
    expect(curationUndoRequest(card({ denyAction: 'dismiss' }))).toBeNull();
    const actions: CurationAction[] = ['keep', 'retire', 'apply', 'dismiss'];
    for (const action of actions) {
      const req = curationRequest(card({ citationId: 'citation-id' }), action, 'reason');
      expect(req.path).not.toBe('/promote');
      expect(req.path).not.toBe('/retract');
    }
  });
  it('non-Undo feedback distinguishes keep, dismiss, and a mixed batch', () => {
    expect(curationNoUndoMessage(['keep'])).toBe(
      'Recorded kept 1 entry (one-window suppression recorded).'
    );
    expect(curationNoUndoMessage(['dismiss'])).toBe(
      'Recorded dismissed 1 proposal (both entries remain live).'
    );
    expect(curationNoUndoMessage(['keep', 'dismiss'])).toBe(
      'Recorded kept 1 entry (one-window suppression recorded); dismissed 1 proposal (both entries remain live).'
    );
    expect(() => curationNoUndoMessage(['retire'])).toThrow(/undoable action/);
  });
});

describe('graduation actions (plan 27)', () => {
  const gradCard: CurationCard = {
    basis: 'graduate', targetKind: 'lesson', targetId: 'lesson-1',
    targetSummary: 'a rule', isGlobal: false, globalNote: null,
    surfacedCount: 0, citedCount: 0, lastSurfacedAt: null, relearnedCount: 6,
    proposedBy: null, evidence: null, replacementId: null, replacementSummary: null,
    candidateId: null, citationId: null,
    approveLabel: 'Promote to project rule', approveAction: 'promote',
    denyLabel: 'Not a rule', denyAction: 'reject',
  };
  it('promote → /curation/promote with target_id, no citation required', () => {
    expect(curationRequest(gradCard, 'promote', '')).toEqual({
      path: '/curation/promote', body: { target_id: 'lesson-1', note: undefined },
    });
  });
  it('reject → /curation/reject with target_id + note', () => {
    expect(curationRequest(gradCard, 'reject', 'not general enough')).toEqual({
      path: '/curation/reject', body: { target_id: 'lesson-1', note: 'not general enough' },
    });
  });
  it('intent mapping uses server-authoritative actions', () => {
    expect(curationRequestForIntent(gradCard, 'approve', '').path).toBe('/curation/promote');
    expect(curationRequestForIntent(gradCard, 'deny', '').path).toBe('/curation/reject');
  });
  it('reject has no undo and its own no-undo wording', () => {
    expect(curationUndoRequest(gradCard)).toBeNull();
    expect(curationNoUndoMessage(['reject'])).toContain('declined 1 graduation proposal');
  });
});
