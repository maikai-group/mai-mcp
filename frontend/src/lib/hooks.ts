// Shared data hook for the markdown surfaces. Fetches { markdown } from a JSON
// endpoint, re-running when the path/params/project change and `enabled` is set.
import { useEffect, useState } from 'react';
import { apiGet } from './api';
import { useProjects } from '../shell/project';

export interface MarkdownState { markdown: string; loading: boolean; error: string | null }

export function useMarkdown(
  path: string,
  params?: Record<string, string | number | undefined>,
  enabled = true,
): MarkdownState {
  const { project } = useProjects();
  const [state, setState] = useState<MarkdownState>({ markdown: '', loading: enabled, error: null });
  // Stable dependency key for the params object.
  const key = JSON.stringify(params ?? {});

  useEffect(() => {
    if (!enabled || !project) {
      setState({ markdown: '', loading: false, error: null });
      return;
    }
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    apiGet<{ markdown: string }>(path, params)
      .then((r) => { if (live) setState({ markdown: r.markdown, loading: false, error: null }); })
      .catch((e: unknown) => {
        if (live) setState({ markdown: '', loading: false, error: e instanceof Error ? e.message : 'failed' });
      });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, key, project, enabled]);

  return state;
}
