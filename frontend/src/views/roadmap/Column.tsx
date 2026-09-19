// A kanban column: status label + count header, and the droppable card rail.
// Empty columns keep their drop target (a dashed well) so a card can always land.
import type { ReactNode } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { IdeaStatus } from '../../lib/types';

const COLUMN_TONE: Record<IdeaStatus, string> = {
  idea: 'text-ink-faint',
  planned: 'text-kind-file',
  building: 'text-flow-300',
  shipped: 'text-flow-400',
  dropped: 'text-ink-faint',
};

export function Column({
  status,
  ids,
  count,
  emptyLabel = 'drop here',
  children,
}: {
  status: IdeaStatus;
  ids: string[];
  count: number;
  emptyLabel?: string;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <section className="flex min-w-0 flex-col">
      <header className="mb-2.5 flex items-baseline gap-2 px-1">
        <h2 className={'text-xs font-semibold uppercase tracking-[0.14em] ' + COLUMN_TONE[status]}>{status}</h2>
        <span data-testid={`column-count-${status}`} className="font-mono text-[0.66rem] text-ink-faint">{count}</span>
      </header>
      <div
        ref={setNodeRef}
        data-testid={`column-${status}`}
        className={
          'flex min-h-40 flex-1 flex-col gap-2 rounded-xl border p-2 transition-colors ' +
          (isOver ? 'border-flow-400/50 bg-flow-400/[0.06]' : 'border-deep-800 bg-deep-900/40')
        }
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {children}
        </SortableContext>
        {count === 0 && (
          <p className="m-auto text-[0.7rem] text-ink-faint/70">{emptyLabel}</p>
        )}
      </div>
    </section>
  );
}
