import { useState } from 'react';
import { ViewHeader, PanelState } from '../../components/ViewHeader';
import { MarkdownPanel } from '../../components/MarkdownPanel';
import { useMarkdown } from '../../lib/hooks';

export function Timeline() {
  const [days, setDays] = useState(30);
  const [limit, setLimit] = useState(40);
  const { markdown, loading, error } = useMarkdown('/timeline', { days, limit });

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <ViewHeader title="Timeline" subtitle="sessions, decisions, and commits in chronological flow">
        <label className="flex items-center gap-1.5 text-xs text-ink-faint">
          days
          <input
            type="number"
            min={1}
            value={days}
            onChange={(e) => setDays(Number(e.target.value) || 30)}
            className="w-16 rounded-md border border-deep-700 bg-deep-950 px-2 py-1 font-mono text-sm text-ink outline-none focus:border-flow-400"
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-ink-faint">
          limit
          <input
            type="number"
            min={1}
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value) || 40)}
            className="w-16 rounded-md border border-deep-700 bg-deep-950 px-2 py-1 font-mono text-sm text-ink outline-none focus:border-flow-400"
          />
        </label>
      </ViewHeader>
      <div className="rounded-xl border border-deep-800 bg-deep-900 px-5 py-4">
        <PanelState loading={loading} error={error} empty={!loading && !error && !markdown} />
        {!loading && !error && markdown && <MarkdownPanel markdown={markdown} />}
      </div>
    </div>
  );
}
