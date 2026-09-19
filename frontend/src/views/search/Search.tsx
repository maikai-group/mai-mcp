// Search: unified decisions+lessons search, with the old Similar / Recall /
// Edges tabs folded into lazy expanders below the results.
import { useState } from 'react';
import { ViewHeader, PanelState } from '../../components/ViewHeader';
import { MarkdownPanel } from '../../components/MarkdownPanel';
import { Expander } from '../../components/Expander';
import { useMarkdown } from '../../lib/hooks';

function LazyMarkdown({ path, params }: { path: string; params?: Record<string, string | number | undefined> }) {
  const { markdown, loading, error } = useMarkdown(path, params);
  return (
    <>
      <PanelState loading={loading} error={error} empty={!loading && !error && !markdown} />
      {!loading && !error && markdown && <MarkdownPanel markdown={markdown} />}
    </>
  );
}

function EdgesExpander() {
  const [kind, setKind] = useState('decision');
  const [id, setId] = useState('');
  const [submitted, setSubmitted] = useState<{ kind: string; id: string } | null>(null);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="rounded-md border border-deep-700 bg-deep-950 px-2 py-1 text-sm text-ink outline-none focus:border-flow-400"
        >
          <option value="decision">decision</option>
          <option value="lesson">lesson</option>
          <option value="commit">commit</option>
          <option value="graph_node">graph_node</option>
        </select>
        <input
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="id (uuid / hash)"
          className="min-w-0 flex-1 rounded-md border border-deep-700 bg-deep-950 px-2 py-1 font-mono text-sm text-ink outline-none focus:border-flow-400"
        />
        <button
          type="button"
          onClick={() => id.trim() && setSubmitted({ kind, id: id.trim() })}
          className="rounded-md border border-deep-700 px-3 py-1 text-sm text-ink-dim hover:border-flow-400/60 hover:text-ink"
        >
          load
        </button>
      </div>
      {submitted && <LazyMarkdown path="/edges" params={{ kind: submitted.kind, id: submitted.id }} />}
    </div>
  );
}

export function Search() {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [submitted, setSubmitted] = useState('');
  const results = useMarkdown('/search', { q: submitted, kind: kind || undefined }, submitted.length > 0);

  function run() {
    if (q.trim()) setSubmitted(q.trim());
  }

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <ViewHeader title="Search" subtitle="decisions + lessons across this project's memory" />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') run(); }}
          placeholder="search the brain…"
          className="min-w-0 flex-1 rounded-lg border border-deep-700 bg-deep-950 px-3.5 py-2 text-sm text-ink outline-none focus:border-flow-400"
        />
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="rounded-lg border border-deep-700 bg-deep-950 px-2.5 py-2 text-sm text-ink outline-none focus:border-flow-400"
        >
          <option value="">all</option>
          <option value="decisions">decisions</option>
          <option value="lessons">lessons</option>
        </select>
        <button
          type="button"
          onClick={run}
          className="rounded-lg bg-gradient-to-br from-flow-400 to-flow-300 px-4 py-2 text-sm font-medium text-deep-950"
        >
          Search
        </button>
      </div>

      {submitted && (
        <div className="mb-5 rounded-xl border border-deep-800 bg-deep-900 px-5 py-4">
          <PanelState loading={results.loading} error={results.error} empty={!results.loading && !results.error && !results.markdown} />
          {!results.loading && !results.error && results.markdown && <MarkdownPanel markdown={results.markdown} />}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {submitted && (
          <Expander label="Similar decisions (semantic)">
            <LazyMarkdown path="/similar" params={{ q: submitted }} />
          </Expander>
        )}
        <Expander label="Project recall">
          <LazyMarkdown path="/recall" />
        </Expander>
        <Expander label="Edges — connections for an id">
          <EdgesExpander />
        </Expander>
      </div>
    </div>
  );
}
