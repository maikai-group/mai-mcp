import type { ReactNode } from 'react';

// Shared page chrome: title, optional subtitle, and an optional controls slot.
export function ViewHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-faint">{subtitle}</p>}
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </header>
  );
}

// Loading / error / empty states shared by the markdown panels.
export function PanelState({ loading, error, empty, className }: { loading: boolean; error: string | null; empty?: boolean; className?: string }) {
  const stateClass = className ?? 'text-ink-faint';
  if (loading) return <div className={'text-sm ' + stateClass}>loading…</div>;
  if (error) return <div className="text-sm text-deny">{error}</div>;
  if (empty) return <div className={'text-sm ' + stateClass}>nothing here yet.</div>;
  return null;
}
