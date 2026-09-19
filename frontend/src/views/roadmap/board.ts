// Pure kanban state (plan 11 §5) — no React, no dnd-kit. Column membership,
// deterministic drop ordering, and the optimistic local move the view applies
// before the server confirms. Tested standalone, like triage.ts.
import type { IdeaPriority, IdeaRow, IdeaStatus } from '../../lib/types';

export const WORKING_COLUMNS: IdeaStatus[] = ['idea', 'planned', 'building', 'shipped'];
export const PRIORITY_RANK = {
  now: 0,
  next: 1,
  later: 2,
  someday: 3,
} as const satisfies Record<IdeaPriority, number>;

function compareBandCards(a: IdeaRow, b: IdeaRow): number {
  return a.sort_order - b.sort_order
    || a.created_at.localeCompare(b.created_at)
    || a.id.localeCompare(b.id);
}

export function columnCards(cards: IdeaRow[], status: IdeaStatus): IdeaRow[] {
  return cards.filter((c) => c.status === status).sort((a, b) =>
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    || Number(a.project_id === null) - Number(b.project_id === null)
    || compareBandCards(a, b)
  );
}

export function priorityBandCards(
  cards: IdeaRow[], status: IdeaStatus, priority: IdeaPriority,
  projectId: string | null,
): IdeaRow[] {
  return cards.filter((card) =>
    card.status === status
    && card.priority === priority
    && card.project_id === projectId
  ).sort(compareBandCards);
}

export function applyPriorityChange(
  cards: IdeaRow[], id: string, priority: IdeaPriority,
): IdeaRow[] {
  const moved = cards.find((card) => card.id === id);
  if (!moved || moved.priority === priority) return cards;
  const target = priorityBandCards(cards, moved.status, priority, moved.project_id);
  const sortOrder = target.length === 0
    ? 1000
    : Math.min(...target.map((card) => card.sort_order)) - 1000;
  return cards.map((card) => card.id === id
    ? { ...card, priority, sort_order: sortOrder }
    : card);
}

/** Insertion index after dnd-kit identifies the card under the pointer.
 * Moving down crosses that card, so insert after it; moving up inserts before.
 * Cross-column moves have no source index in the target and keep the existing
 * before-target behaviour. */
export function dropTargetIndex(
  cards: IdeaRow[], target: IdeaStatus, movedId: string, overId: string
): number {
  const moved = cards.find((card) => card.id === movedId);
  if (!moved) return -1;
  const over = cards.find((card) => card.id === overId);
  const sameTargetBand = over !== undefined
    && over.status === target
    && over.priority === moved.priority
    && over.project_id === moved.project_id;
  if (!sameTargetBand) return target === moved.status ? -1 : 0;
  const band = priorityBandCards(cards, target, moved.priority, moved.project_id);
  const movedIndex = band.findIndex((card) => card.id === movedId);
  const crossedIndex = band.findIndex((card) => card.id === overId);
  const rest = band.filter((card) => card.id !== movedId);
  const overIndex = rest.findIndex((c) => c.id === overId);
  if (overIndex === -1) return target === moved.status ? -1 : 0;
  return movedIndex !== -1 && crossedIndex !== -1 && movedIndex < crossedIndex
    ? overIndex + 1
    : overIndex;
}

/** Apply the requested insertion and rebalance the complete target column.
 * Persisting this ordered id list atomically avoids fractional-rank exhaustion
 * and remains deterministic when legacy rows already share the same rank. */
export function applyReorder(
  cards: IdeaRow[], id: string, status: IdeaStatus, index: number
): IdeaRow[] {
  const moved = cards.find((c) => c.id === id);
  if (!moved) return cards;
  if (index < 0) return cards;

  const target = priorityBandCards(cards, status, moved.priority, moved.project_id)
    .filter((card) => card.id !== id);
  const at = Math.max(0, Math.min(index, target.length));
  target.splice(at, 0, { ...moved, status });
  const ranks = new Map(target.map((card, position) => [card.id, (position + 1) * 1000]));

  return cards.map((card) => {
    const sortOrder = ranks.get(card.id);
    if (sortOrder === undefined) return card;
    return {
      ...card,
      status: card.id === id ? status : card.status,
      sort_order: sortOrder,
    };
  });
}
