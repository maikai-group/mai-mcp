// Right-side node drawer (spec §5): name, kind chip, file:line, Impact/Trace
// (rendered via MarkdownPanel), expand-neighborhood, and copy-id. Trace runs
// between the previously-selected node and this one.
import { NodeLessons } from './NodeLessons';
import { useState } from 'react';
import { MarkdownPanel } from '../../components/MarkdownPanel';
import { PanelState } from '../../components/ViewHeader';
import { useMarkdown } from '../../lib/hooks';
import { kindStyle } from '../../lib/kinds';

export interface NodeDetail {
  id: string; name: string; kind: string;
  qualified_name: string | null; file_path: string | null; line: number | null;
  degree: number;
}

type Tab = 'none' | 'impact' | 'trace' | 'lessons';

function ImpactPanel({ id }: { id: string }) {
  const { markdown, loading, error } = useMarkdown('/graph/impact', { id });
  return (
    <>
      <PanelState loading={loading} error={error} empty={!loading && !error && !markdown} className="text-[var(--graph-text-dim)]" />
      {!loading && !error && markdown && <MarkdownPanel markdown={markdown} className="graph-prose" />}
    </>
  );
}

function TracePanel({ from, to }: { from: string; to: string }) {
  const { markdown, loading, error } = useMarkdown('/graph/trace', { from, to });
  return (
    <>
      <PanelState loading={loading} error={error} empty={!loading && !error && !markdown} className="text-[var(--graph-text-dim)]" />
      {!loading && !error && markdown && <MarkdownPanel markdown={markdown} className="graph-prose" />}
    </>
  );
}

export function Drawer({
  detail,
  traceFromId,
  isHeart,
  vesselCount,
  onExpand,
  onClose,
}: {
  detail: NodeDetail;
  traceFromId: string | null;
  isHeart: boolean;
  vesselCount: number;
  onExpand: (id: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('none');
  const [copied, setCopied] = useState<'none' | 'id' | 'path'>('none');
  const canTrace = traceFromId != null && traceFromId !== detail.id;
  const ks = kindStyle(detail.kind);

  function copy(what: 'id' | 'path', value: string) {
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(what);
      window.setTimeout(() => setCopied('none'), 1200);
    }).catch(() => { /* clipboard unavailable */ });
  }

  return (
    <aside
      data-graph-drawer="anatomy"
      className="absolute right-0 top-0 z-30 flex h-full w-96 flex-col border-l border-[var(--graph-border)] bg-[var(--graph-panel)] text-[var(--graph-text)] backdrop-blur min-[900px]:relative min-[900px]:z-20 min-[900px]:w-full"
    >
      <div className="flex items-start justify-between border-b border-[var(--graph-border)] px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: ks.color }} />
            <span className="rounded-full border border-[var(--graph-border)] px-2 py-0.5 text-[0.66rem] text-[var(--graph-text-dim)]">{ks.label}</span>
          </div>
          <h2 className="mt-2 break-words text-sm font-semibold text-[var(--graph-text)]">{detail.name}</h2>
          <p data-node-full-id className="mt-0.5 break-all font-mono text-[0.68rem] text-[var(--graph-text-dim)]">
            {detail.id}
          </p>
          {detail.qualified_name && <p className="mt-0.5 break-all font-mono text-[0.7rem] text-[var(--graph-text-dim)]">{detail.qualified_name}</p>}
          {detail.file_path && (
            <p data-node-full-path className="mt-1 break-all font-mono text-xs text-[var(--graph-accent)]">
              {detail.file_path}{detail.line ? `:${detail.line}` : ''}
            </p>
          )}
          <div
            className="mt-2 flex gap-2 text-[0.68rem] text-[var(--graph-text-dim)]"
            data-node-heart={isHeart ? '1' : '0'}
            data-node-vessels={vesselCount}
          >
            <span>{isHeart ? 'the heart' : 'not the heart'}</span>
            <span>·</span>
            <span>{vesselCount} direct vessels</span>
          </div>
        </div>
        <button type="button" aria-label="close" onClick={onClose} className="shrink-0 text-[var(--graph-text-dim)] hover:text-[var(--graph-text)]">×</button>
      </div>

      <div className="flex flex-wrap gap-2 border-b border-[var(--graph-border)] px-5 py-3">
        <button type="button" onClick={() => onExpand(detail.id)} className="rounded-md border border-[var(--graph-accent)] px-2.5 py-1 text-xs text-[var(--graph-accent)] hover:border-[var(--graph-accent)]">
          Expand
        </button>
        <button type="button" onClick={() => setTab(tab === 'impact' ? 'none' : 'impact')} className={'rounded-md border px-2.5 py-1 text-xs ' + (tab === 'impact' ? 'border-[var(--graph-accent)] text-[var(--graph-accent)]' : 'border-[var(--graph-border)] text-[var(--graph-text-dim)] hover:border-[var(--graph-accent)]')}>
          Impact
        </button>
        <button type="button" disabled={!canTrace} onClick={() => setTab(tab === 'trace' ? 'none' : 'trace')} className={'rounded-md border px-2.5 py-1 text-xs disabled:opacity-40 ' + (tab === 'trace' ? 'border-[var(--graph-accent)] text-[var(--graph-accent)]' : 'border-[var(--graph-border)] text-[var(--graph-text-dim)] hover:border-[var(--graph-accent)]')}>
          Trace
        </button>
        <button type="button" onClick={() => setTab(tab === 'lessons' ? 'none' : 'lessons')} className={'rounded-md border px-2.5 py-1 text-xs ' + (tab === 'lessons' ? 'border-[var(--graph-accent)] text-[var(--graph-accent)]' : 'border-[var(--graph-border)] text-[var(--graph-text-dim)]')}>Lessons</button>
        <button
          type="button"
          disabled={!detail.file_path}
          onClick={() => detail.file_path && copy('path', detail.file_path)}
          className="ml-auto rounded-md border border-[var(--graph-border)] px-2.5 py-1 font-mono text-xs text-[var(--graph-text-dim)] hover:border-[var(--graph-accent)] disabled:opacity-40"
        >
          {copied === 'path' ? 'copied' : 'path'}
        </button>
        <button
          type="button"
          onClick={() => copy('id', detail.id)}
          aria-label="copy full node id"
          className="rounded-md border border-[var(--graph-border)] px-2.5 py-1 font-mono text-xs text-[var(--graph-text-dim)] hover:border-[var(--graph-accent)]"
        >
          {copied === 'id' ? 'copied' : 'copy id'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {tab === 'none' && (
          <p className="text-xs text-[var(--graph-text-dim)]">
            Expand to grow the neighborhood, Impact for reverse-deps + recorded reasoning{canTrace ? ', or Trace from the previous node' : ' (select another node to enable Trace)'}.
          </p>
        )}
        {tab === 'lessons' && <NodeLessons nodeId={detail.id} />}
        {tab === 'impact' && <ImpactPanel id={detail.id} />}
        {tab === 'trace' && canTrace && traceFromId && <TracePanel from={traceFromId} to={detail.id} />}
      </div>
    </aside>
  );
}
