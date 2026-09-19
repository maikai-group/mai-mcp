// Magnification, not zoom (spec §3.3): objective selector plus ⌂ (reload the
// landing graph) and Fit. Pure presentation — all state lives in the store.
import { OBJECTIVES, type ObjectivePower } from './model';

export function ObjectiveBar({
  active,
  onPick,
  onReset,
  onFit,
}: {
  active: ObjectivePower;
  onPick: (power: ObjectivePower) => void;
  onReset: () => void;
  onFit: () => void;
}) {
  return (
    <div className="flex items-center gap-1" data-objective={active}>
      {OBJECTIVES.map((o) => (
        <button
          key={o.power}
          type="button"
          onClick={() => onPick(o.power)}
          aria-pressed={o.power === active}
          className={'rounded-md border px-2 py-1.5 text-xs ' + (o.power === active
            ? 'border-[var(--graph-accent)] text-[var(--graph-accent)]'
            : 'border-[var(--graph-border)] text-[var(--graph-text-dim)] hover:border-[var(--graph-accent)]')}
        >
          {o.label}
        </button>
      ))}
      <button type="button" onClick={onReset} aria-label="reset to landing graph"
        className="rounded-md border border-[var(--graph-border)] px-2 py-1.5 text-xs text-[var(--graph-text-dim)] hover:border-[var(--graph-accent)]">⌂</button>
      <button type="button" onClick={onFit}
        className="rounded-md border border-[var(--graph-border)] px-2 py-1.5 text-xs text-[var(--graph-text-dim)] hover:border-[var(--graph-accent)]">Fit</button>
    </div>
  );
}
