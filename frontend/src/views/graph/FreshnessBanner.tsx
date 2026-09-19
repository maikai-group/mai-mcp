// Two-axis freshness strip (spec §3.6 / R10). Every sentence arrives already
// rendered from the server so it is prime's wording verbatim; this component
// chooses only a colour. Never compose freshness text here.
import type { FreshnessBannerPayload, FreshnessLine } from '../../lib/types';

const TONE_CLASS: Record<FreshnessLine['tone'], string> = {
  ok: 'text-[var(--graph-text-dim)]',
  warn: 'text-deny',
  info: 'text-[var(--graph-text-dim)]',
};

export function FreshnessBanner({ freshness }: { freshness: FreshnessBannerPayload | null }) {
  if (freshness === null) return null;
  return (
    <div
      className="absolute left-4 top-28 z-20 max-w-[52%] rounded-md border border-[var(--graph-border)] bg-[var(--graph-panel)] px-3 py-1.5 text-[0.68rem] leading-snug backdrop-blur"
      data-freshness-code={freshness.code.tone}
      data-freshness-db={freshness.db.tone}
    >
      <p className={TONE_CLASS[freshness.code.tone]}>{freshness.code.text}</p>
      <p className={TONE_CLASS[freshness.db.tone]}>{freshness.db.text}</p>
    </div>
  );
}
