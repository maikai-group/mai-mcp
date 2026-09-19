// Hero-mode toggle (plan 47). Scope, not projection: 2D/3D chooses how the
// graph is drawn, this chooses how much of it is drawn. Kept separate so "3D
// exploration" stays reachable — that is the view the Z-modes were built for.
export function HeroToggle({
  active,
  loading,
  disabled,
  disabledReason,
  truncatedNote,
  onToggle,
}: {
  active: boolean;
  loading: boolean;
  /** True when hero cannot render at all (WebGL unavailable): entry is refused
   * HERE, at the toggle, rather than after fetching 25,000 elements nothing
   * can draw (R7). Mirrors ZModePicker.tsx:30-31's disabled/title shape. */
  disabled: boolean;
  /** Why the toggle is disabled — surfaces in `title` so the refusal explains
   * itself. Null whenever `disabled` is false. */
  disabledReason: string | null;
  /** Non-null only when the payload was capped. Shown so a truncated graph can
   * never look complete. */
  truncatedNote: string | null;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onToggle}
        disabled={loading || disabled}
        aria-pressed={active}
        data-hero-mode={active ? 'on' : 'off'}
        title={disabled
          ? disabledReason ?? 'hero mode unavailable'
          : active ? 'Show the landing constellation' : 'Draw the whole graph'}
        className={'rounded-md border px-3 py-1.5 text-xs disabled:opacity-35 ' + (active
          ? 'border-[var(--graph-accent)] text-[var(--graph-accent)]'
          : 'border-[var(--graph-border)] text-[var(--graph-text-dim)]')}
      >
        {loading ? 'loading…' : 'everything'}
      </button>
      {truncatedNote !== null && (
        <span data-hero-truncated="1" className="text-[0.66rem] text-[var(--graph-text-dim)]">
          {truncatedNote}
        </span>
      )}
    </div>
  );
}
