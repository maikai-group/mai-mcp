// Deny modal (spec §6). One reason for the whole batch; reason required
// (mirrors the /api/retract contract).
import { useState } from 'react';

export function DenyModal({
  count,
  noun = 'decision',
  globalNote = null,
  onCancel,
  onConfirm,
}: {
  count: number;
  /** What is being denied — the review queue also carries global user-facts. */
  noun?: string;
  /** Server-supplied every-project consequence, when the batch retires a global
   * lesson. Rendered verbatim: this modal covers the card that carries it. */
  globalNote?: string | null;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-deep-950/70 p-4 backdrop-blur-sm" onClick={onCancel}>
      <div
        className="w-full max-w-lg animate-[panelin_160ms_ease-out] rounded-xl border border-deep-700 bg-deep-900 p-5 shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-sm font-semibold text-ink">
          Deny {count} {count === 1 ? noun : `${noun}s`}
        </h2>
        {globalNote && (
          <p data-testid="deny-global-consequence" className="mb-2 text-xs font-medium leading-relaxed text-deny">
            {globalNote}
          </p>
        )}
        <p className="mb-4 text-xs text-ink-faint">A reason is required — retraction without a stated reason is not allowed.</p>
        <textarea
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && reason.trim()) onConfirm(reason.trim());
          }}
          placeholder="why these don't belong…"
          rows={3}
          className="w-full resize-y rounded-lg border border-deep-700 bg-deep-950 p-3 text-sm text-ink outline-none focus:border-deny"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-md px-3 py-1.5 text-sm text-ink-dim hover:text-ink">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => reason.trim() && onConfirm(reason.trim())}
            disabled={!reason.trim()}
            className="rounded-md bg-deny px-4 py-1.5 text-sm font-medium text-deep-950 transition-opacity disabled:opacity-40"
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}
