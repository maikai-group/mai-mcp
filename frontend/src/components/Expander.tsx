// Collapsible section that mounts its children only after first open — lets the
// Search view lazy-load Similar/Recall/Edges only when the user asks for them.
import { useState, type ReactNode } from 'react';

export function Expander({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  return (
    <div className="overflow-hidden rounded-xl border border-deep-800 bg-deep-900">
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); setEverOpened(true); }}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm text-ink-dim transition-colors hover:text-ink"
      >
        <span>{label}</span>
        <span aria-hidden className={'text-ink-faint transition-transform ' + (open ? 'rotate-90' : '')}>›</span>
      </button>
      {open && <div className="border-t border-deep-800 px-4 py-3">{everOpened ? children : null}</div>}
    </div>
  );
}
