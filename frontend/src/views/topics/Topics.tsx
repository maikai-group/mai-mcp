import { ViewHeader, PanelState } from '../../components/ViewHeader';
import { MarkdownPanel } from '../../components/MarkdownPanel';
import { useMarkdown } from '../../lib/hooks';

// Topics are per-pinned-slug on the server; mermaid fences render as code blocks
// in v2 (the graph canvas is the diagram surface now), which MarkdownPanel does
// naturally — ```mermaid becomes a styled <pre><code>.
export function Topics() {
  const { markdown, loading, error } = useMarkdown('/topics');
  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <ViewHeader title="Topics" subtitle="curated context for the server's pinned project" />
      <div className="rounded-xl border border-deep-800 bg-deep-900 px-5 py-4">
        <PanelState loading={loading} error={error} empty={!loading && !error && !markdown} />
        {!loading && !error && markdown && <MarkdownPanel markdown={markdown} />}
      </div>
    </div>
  );
}
