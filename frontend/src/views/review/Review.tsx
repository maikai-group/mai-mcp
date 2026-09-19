// Review triage (spec §6). Keyboard-first: j/k move, x select, a approve, shift+a
// approve selection, d deny-with-reason. Approve → /promote, deny → /retract,
// undo → /unretract. A pure state machine (triage.ts) drives the cursor/selection.
import { useCallback, useEffect, useReducer, useState } from 'react';
import { apiGet, apiPost } from '../../lib/api';
import { useProjects } from '../../shell/project';
import { useToast } from '../../shell/toast';
import { ViewHeader } from '../../components/ViewHeader';
import { Card } from './Card';
import { DenyModal } from './DenyModal';
import { triageReduce, actionTargets, initialTriage } from './triage';
import type { ReviewRow, CurationReviewRow, CurationCard } from '../../lib/types';
import {
  curationNoUndoMessage,
  curationRequestForIntent,
  curationUndoRequest,
  type CurationIntent,
  type ReviewRequest,
} from './review-actions';

export function Review({ onQueueChanged }: { onQueueChanged?: () => void }) {
  const { project } = useProjects();
  const toast = useToast();
  const [state, dispatch] = useReducer(triageReduce, initialTriage);
  const [loading, setLoading] = useState(true);
  const [denyOpen, setDenyOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!project) return;
    setLoading(true);
    apiGet<{ rows: ReviewRow[] }>('/review', { format: 'json', limit: 100 })
      .then((r) => dispatch({ type: 'load', rows: r.rows }))
      .catch(() => dispatch({ type: 'load', rows: [] }))
      .finally(() => setLoading(false));
  }, [project]);

  useEffect(() => { load(); }, [load]);

  // The queue unions decisions and global user-facts — every curation POST
  // carries the row's kind so the server routes it to the right layer.
  const withKind = useCallback(
    (ids: string[]) =>
      ids.map((id) => ({ id, kind: state.rows.find((r) => r.id === id)?.kind ?? 'decision' })),
    [state.rows]
  );

  /** Dispatch ONE curation row on the server's action enum. Curation rows never
   * touch /promote or /retract: approve/deny invert per kind (plan 22 §5.1) and
   * a lesson cannot be retired through the decision route at all. */
  const curationPost = useCallback(
    async (card: CurationCard, intent: CurationIntent, reason: string): Promise<void> => {
      const req = curationRequestForIntent(card, intent, reason);
      return apiPost(req.path, req.body);
    },
    []
  );

  const curationRowsFor = useCallback(
    (ids: string[]): CurationReviewRow[] => {
      const wanted = new Set(ids);
      return state.rows.filter((r): r is CurationReviewRow => r.kind === 'curation' && wanted.has(r.id));
    },
    [state.rows]
  );

  /** What the confirm step calls the things being denied. A curation row reports
   * its own target kind ('lesson' / 'decision') instead of falling through to
   * 'decision', which is what a global-lesson retire used to say. */
  const denyNoun = useCallback(
    (ids: string[]): string => {
      const kinds = new Set(
        ids.map((id) => {
          const r = state.rows.find((row) => row.id === id);
          if (!r) return 'decision';
          return r.kind === 'curation' ? r.curation.targetKind : r.kind === 'fact' ? 'item' : 'decision';
        })
      );
      return kinds.size === 1 ? [...kinds][0] : 'item';
    },
    [state.rows]
  );

  /** The every-project consequence, verbatim from the server, when any row in
   * this batch is a global lesson — shown where the operator actually commits. */
  const denyGlobalNote = useCallback(
    (ids: string[]): string | null =>
      curationRowsFor(ids).find((r) => r.curation.isGlobal)?.curation.globalNote ?? null,
    [curationRowsFor]
  );

  const approve = useCallback(async (ids: string[]) => {
    if (ids.length === 0 || busy) return;
    setBusy(true);
    try {
      const curation = curationRowsFor(ids);
      const curationIds = new Set(curation.map((r) => r.id));
      const plain = withKind(ids).filter(({ id }) => !curationIds.has(id));
      await Promise.all([
        ...plain.map(({ id, kind }) => apiPost('/promote', { decision_id: id, kind })),
        ...curation.map((r) => curationPost(r.curation, 'approve', '')),
      ]);
      dispatch({ type: 'remove', ids });
      const parts: string[] = [];
      if (plain.length > 0) parts.push(`promoted ${plain.length}`);
      if (curation.length > 0) parts.push(`${curation.length} curation verdict(s) recorded`);
      toast.push('success', parts.join(', ') + '.');
      onQueueChanged?.();
    } catch (err) {
      toast.push('error', err instanceof Error ? err.message : 'Approve failed');
    } finally {
      setBusy(false);
    }
  }, [busy, toast, onQueueChanged, withKind, curationRowsFor, curationPost]);

  const deny = useCallback(async (ids: string[], reason: string) => {
    if (ids.length === 0 || busy) return;
    setBusy(true);
    const targets = withKind(ids);
    try {
      const curation = curationRowsFor(ids);
      const curationIds = new Set(curation.map((r) => r.id));
      await Promise.all([
        ...targets
          .filter(({ id }) => !curationIds.has(id))
          .map(({ id, kind }) => apiPost('/retract', { decision_id: id, kind, reason })),
        ...curation.map((r) => curationPost(r.curation, 'deny', reason)),
      ]);
      dispatch({ type: 'remove', ids });
      onQueueChanged?.();
      const undoable =
        targets.some(({ id }) => !curationIds.has(id)) ||
        curation.some((r) => r.curation.denyAction === 'retire');
      if (!undoable) {
        toast.push('info', curationNoUndoMessage(curation.map((r) => r.curation.denyAction)));
      } else toast.push('info', `Denied ${ids.length}.`, {
        label: 'Undo',
        run: () => {
          Promise.all([
            ...targets
              .filter(({ id }) => !curationIds.has(id))
              .map(({ id, kind }) => apiPost('/unretract', { decision_id: id, kind })),
            // Only a RETIRE is undoable; keep/dismiss changed no memory.
            ...curation
              .map((r) => curationUndoRequest(r.curation))
              .filter((req): req is ReviewRequest => req !== null)
              .map((req) => apiPost(req.path, req.body)),
          ])
            .then(() => { load(); onQueueChanged?.(); })
            .catch(() => toast.push('error', 'Undo failed'));
        },
      });
    } catch (err) {
      toast.push('error', err instanceof Error ? err.message : 'Deny failed');
    } finally {
      setBusy(false);
    }
  }, [busy, toast, onQueueChanged, load, withKind, curationRowsFor, curationPost]);

  // Keyboard triage — active while no modal is open and focus isn't in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (denyOpen) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const targets = actionTargets(state);
      switch (e.key) {
        case 'j': dispatch({ type: 'move', delta: 1 }); break;
        case 'k': dispatch({ type: 'move', delta: -1 }); break;
        case 'x': dispatch({ type: 'toggleSelect' }); break;
        case 'a':
          if (e.shiftKey) { if (state.selected.size > 0) approve([...state.selected]); }
          else approve(targets);
          break;
        case 'd': if (targets.length > 0) setDenyOpen(true); break;
        default: return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, denyOpen, approve]);

  const targets = actionTargets(state);

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <ViewHeader title="Review" subtitle="agent-inferred + low-confidence entries awaiting triage">
        <span className="font-mono text-xs text-ink-faint">
          j/k move · x select · a approve · ⇧a batch · d deny
        </span>
      </ViewHeader>

      {loading ? (
        <div className="text-sm text-ink-faint">loading…</div>
      ) : state.rows.length === 0 ? (
        <div className="rounded-xl border border-deep-800 bg-deep-900 px-6 py-16 text-center">
          <div aria-hidden className="mb-2 text-2xl">🌊</div>
          <p className="text-sm text-ink-dim">queue clear — the riverbed is settled.</p>
        </div>
      ) : (
        <>
          <div className="mb-4 flex items-center justify-between text-xs text-ink-faint">
            <span>{state.rows.length} in queue{state.selected.size > 0 ? ` · ${state.selected.size} selected` : ''}</span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => approve(targets)}
                disabled={busy || targets.length === 0}
                className="rounded-md border border-flow-400/40 px-3 py-1 text-flow-300 transition-colors hover:border-flow-400 disabled:opacity-40"
              >
                Approve{state.selected.size > 0 ? ` ${state.selected.size}` : ''}
              </button>
              <button
                type="button"
                onClick={() => targets.length > 0 && setDenyOpen(true)}
                disabled={busy || targets.length === 0}
                className="rounded-md border border-deny/40 px-3 py-1 text-deny transition-colors hover:border-deny disabled:opacity-40"
              >
                Deny{state.selected.size > 0 ? ` ${state.selected.size}` : ''}
              </button>
            </div>
          </div>
          <div className="flex flex-col gap-2.5">
            {state.rows.map((r, i) => (
              <Card
                key={r.id}
                row={r}
                focused={i === state.cursor}
                selected={state.selected.has(r.id)}
                onClick={() => dispatch({ type: 'focus', index: i })}
              />
            ))}
          </div>
        </>
      )}

      {denyOpen && (
        <DenyModal
          count={targets.length}
          noun={denyNoun(targets)}
          globalNote={denyGlobalNote(targets)}
          onCancel={() => setDenyOpen(false)}
          onConfirm={(reason) => { setDenyOpen(false); deny(targets, reason); }}
        />
      )}
    </div>
  );
}
