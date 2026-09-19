// Kind legend (old A4 / plan 29 R6): a `kind · n` chip per present kind plus one
// show-all chip. Pure — every value is a prop, so it unit-tests without a canvas.
import { kindStyle } from '../../lib/kinds';

export function Legend({
  counts,
  hidden,
  onToggle,
  onShowAll,
}: {
  /** kind → number of loaded nodes of that kind. */
  counts: ReadonlyMap<string, number>;
  hidden: readonly string[];
  onToggle: (kind: string) => void;
  onShowAll: () => void;
}) {
  const kinds = [...counts.keys()].sort();
  if (kinds.length === 0) return null;
  return (
    <div
      className="absolute bottom-4 left-4 z-20 flex max-w-[60%] flex-wrap gap-1.5 rounded-lg border border-[var(--graph-border)] bg-[var(--graph-panel)] p-2 backdrop-blur"
      data-legend-kinds={kinds.length}
    >
      {kinds.map((k) => {
        const ks = kindStyle(k);
        const off = hidden.includes(k);
        return (
          <button
            key={k}
            type="button"
            onClick={() => onToggle(k)}
            aria-pressed={!off}
            className={'flex items-center gap-1.5 rounded-full border border-[var(--graph-border)] px-2 py-0.5 text-[0.66rem] transition-opacity ' + (off ? 'opacity-35' : '')}
          >
            <span className="h-2 w-2 rounded-full" style={{ background: ks.color }} />
            <span className="text-[var(--graph-text-dim)]">{ks.label} · {counts.get(k) ?? 0}</span>
          </button>
        );
      })}
      <button
        type="button"
        onClick={onShowAll}
        disabled={hidden.length === 0}
        className="flex items-center rounded-full border border-[var(--graph-accent)] px-2 py-0.5 text-[0.66rem] text-[var(--graph-accent)] disabled:opacity-35"
      >
        show all
      </button>
    </div>
  );
}
