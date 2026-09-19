import type { CurationAction, CurationCard } from '../../lib/types';

export interface ReviewRequest {
  path: string;
  body: Record<string, unknown>;
}

export type CurationIntent = 'approve' | 'deny';

export function curationRequest(
  card: CurationCard,
  action: CurationAction,
  reason: string
): ReviewRequest {
  const target = { target_kind: card.targetKind, target_id: card.targetId };
  if (action === 'keep') {
    return { path: '/curation/keep', body: { ...target, basis: card.basis, note: reason || undefined } };
  }
  if (action === 'retire') {
    return { path: '/curation/retire', body: { ...target, reason: reason || 'retired from the review queue' } };
  }
  if (action === 'promote') {
    return { path: '/curation/promote', body: { target_id: card.targetId, note: reason || undefined } };
  }
  if (action === 'reject') {
    return { path: '/curation/reject', body: { target_id: card.targetId, note: reason || undefined } };
  }
  if (!card.citationId) throw new Error(`${action} requires a citation id`);
  if (action === 'apply') {
    return { path: '/curation/apply', body: { citation_id: card.citationId, note: reason || undefined } };
  }
  return { path: '/curation/dismiss', body: { citation_id: card.citationId, note: reason || undefined } };
}

/** The UI supplies intent, never an action enum. Selection of the
 * server-authoritative field lives here so approve cannot accidentally execute
 * denyAction (or vice versa) while every endpoint-mapping test stays green. */
export function curationRequestForIntent(
  card: CurationCard,
  intent: CurationIntent,
  reason: string
): ReviewRequest {
  return curationRequest(card, intent === 'approve' ? card.approveAction : card.denyAction, reason);
}

export function curationUndoRequest(card: CurationCard): ReviewRequest | null {
  if (card.denyAction !== 'retire') return null;
  return {
    path: '/curation/unretire',
    body: { target_kind: card.targetKind, target_id: card.targetId },
  };
}

/** Feedback for a deny batch with no reversible mutation. A retract proposal's
 * deny action is KEEP (one-window suppression); a supersede proposal's is
 * DISMISS (both entries remain live); a graduation proposal's is REJECT (the
 * lesson lives on, re-proposed after the window). Calling them all "dismiss"
 * lies about the stored verdict, so keep the wording in this production-tested
 * seam. */
export function curationNoUndoMessage(actions: readonly CurationAction[]): string {
  const keep = actions.filter((action) => action === 'keep').length;
  const dismiss = actions.filter((action) => action === 'dismiss').length;
  const reject = actions.filter((action) => action === 'reject').length;
  if (keep + dismiss + reject !== actions.length) throw new Error('non-undo feedback received an undoable action');
  const parts: string[] = [];
  if (keep > 0) parts.push(`kept ${keep} ${keep === 1 ? 'entry' : 'entries'} (one-window suppression recorded)`);
  if (dismiss > 0) parts.push(`dismissed ${dismiss} ${dismiss === 1 ? 'proposal' : 'proposals'} (both entries remain live)`);
  if (reject > 0) parts.push(`declined ${reject} graduation ${reject === 1 ? 'proposal' : 'proposals'} (lesson remains; may be re-proposed after the window)`);
  return `Recorded ${parts.join('; ')}.`;
}
