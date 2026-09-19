// Home: at-a-glance state for the selected project — activity counts, the
// recent-writes feed, a review call-to-action, graph staleness, and the daily
// report. Counts are derived from the activity feed (session/decision/commit —
// the kinds the JSON feed carries).
import { useEffect, useState } from 'react';
import { apiGet } from '../../lib/api';
import { useProjects } from '../../shell/project';
import { MarkdownPanel } from '../../components/MarkdownPanel';
import { relativeTime, shortId } from '../../lib/format';
import type { ActivityRow } from '../../lib/types';
import type { Destination as Dest } from '../../shell/destinations';

const KIND_ICON: Record<ActivityRow['kind'], string> = {
  session: '◇',
  decision: '◈',
  commit: '⎇',
};
const KIND_COLOR: Record<ActivityRow['kind'], string> = {
  session: 'text-kind-file',
  decision: 'text-flow-300',
  commit: 'text-kind-class',
};

function Chip({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-deep-800 bg-deep-900 px-4 py-3">
      <div className="font-mono text-2xl text-ink">{value}</div>
      <div className="mt-0.5 text-xs uppercase tracking-wide text-ink-faint">{label}</div>
    </div>
  );
}

export function Home({ onNavigate, reviewCount }: { onNavigate: (d: Dest) => void; reviewCount: number | null }) {
  const { project } = useProjects();
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [report, setReport] = useState<string>('');
  const [stale, setStale] = useState<string>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!project) return;
    let live = true;
    setLoading(true);
    Promise.all([
      apiGet<{ rows: ActivityRow[] }>('/activity', { days: 14, limit: 40 }).then((r) => r.rows).catch(() => []),
      apiGet<{ markdown: string }>('/report', { days: 7 }).then((r) => r.markdown).catch(() => ''),
      apiGet<{ markdown: string }>('/graph/stale').then((r) => r.markdown).catch(() => ''),
    ]).then(([a, rep, st]) => {
      if (!live) return;
      setActivity(a);
      setReport(rep);
      setStale(st);
      setLoading(false);
    });
    return () => { live = false; };
  }, [project]);

  const counts = activity.reduce(
    (acc, r) => { acc[r.kind]++; return acc; },
    { session: 0, decision: 0, commit: 0 } as Record<ActivityRow['kind'], number>
  );

  if (!project) {
    return <div className="flex h-full items-center justify-center text-ink-faint">Select a project to begin.</div>;
  }

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <header className="mb-6">
        <h1 className="text-xl font-semibold text-ink">{project}</h1>
        <p className="mt-1 text-sm text-ink-faint">the riverbed — what this project's flow has left behind</p>
      </header>

      <div className="mb-6 grid grid-cols-3 gap-3">
        <Chip label="decisions · 14d" value={counts.decision} />
        <Chip label="sessions · 14d" value={counts.session} />
        <Chip label="commits · 14d" value={counts.commit} />
      </div>

      {reviewCount != null && reviewCount > 0 && (
        <button
          type="button"
          onClick={() => onNavigate('review')}
          className="mb-6 flex w-full items-center justify-between rounded-xl border border-flow-400/30 bg-flow-400/[0.06] px-5 py-4 text-left transition-colors hover:border-flow-400/60"
        >
          <div>
            <div className="text-sm font-medium text-ink">
              {reviewCount} {reviewCount === 1 ? 'decision needs' : 'decisions need'} review
            </div>
            <div className="mt-0.5 text-xs text-ink-dim">Agent-inferred + low-confidence entries awaiting triage.</div>
          </div>
          <span className="font-mono text-sm text-flow-300">triage →</span>
        </button>
      )}

      <section className="mb-8">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-faint">Recent activity</h2>
        {loading ? (
          <div className="text-sm text-ink-faint">loading…</div>
        ) : activity.length === 0 ? (
          <div className="rounded-xl border border-deep-800 bg-deep-900 px-5 py-6 text-sm text-ink-faint">
            No activity in the last 14 days.
          </div>
        ) : (
          <ul className="overflow-hidden rounded-xl border border-deep-800 bg-deep-900">
            {activity.map((r, i) => (
              <li
                key={`${r.kind}-${r.id}-${i}`}
                className="flex items-start gap-3 border-b border-deep-800/60 px-4 py-2.5 last:border-b-0"
              >
                <span aria-hidden className={'mt-0.5 shrink-0 ' + KIND_COLOR[r.kind]}>{KIND_ICON[r.kind]}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink-dim">{r.detail ?? r.kind}</span>
                {r.id && <span className="shrink-0 font-mono text-xs text-ink-faint">{shortId(r.id)}</span>}
                <span className="shrink-0 text-xs text-ink-faint">{relativeTime(r.ts)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {stale && (
        <section className="mb-8">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-faint">Graph staleness</h2>
          <div className="rounded-xl border border-deep-800 bg-deep-900 px-5 py-4">
            <MarkdownPanel markdown={stale} />
          </div>
        </section>
      )}

      {report && (
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-faint">Daily report · 7d</h2>
          <div className="rounded-xl border border-deep-800 bg-deep-900 px-5 py-4">
            <MarkdownPanel markdown={report} />
          </div>
        </section>
      )}
    </div>
  );
}
