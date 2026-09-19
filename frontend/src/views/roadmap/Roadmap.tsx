// Roadmap kanban (plan 11 §5). Columns come from the pure board module; dnd-kit
// supplies pointer + keyboard dragging. Every move is applied optimistically and
// then POSTed — a failure toasts and reloads from the server, which is the
// source of truth for ordering.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type CollisionDetection,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { apiGet, apiPost } from '../../lib/api';
import { useProjects } from '../../shell/project';
import { useToast } from '../../shell/toast';
import { ViewHeader } from '../../components/ViewHeader';
import { Column } from './Column';
import { IdeaCard, nextPriority } from './IdeaCard';
import { IdeaFormModal } from './IdeaFormModal';
import { useSettings } from '../../shell/settings';
import {
  WORKING_COLUMNS,
  applyPriorityChange,
  applyReorder,
  columnCards,
  dropTargetIndex,
  priorityBandCards,
} from './board';
import type { IdeaRow, IdeaStatus } from '../../lib/types';

const SCOPES = ['both', 'project', 'global'] as const;
type Scope = (typeof SCOPES)[number];

function matchesSearch(card: IdeaRow, rawQuery: string): boolean {
  const terms = rawQuery.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const searchable = [
    card.id,
    `#${card.id}`,
    card.title,
    card.detail ?? '',
    card.evidence ?? '',
  ].join('\n').toLocaleLowerCase();
  return terms.every((term) => searchable.includes(term));
}

// A sortable card is both draggable and droppable. On a crowded board its own
// small rectangle can be closer than a very tall destination column, causing
// dnd-kit to report a self-drop. The active card is never a useful target.
const roadmapCollisionDetection: CollisionDetection = (args) => {
  // Pointer geometry is authoritative. Keeping the active card in this set is
  // what makes a small jiggle released over itself a no-op.
  if (args.pointerCoordinates) return pointerWithin(args);

  // Keyboard dragging has no pointer. There the active sortable would always
  // win a distance comparison, so exclude it only for this fallback.
  const droppableContainers = args.droppableContainers.filter(
    (container) => container.id !== args.active.id
  );
  return closestCorners({ ...args, droppableContainers });
};

export function Roadmap() {
  const { project } = useProjects();
  const toast = useToast();
  const { settings, setSetting } = useSettings();
  const marker = settings['roadmap.global_marker'];
  const [markerOpen, setMarkerOpen] = useState(false);
  const [markerDraft, setMarkerDraft] = useState('');
  const [editCard, setEditCard] = useState<IdeaRow | null>(null);

  const scopeLabel = (s: Scope): string => (s === 'global' ? `global ${marker}` : s);

  const saveMarker = useCallback(async () => {
    const ok = await setSetting('roadmap.global_marker', markerDraft);
    if (ok) setMarkerOpen(false);
  }, [markerDraft, setSetting]);
  const [cards, setCards] = useState<IdeaRow[]>([]);
  const [scope, setScope] = useState<Scope>('both');
  const [history, setHistory] = useState(false);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [search, setSearch] = useState('');
  const reorderQueue = useRef<Promise<void>>(Promise.resolve());
  const reorderGeneration = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    if (!project) return;
    setLoading(true);
    try {
      const response = await apiGet<{ rows: IdeaRow[] }>('/ideas', {
        scope,
        // Shipped is a visible board column, so its rows must always be loaded.
        // Dropped rows stay visually hidden until the history control opens.
        closed: '1',
      });
      setCards(response.rows);
    } catch (err) {
      setCards([]);
      toast.push('error', err instanceof Error ? err.message : 'Could not load the board');
    } finally {
      setLoading(false);
    }
  }, [project, scope, toast]);

  useEffect(() => { void load(); }, [load]);

  /** Persist one operator move; roll back to the server's state on failure. */
  const commitMove = useCallback(
    async (id: string, body: Record<string, unknown>) => {
      try {
        await apiPost('/ideas/move', { idea_id: id, ...body });
      } catch (err) {
        toast.push('error', err instanceof Error ? err.message : 'Move failed');
        load();
      }
    },
    [toast, load]
  );

  /** Persist one complete target-column order atomically. */
  const commitReorder = useCallback(
    (id: string, status: IdeaStatus, expectedIds: string[], orderedIds: string[]) => {
      const generation = reorderGeneration.current;
      const pending = reorderQueue.current.then(async () => {
        if (generation !== reorderGeneration.current) return;
        try {
          await apiPost('/ideas/reorder', {
            idea_id: id,
            status,
            scope,
            include_closed: true,
            expected_ids: expectedIds,
            ordered_ids: orderedIds,
          });
        } catch (err) {
          // Every later payload was computed from this failed optimistic state.
          // Invalidate them, restore the server snapshot, then release the queue.
          reorderGeneration.current += 1;
          toast.push('error', err instanceof Error ? err.message : 'Move failed');
          await load();
        }
      });
      reorderQueue.current = pending;
    },
    [scope, toast, load]
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const activeId = String(event.active.id);
      const overId = event.over ? String(event.over.id) : null;
      if (!overId || overId === activeId) return;
      const active = cards.find((card) => card.id === activeId);
      if (!active) return;

      const isColumn = (WORKING_COLUMNS as string[]).includes(overId);
      const status: IdeaStatus | undefined = isColumn
        ? (overId as IdeaStatus)
        : cards.find((c) => c.id === overId)?.status;
      if (!status) return;

      const expectedIds = priorityBandCards(cards, status, active.priority, active.project_id)
        .map((card) => card.id);
      const index = dropTargetIndex(cards, status, activeId, overId);
      const next = applyReorder(cards, activeId, status, index);
      if (next === cards) return;

      setCards(next);
      const orderedIds = priorityBandCards(next, status, active.priority, active.project_id)
        .map((card) => card.id);
      commitReorder(activeId, status, expectedIds, orderedIds);
    },
    [cards, commitReorder]
  );

  /** Keyboard fallback: ←/→ send the focused card to the adjacent column, on top. */
  const nudge = useCallback(
    (card: IdeaRow, delta: 1 | -1) => {
      const from = WORKING_COLUMNS.indexOf(card.status);
      const to = from + delta;
      if (from === -1 || to < 0 || to >= WORKING_COLUMNS.length) return;
      const status = WORKING_COLUMNS[to];
      const expectedIds = priorityBandCards(cards, status, card.priority, card.project_id)
        .map((item) => item.id);
      const next = applyReorder(cards, card.id, status, 0);
      setCards(next);
      const orderedIds = priorityBandCards(next, status, card.priority, card.project_id)
        .map((item) => item.id);
      commitReorder(card.id, status, expectedIds, orderedIds);
    },
    [cards, commitReorder]
  );

  const cyclePriority = useCallback(
    (card: IdeaRow) => {
      const priority = nextPriority(card.priority);
      setCards((current) => applyPriorityChange(current, card.id, priority));
      void commitMove(card.id, { priority });
    },
    [commitMove]
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const searchActive = search.trim().length > 0;
  const visibleCards = useMemo(() => cards.filter((card) => matchesSearch(card, search)), [cards, search]);
  const dropped = columnCards(visibleCards, 'dropped');

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <ViewHeader title="Roadmap" subtitle="park ideas, then run them — agents move with evidence, curation is yours">
        <div className="flex items-center gap-1.5 rounded-lg border border-deep-800 p-0.5">
          {SCOPES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              aria-pressed={scope === s}
              className={
                'rounded-md px-2.5 py-1 text-xs transition-colors ' +
                (scope === s ? 'bg-deep-800 text-flow-300' : 'text-ink-dim hover:text-ink')
              }
            >
              {scopeLabel(s)}
            </button>
          ))}
        </div>
        <div className="relative">
          <button
            type="button"
            onClick={() => { setMarkerDraft(marker); setMarkerOpen((v) => !v); }}
            aria-expanded={markerOpen}
            aria-label="Change the global-board marker"
            title="global-board marker — click to change"
            className="rounded-lg border border-deep-800 px-2 py-1 text-sm transition-colors hover:border-flow-400/60"
          >
            {marker}
          </button>
          {markerOpen && (
            <div className="absolute right-0 top-full z-30 mt-1 flex items-center gap-1.5 rounded-lg border border-deep-700 bg-deep-900 p-2 shadow-xl shadow-black/40">
              <input
                autoFocus
                value={markerDraft}
                maxLength={16}
                onChange={(e) => setMarkerDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveMarker();
                  else if (e.key === 'Escape') setMarkerOpen(false);
                }}
                aria-label="Global-board marker"
                className="w-20 rounded-md border border-deep-700 bg-deep-950 px-2 py-1 text-center text-sm text-ink outline-none focus:border-flow-400"
              />
              <button
                type="button"
                onClick={() => void saveMarker()}
                disabled={!markerDraft.trim()}
                className="rounded-md bg-deep-800 px-2 py-1 text-xs text-flow-300 transition-colors hover:bg-deep-700 disabled:opacity-40"
              >
                save
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="rounded-lg border border-deep-700 bg-deep-800 px-3 py-1.5 text-sm text-ink-dim transition-colors hover:border-flow-400/60 hover:text-ink"
        >
          <span aria-hidden className="text-flow-300">+</span> Idea
        </button>
      </ViewHeader>

      <div className="mb-5 flex items-center gap-2 rounded-xl border border-deep-800 bg-deep-900/60 px-3 py-2 focus-within:border-flow-400/60">
        <span aria-hidden className="text-sm text-ink-faint">⌕</span>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setSearch('');
          }}
          aria-label="Search roadmap"
          placeholder="Search title, description, evidence, or UUID…"
          className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
        />
        {searchActive && (
          <>
            <span aria-live="polite" className="font-mono text-[0.66rem] text-ink-faint">
              {visibleCards.length} {visibleCards.length === 1 ? 'match' : 'matches'}
            </span>
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label="Clear roadmap search"
              className="rounded px-1.5 py-0.5 text-xs text-ink-faint transition-colors hover:bg-deep-800 hover:text-flow-300"
            >
              clear
            </button>
          </>
        )}
      </div>

      {loading ? (
        <div className="text-sm text-ink-faint">loading…</div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={roadmapCollisionDetection} onDragEnd={onDragEnd}>
          <div className="grid grid-cols-4 gap-3">
            {WORKING_COLUMNS.map((status) => {
              const col = columnCards(visibleCards, status);
              return (
                <Column
                  key={status}
                  status={status}
                  ids={col.map((c) => c.id)}
                  count={col.length}
                  emptyLabel={searchActive ? 'no matches' : 'drop here'}
                >
                  {col.map((c) => (
                    <IdeaCard
                      key={c.id}
                      card={c}
                      globalMarker={scope === 'both' ? marker : null}
                      onEdit={setEditCard}
                      onCyclePriority={cyclePriority}
                      onNudge={nudge}
                      previousStatus={WORKING_COLUMNS[WORKING_COLUMNS.indexOf(c.status) - 1]}
                      nextStatus={WORKING_COLUMNS[WORKING_COLUMNS.indexOf(c.status) + 1]}
                    />
                  ))}
                </Column>
              );
            })}
          </div>
        </DndContext>
      )}

      <footer className="mt-6 border-t border-deep-800 pt-4">
        <button
          type="button"
          onClick={() => setHistory((v) => !v)}
          aria-expanded={history}
          className="text-xs text-ink-faint transition-colors hover:text-flow-300"
        >
          {history ? '▾ history' : '▸ history'} — shipped & dropped
        </button>
        {(history || (searchActive && dropped.length > 0)) && (
          <div className="mt-3">
            {dropped.length === 0 ? (
              <p className="text-xs text-ink-faint">
                nothing dropped. Shipped cards sit in the Shipped column above.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {dropped.map((c) => (
                  <li key={c.id} className="flex items-baseline gap-2 text-xs text-ink-faint">
                    <span aria-hidden>·</span>
                    <span className="line-through">{c.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </footer>

      {addOpen && <IdeaFormModal mode="add" onClose={() => setAddOpen(false)} onSaved={load} />}
      {editCard && (
        <IdeaFormModal mode="edit" card={editCard} onClose={() => setEditCard(null)} onSaved={load} />
      )}
    </div>
  );
}
