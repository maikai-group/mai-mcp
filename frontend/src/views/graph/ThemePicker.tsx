// Theme selector (spec §3.2). Writes through the store, which is the ONLY place
// the preference is persisted by the shell settings owner (R2); this component
// is controlled and performs no I/O.
//
// DOM values are strings, so resolve through the total validator before the
// typed callback. No assertion is needed and callers receive only ThemeId.
import { resolveThemeId, THEMES, type ThemeId } from '../../lib/themes';

export function ThemePicker({
  active,
  onPick,
  label = 'graph theme',
}: {
  active: ThemeId;
  onPick: (id: ThemeId) => void;
  label?: string;
}) {
  return (
    <select
      aria-label={label}
      value={active}
      onChange={(e) => onPick(resolveThemeId(e.target.value))}
      className="rounded-md border border-[var(--graph-border)] bg-[var(--graph-panel)] px-2 py-1.5 text-xs text-[var(--graph-text-dim)] backdrop-blur"
    >
      {THEMES.map((t) => (
        <option key={t.id} value={t.id}>{t.name}</option>
      ))}
    </select>
  );
}
