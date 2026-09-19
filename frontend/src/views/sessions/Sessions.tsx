import { useState } from 'react';
import { ViewHeader, PanelState } from '../../components/ViewHeader';
import { MarkdownPanel } from '../../components/MarkdownPanel';
import { useMarkdown } from '../../lib/hooks';

export function Sessions() {
  const [limit, setLimit] = useState(10);
  const { markdown, loading, error } = useMarkdown('/sessions', { limit });

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <ViewHeader title="Sessions" subtitle="recent work sessions against this project">
        <label className="flex items-center gap-1.5 text-xs text-ink-faint">
          limit
          <input
            type="number"
            min={1}
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value) || 10)}
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
