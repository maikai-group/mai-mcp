// Left sidebar: brand, project switcher, the seven destinations (with a live
// review badge), and the "+ Note" action. Pure presentation — Shell owns state.
import { DESTINATIONS, DESTINATION_LABELS, type Destination } from './destinations';
import { ProjectSwitcher } from './ProjectSwitcher';

const ICONS: Record<Destination, string> = {
  home: 'M3 11l9-8 9 8M5 10v10h14V10',
  review: 'M4 6h16M4 12h10M4 18h7',
  roadmap: 'M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v6h-4z',
  tasks: 'M5 5h14v14H5zM8 10l2 2 5-5M8 16h8',
  sharing: 'M18 8a3 3 0 100-6 3 3 0 000 6zM6 15a3 3 0 100-6 3 3 0 000 6zM18 22a3 3 0 100-6 3 3 0 000 6zM8.6 10.5l6.8-3.2M8.6 13.5l6.8 3.2',
  profile: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 20c0-3 4-5 8-5s8 2 8 5',
  graph: 'M5 6a2 2 0 100-.01M19 8a2 2 0 100-.01M15 18a2 2 0 100-.01M6.5 6.5l10 1.5M17 9l-2 7',
  search: 'M11 4a7 7 0 105.2 11.7L21 20M11 4a7 7 0 015 12',
  timeline: 'M12 4v16M12 7l4-1M12 12l-4-1M12 16l4-1',
  sessions: 'M4 5h16v14H4zM4 9h16',
  topics: 'M4 5h10l6 6v8H4zM14 5v6h6',
};

function NavIcon({ d }: { d: string }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

export function Nav({
  active,
  onNavigate,
  reviewCount,
  taskCount,
  onNewNote,
}: {
  active: Destination;
  onNavigate: (d: Destination) => void;
  reviewCount: number | null;
  taskCount: number | null;
  onNewNote: () => void;
}) {
  return (
    <nav className="flex h-full w-56 shrink-0 flex-col border-r border-deep-800 bg-deep-900 px-3 py-4">
      <div className="mb-5 px-1">
        <div className="flex items-center gap-2">
          <span aria-hidden className="text-lg">🌊</span>
          <span className="bg-gradient-to-r from-flow-400 to-flow-300 bg-clip-text text-lg font-semibold tracking-tight text-transparent">
            mai
          </span>
        </div>
        <p className="mt-0.5 text-[0.62rem] uppercase tracking-[0.18em] text-ink-faint">brain</p>
      </div>

      <div className="mb-4">
        <ProjectSwitcher />
      </div>

      <ul className="flex flex-1 flex-col gap-0.5">
        {DESTINATIONS.map((d) => {
          const isActive = d === active;
          return (
            <li key={d}>
              <button
                type="button"
                onClick={() => onNavigate(d)}
                aria-current={isActive ? 'page' : undefined}
                className={
                  'group relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors ' +
                  (isActive ? 'bg-deep-800 text-ink' : 'text-ink-dim hover:bg-deep-800/50 hover:text-ink')
                }
              >
                {isActive && (
                  <span aria-hidden className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-gradient-to-b from-flow-400 to-flow-300" />
                )}
                <span className={isActive ? 'text-flow-300' : 'text-ink-faint group-hover:text-ink-dim'}>
                  <NavIcon d={ICONS[d]} />
                </span>
                <span className="flex-1 text-left">{DESTINATION_LABELS[d]}</span>
                {d === 'review' && reviewCount != null && reviewCount > 0 && (
                  <span data-testid="review-badge" className="rounded-full bg-flow-400/15 px-1.5 py-0.5 font-mono text-[0.62rem] text-flow-300">
                    {reviewCount > 99 ? '99+' : reviewCount}
                  </span>
                )}
                {d === 'tasks' && taskCount != null && taskCount > 0 && (
                  <span data-testid="tasks-badge" className="rounded-full bg-flow-400/15 px-1.5 py-0.5 font-mono text-[0.62rem] text-flow-300">
                    {taskCount > 99 ? '99+' : taskCount}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        onClick={onNewNote}
        className="mt-3 flex items-center justify-center gap-1.5 rounded-lg border border-deep-700 bg-deep-800 px-3 py-2 text-sm text-ink-dim transition-colors hover:border-flow-400/60 hover:text-ink"
      >
        <span aria-hidden className="text-flow-300">+</span> Note
      </button>
    </nav>
  );
}
