// Z-mode selector (spec §3.4). A mode whose input is absent from the loaded
// payload is DISABLED with the reason in its tooltip — never silently mapped to
// a fabricated plane. Availability comes from the pure model, not from here.
import { Z_MODES, zModeUnavailableReason, type ZMode } from './model';

const LABEL: Record<ZMode, string> = {
  time: 'time',
  abstraction: 'abstraction',
  confidence: 'confidence',
  free: 'free',
};

export function ZModePicker({
  active,
  availability,
  onPick,
}: {
  active: ZMode;
  availability: Record<ZMode, boolean>;
  onPick: (mode: ZMode) => void;
}) {
  return (
    <div className="flex items-center gap-1" data-zmode={active}>
      <span className="pr-1 text-[0.66rem] text-[var(--graph-text-dim)]">Z</span>
      {Z_MODES.map((mode) => {
        const enabled = availability[mode];
        return (
          <button
            key={mode}
            type="button"
            disabled={!enabled}
            title={enabled ? `Z axis: ${LABEL[mode]}` : zModeUnavailableReason(mode)}
            aria-pressed={mode === active}
            data-zmode-option={mode}
            data-zmode-available={enabled ? '1' : '0'}
            onClick={() => onPick(mode)}
            className={'rounded-md border px-2 py-1.5 text-xs disabled:opacity-35 ' + (mode === active
              ? 'border-[var(--graph-accent)] text-[var(--graph-accent)]'
              : 'border-[var(--graph-border)] text-[var(--graph-text-dim)] hover:border-[var(--graph-accent)]')}
          >
            {LABEL[mode]}
          </button>
        );
      })}
    </div>
  );
}
