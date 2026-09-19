// One roadmap card. The whole card is the drag handle (dnd-kit sortable);
// pointer drags need 5px of travel, so chip clicks still register as clicks.
// Keyboard: ←/→ move the focused card between columns. The drag transform is
// written out by hand rather than pulling in @dnd-kit/utilities — core and
// sortable are the only declared dnd deps.
import { useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { shortId } from '../../lib/format';
import type { IdeaPriority, IdeaRow, IdeaStatus } from '../../lib/types';

const PRIORITY_TONE: Record<IdeaPriority, string> = {
  now: 'border-flow-300/50 text-flow-300',
  next: 'border-kind-file/40 text-kind-file',
  later: 'border-deep-700 text-ink-dim',
  someday: 'border-deep-800 text-ink-faint',
};

export const PRIORITY_CYCLE: IdeaPriority[] = ['someday', 'later', 'next', 'now'];

export function nextPriority(p: IdeaPriority): IdeaPriority {
  return PRIORITY_CYCLE[(PRIORITY_CYCLE.indexOf(p) + 1) % PRIORITY_CYCLE.length];
}

export function IdeaCard({
  card,
  globalMarker,
  onCyclePriority,
  onNudge,
  onEdit,
  previousStatus,
  nextStatus,
}: {
  card: IdeaRow;
  /** Marker appended to global-board cards; null hides it (scoped views). */
  globalMarker: string | null;
  onCyclePriority: (card: IdeaRow) => void;
  onNudge: (card: IdeaRow, delta: 1 | -1) => void;
  onEdit: (card: IdeaRow) => void;
  previousStatus?: IdeaStatus;
  nextStatus?: IdeaStatus;
}) {
  const [open, setOpen] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
  });

  const copyFullId = async () => {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(card.id);
      setCopiedId(true);
      window.setTimeout(() => setCopiedId(false), 1_500);
    } catch {
      // The full UUID remains available in the button title when clipboard
      // permission is unavailable; never turn a reference click into an error.
    }
  };

  return (
    <article
      ref={setNodeRef}
      data-testid="idea-card"
      data-idea-id={card.id}
      style={{
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        transition,
      }}
      {...attributes}
      {...listeners}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') { e.preventDefault(); onNudge(card, 1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); onNudge(card, -1); }
      }}
      className={
        'group rounded-lg border bg-deep-900 p-3 transition-colors focus:outline-none cursor-grab ' +
        (isDragging
          ? 'border-flow-400/60 opacity-60 shadow-lg shadow-black/40'
          : 'border-deep-800 hover:border-deep-700 focus-visible:border-flow-400')
      }
    >
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-sm leading-snug text-ink">
          {card.title}
          {globalMarker !== null && card.project_id === null && (
            <span title="global board" aria-label="global board" className="ml-1.5 text-[0.7rem]">
              {globalMarker}
            </span>
          )}
        </p>
        <button
          type="button"
          data-testid="idea-id"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => void copyFullId()}
          aria-label={`Copy full idea ID ${card.id}`}
          title={`Copy full ID: ${card.id}`}
          className="shrink-0 rounded px-1 py-0.5 font-mono text-[0.62rem] text-ink-faint transition-colors hover:bg-deep-800 hover:text-flow-300"
        >
          #{shortId(card.id)}{copiedId ? ' ✓' : ''}
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          data-testid="priority-chip"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onCyclePriority(card)}
          title="click to cycle priority"
          className={
            'rounded-full border px-2 py-0.5 text-[0.66rem] transition-colors hover:border-flow-400 ' +
            PRIORITY_TONE[card.priority]
          }
        >
          {card.priority}
        </button>
        <span className="rounded-full border border-deep-800 px-2 py-0.5 text-[0.62rem] text-ink-faint">
          {card.source === 'user' ? 'you' : 'agent'}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            data-testid="idea-edit"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onEdit(card)}
            aria-label={`Edit ${card.title}`}
            title="edit this card"
            className="mr-0.5 text-[0.66rem] text-ink-faint transition-colors hover:text-flow-300"
          >
            edit
          </button>
          {card.detail && (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="mr-0.5 text-[0.66rem] text-ink-faint transition-colors hover:text-flow-300"
            >
              {open ? 'less' : 'more'}
            </button>
          )}
          {previousStatus && (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onNudge(card, -1)}
              aria-label={`Move ${card.title} to ${previousStatus}`}
              title={`move to ${previousStatus}`}
              className="rounded border border-deep-800 px-1.5 py-0.5 text-[0.66rem] text-ink-faint transition-colors hover:border-flow-400/50 hover:text-flow-300"
            >
              ←
            </button>
          )}
          {nextStatus && (
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onNudge(card, 1)}
              aria-label={`Move ${card.title} to ${nextStatus}`}
              title={`move to ${nextStatus}`}
              className="rounded border border-deep-800 px-1.5 py-0.5 text-[0.66rem] text-ink-faint transition-colors hover:border-flow-400/50 hover:text-flow-300"
            >
              →
            </button>
          )}
        </span>
      </div>

      {open && card.detail && (
        <p className="mt-2 border-t border-deep-800 pt-2 text-xs leading-relaxed text-ink-dim">{card.detail}</p>
      )}
      {open && card.evidence && (
        <p className="mt-1.5 font-mono text-[0.66rem] leading-relaxed text-ink-faint">{card.evidence}</p>
      )}
    </article>
  );
}
