// "+ Note" modal — writes to the server's pinned tracking dir via /api/note.
// Note is pinned-only (server-side), so it ignores the selected project.
import { useState } from 'react';
import { apiPost } from '../lib/api';
import { useToast } from './toast';

const NOTE_TYPES = ['decision', 'progress', 'todo', 'question', 'observation'] as const;
type NoteType = (typeof NOTE_TYPES)[number];

export function NoteModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [type, setType] = useState<NoteType>('decision');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    const c = content.trim();
    if (!c || busy) return;
    setBusy(true);
    try {
      await apiPost('/note', { type, content: c });
      toast.push('success', 'Note appended to the tracking dir.');
      onClose();
    } catch (err) {
      toast.push('error', err instanceof Error ? err.message : 'Note failed');
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-deep-950/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg animate-[panelin_160ms_ease-out] rounded-xl border border-deep-700 bg-deep-900 p-5 shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">New note</h2>
          <button type="button" aria-label="close" onClick={onClose} className="text-ink-faint hover:text-ink">
            ×
          </button>
        </div>
        <p className="mb-4 text-xs text-ink-faint">
          Writes to the server's pinned project tracking dir — not the selected project.
        </p>
        <div className="mb-3 flex flex-wrap gap-1.5">
          {NOTE_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className={
                'rounded-full border px-3 py-1 text-xs transition-colors ' +
                (type === t
                  ? 'border-flow-400 bg-deep-700 text-flow-300'
                  : 'border-deep-700 text-ink-dim hover:border-flow-400/50')
              }
            >
              {t}
            </button>
          ))}
        </div>
        <textarea
          autoFocus
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
          }}
          placeholder="What happened? (⌘/Ctrl+Enter to save)"
          rows={4}
          className="w-full resize-y rounded-lg border border-deep-700 bg-deep-950 p-3 text-sm text-ink outline-none focus:border-flow-400"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-ink-dim hover:text-ink">
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !content.trim()}
            className="rounded-md bg-gradient-to-br from-flow-400 to-flow-300 px-4 py-1.5 text-sm font-medium text-deep-950 transition-opacity disabled:opacity-40"
          >
            {busy ? 'Saving…' : 'Save note'}
          </button>
        </div>
      </div>
    </div>
  );
}
