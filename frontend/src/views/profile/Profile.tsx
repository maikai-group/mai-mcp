// Profile: the global user-facts layer — who you are, how you work. Facts are
// proposed by agents into the Review queue and prime into EVERY project once
// approved, so this view shows the approved set and the retract path only;
// approval itself lives in Review.
import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost } from '../../lib/api';
import { useToast } from '../../shell/toast';
import { ViewHeader } from '../../components/ViewHeader';
import { DenyModal } from '../review/DenyModal';
import type { FactCategory, FactRow, ReviewRow } from '../../lib/types';
import type { Destination as Dest } from '../../shell/destinations';

const CATEGORY_ORDER: FactCategory[] = ['identity', 'preference', 'workflow', 'tooling'];
const CATEGORY_TONE: Record<FactCategory, string> = {
  identity: 'text-kind-class',
  preference: 'text-flow-300',
  workflow: 'text-kind-file',
  tooling: 'text-kind-schema',
};

export function Profile({ onNavigate }: { onNavigate?: (d: Dest) => void }) {
  const toast = useToast();
  const [facts, setFacts] = useState<FactRow[]>([]);
  const [candidates, setCandidates] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [retracting, setRetracting] = useState<FactRow | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    apiGet<{ rows: FactRow[] }>('/facts')
      .then((r) => setFacts(r.rows.filter((f) => f.source === 'user-approved')))
      .catch(() => setFacts([]))
      .finally(() => setLoading(false));
    apiGet<{ rows: ReviewRow[] }>('/review', { format: 'json', limit: 100 })
      .then((r) => setCandidates(r.rows.filter((x) => x.kind === 'fact').length))
      .catch(() => setCandidates(null));
  }, []);

  useEffect(() => { load(); }, [load]);

  const retract = useCallback(
    async (fact: FactRow, reason: string) => {
      try {
        await apiPost('/retract', { decision_id: fact.id, kind: 'fact', reason });
        setFacts((fs) => fs.filter((f) => f.id !== fact.id));
        toast.push('info', 'Fact retracted.', {
          label: 'Undo',
          run: () => {
            apiPost('/unretract', { decision_id: fact.id, kind: 'fact' })
              .then(load)
              .catch(() => toast.push('error', 'Undo failed'));
          },
        });
      } catch (err) {
        toast.push('error', err instanceof Error ? err.message : 'Retract failed');
      }
    },
    [toast, load]
  );

  const grouped = CATEGORY_ORDER.map((c) => ({ category: c, rows: facts.filter((f) => f.category === c) })).filter(
    (g) => g.rows.length > 0
  );

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <ViewHeader title="Profile" subtitle="durable facts about you — approved once, applied in every project">
        {candidates != null && candidates > 0 && (
          <button
            type="button"
            onClick={() => onNavigate?.('review')}
            className="rounded-md border border-flow-400/40 px-3 py-1 text-xs text-flow-300 transition-colors hover:border-flow-400"
          >
            {candidates} candidate{candidates === 1 ? '' : 's'} awaiting review →
          </button>
        )}
      </ViewHeader>

      {loading ? (
        <div className="text-sm text-ink-faint">loading…</div>
      ) : grouped.length === 0 ? (
        <div className="rounded-xl border border-deep-800 bg-deep-900 px-6 py-16 text-center">
          <div aria-hidden className="mb-2 text-2xl">🌊</div>
          <p className="text-sm text-ink-dim">
            no approved facts yet — agents propose them as they learn how you work.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-7">
          {grouped.map((g) => (
            <section key={g.category}>
              <h2
                className={
                  'mb-2.5 text-xs font-semibold uppercase tracking-[0.14em] ' + CATEGORY_TONE[g.category]
                }
              >
                {g.category}
              </h2>
              <div className="flex flex-col gap-2">
                {g.rows.map((f) => (
                  <article
                    key={f.id}
                    data-testid="fact-row"
                    className="group rounded-xl border border-deep-800 bg-deep-900 p-4 transition-colors hover:border-deep-700"
                  >
                    <div className="flex items-start gap-3">
                      <p className="flex-1 text-sm leading-snug text-ink">{f.fact}</p>
                      <button
                        type="button"
                        onClick={() => setRetracting(f)}
                        className="shrink-0 rounded-md border border-deny/30 px-2 py-0.5 text-[0.66rem] text-deny opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                      >
                        retract
                      </button>
                    </div>
                    {f.detail && <p className="mt-1.5 text-xs leading-relaxed text-ink-dim">{f.detail}</p>}
                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-deep-700 px-2 py-0.5 text-[0.66rem] text-ink-dim">
                        {f.source}
                      </span>
                      <span className="font-mono text-[0.66rem] text-ink-faint">{f.evidence}</span>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {retracting && (
        <DenyModal
          count={1}
          noun="fact"
          onCancel={() => setRetracting(null)}
          onConfirm={(reason) => {
            const target = retracting;
            setRetracting(null);
            void retract(target, reason);
          }}
        />
      )}
    </div>
  );
}
