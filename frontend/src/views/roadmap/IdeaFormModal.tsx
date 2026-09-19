// Idea form modal — one form, two modes. 'add' parks a card via POST
// /api/ideas; 'edit' is the operator curation surface via POST
// /api/ideas/update, sending only the changed fields ('' clears detail).
// Scope picks the selected project's board or the one global board (never
// another project — the wall stands).
import { useMemo, useState } from 'react';
import { apiPost } from '../../lib/api';
import { useToast } from '../../shell/toast';
import { useSettings } from '../../shell/settings';
import type { IdeaPriority, IdeaRow } from '../../lib/types';

const PRIORITIES: IdeaPriority[] = ['now', 'next', 'later', 'someday'];
const SCOPES = ['project', 'global'] as const;
type WriteScope = (typeof SCOPES)[number];

export function IdeaFormModal({
  mode,
  card,
  onClose,
  onSaved,
}: {
  mode: 'add' | 'edit';
  card?: IdeaRow; // required when mode === 'edit'
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { settings } = useSettings();
  const marker = settings['roadmap.global_marker'];
  const editing = mode === 'edit' && card !== undefined ? card : null;
  const initialScope: WriteScope = editing && editing.project_id === null ? 'global' : 'project';
  const [title, setTitle] = useState(editing?.title ?? '');
  const [detail, setDetail] = useState(editing?.detail ?? '');
  const [priority, setPriority] = useState<IdeaPriority>(editing?.priority ?? 'someday');
  const [scope, setScope] = useState<WriteScope>(initialScope);
  const [busy, setBusy] = useState(false);

  /** Edit mode sends only what changed; an unchanged form disables Save. */
  const editBody = useMemo(() => {
    if (!editing) return null;
    const body: Record<string, unknown> = { idea_id: editing.id };
    const t = title.trim();
    if (t && t !== editing.title) body.title = t;
    // Compare the raw pre-filled value first: existing details are allowed to
    // contain edge whitespace, and an untouched form must remain unchanged.
    if (detail !== (editing.detail ?? '')) body.detail = detail.trim(); // '' clears (stored NULL)
    if (priority !== editing.priority) body.priority = priority;
    if (scope !== initialScope) body.scope = scope;
    return body;
  }, [editing, title, detail, priority, scope, initialScope]);

  const hasChanges = editBody === null || Object.keys(editBody).length > 1;

  async function submit() {
    const t = title.trim();
    if (!t || busy || !hasChanges) return;
    setBusy(true);
    try {
      if (editing && editBody) {
        await apiPost('/ideas/update', editBody);
        toast.push('success', 'Idea updated.');
      } else {
        await apiPost('/ideas', { title: t, detail: detail.trim() || undefined, priority, scope });
        toast.push('success', 'Idea parked.');
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.push('error', err instanceof Error ? err.message : 'Could not save the idea');
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
          <h2 className="text-sm font-semibold text-ink">{editing ? 'Edit idea' : 'Park an idea'}</h2>
          <button type="button" aria-label="close" onClick={onClose} className="text-ink-faint hover:text-ink">
            ×
          </button>
        </div>
        <p className="mb-4 text-xs text-ink-faint">
          {editing
            ? 'Only what differs is saved. Board moves between this project and the global board.'
            : 'Lands in the Ideas column. Curation — planning, ordering, dropping — stays yours.'}
        </p>

        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
          }}
          maxLength={200}
          placeholder="One line — what's the idea?"
          className="mb-3 w-full rounded-lg border border-deep-700 bg-deep-950 px-3 py-2 text-sm text-ink outline-none focus:border-flow-400"
        />
        <textarea
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
          }}
          placeholder="Detail (optional) — ⌘/Ctrl+Enter to save"
          rows={3}
          className="mb-4 w-full resize-y rounded-lg border border-deep-700 bg-deep-950 p-3 text-sm text-ink outline-none focus:border-flow-400"
        />

        <div className="mb-3">
          <p className="mb-1.5 text-[0.66rem] uppercase tracking-wider text-ink-faint">priority</p>
          <div className="flex flex-wrap gap-1.5">
            {PRIORITIES.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPriority(p)}
                className={
                  'rounded-full border px-3 py-1 text-xs transition-colors ' +
                  (priority === p
                    ? 'border-flow-400 bg-deep-700 text-flow-300'
                    : 'border-deep-700 text-ink-dim hover:border-flow-400/50')
                }
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-1.5 text-[0.66rem] uppercase tracking-wider text-ink-faint">board</p>
          <div className="flex flex-wrap gap-1.5">
            {SCOPES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setScope(s)}
                className={
                  'rounded-full border px-3 py-1 text-xs transition-colors ' +
                  (scope === s
                    ? 'border-flow-400 bg-deep-700 text-flow-300'
                    : 'border-deep-700 text-ink-dim hover:border-flow-400/50')
                }
              >
                {s === 'global' ? `global ${marker}` : 'this project'}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-ink-dim hover:text-ink">
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !title.trim() || !hasChanges}
            className="rounded-md bg-gradient-to-br from-flow-400 to-flow-300 px-4 py-1.5 text-sm font-medium text-deep-950 transition-opacity disabled:opacity-40"
          >
            {editing ? (busy ? 'Saving…' : 'Save changes') : busy ? 'Parking…' : 'Park idea'}
          </button>
        </div>
      </div>
    </div>
  );
}
