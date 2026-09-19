// Pure triage state machine (spec §6) — no React. Cursor + multi-select over the
// review rows; the view dispatches keyboard actions and calls the promote/
// retract/unretract POSTs, then dispatches `remove` on success.
import type { ReviewRow } from '../../lib/types';

export interface TriageState { rows: ReviewRow[]; cursor: number; selected: Set<string> }

export type TriageAction =
  | { type: 'load'; rows: ReviewRow[] }
  | { type: 'move'; delta: 1 | -1 } // j / k
  | { type: 'focus'; index: number } // click-to-focus a card
  | { type: 'toggleSelect' } // x (at cursor)
  | { type: 'remove'; ids: string[] }; // after approve/deny succeeds

function clampCursor(cursor: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(cursor, length - 1));
}

export function triageReduce(s: TriageState, a: TriageAction): TriageState {
  switch (a.type) {
    case 'load':
      return { rows: a.rows, cursor: 0, selected: new Set() };
    case 'move':
      return { ...s, cursor: clampCursor(s.cursor + a.delta, s.rows.length) };
    case 'focus':
      return { ...s, cursor: clampCursor(a.index, s.rows.length) };
    case 'toggleSelect': {
      const row = s.rows[s.cursor];
      if (!row) return s;
      const selected = new Set(s.selected);
      if (selected.has(row.id)) selected.delete(row.id);
      else selected.add(row.id);
      return { ...s, selected };
    }
    case 'remove': {
      const drop = new Set(a.ids);
      const rows = s.rows.filter((r) => !drop.has(r.id));
      const selected = new Set([...s.selected].filter((id) => !drop.has(id)));
      return { rows, cursor: clampCursor(s.cursor, rows.length), selected };
    }
  }
}

/** The ids an approve/deny acts on: the selection if any, else the cursor row. */
export function actionTargets(s: TriageState): string[] {
  if (s.selected.size > 0) return [...s.selected];
  const row = s.rows[s.cursor];
  return row ? [row.id] : [];
}

export const initialTriage: TriageState = { rows: [], cursor: 0, selected: new Set() };
