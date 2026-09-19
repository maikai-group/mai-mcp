// A single review card (spec §6). Focus ring = flow-gradient border; selected =
// deep-700 fill. Chips: type / confidence / age. Keywords + mono short-id.
import { relativeTime, shortId } from '../../lib/format';
import type { ReviewRow } from '../../lib/types';

function Chip({ children, 'data-testid': testId }: { children: React.ReactNode; 'data-testid'?: string }) {
  return (
    <span data-testid={testId} className="rounded-full border border-deep-700 px-2 py-0.5 text-[0.68rem] text-ink-dim">
      {children}
    </span>
  );
}

export function Card({
  row,
  focused,
  selected,
  onClick,
}: {
  row: ReviewRow;
  focused: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <div
      data-testid="review-card"
      onClick={onClick}
      className={
        'relative cursor-pointer rounded-xl border p-4 transition-colors ' +
        (selected ? 'bg-deep-700/60 ' : 'bg-deep-900 ') +
        (focused ? 'border-transparent' : 'border-deep-800 hover:border-deep-700')
      }
    >
      {focused && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-xl"
          style={{ padding: '1.5px', background: 'linear-gradient(135deg, var(--color-flow-400), var(--color-flow-300))', WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)', WebkitMaskComposite: 'xor', maskComposite: 'exclude' }}
        />
      )}
      <div className="mb-2 flex items-start gap-2">
        {selected && <span aria-hidden className="mt-0.5 text-flow-300">✓</span>}
        <p className="flex-1 text-sm leading-snug text-ink">{row.description}</p>
        <span className="shrink-0 font-mono text-xs text-ink-faint">
          {row.kind === 'curation' ? shortId(row.curation.targetId) : shortId(row.id)}
        </span>
      </div>
      {row.kind !== 'curation' && row.reasoning && (
        <p className="mb-2.5 text-xs leading-relaxed text-ink-dim">{row.reasoning}</p>
      )}
      {/* The pre-existing reasoning paragraph is suppressed for curation rows:
          curationReasoning() builds the same telemetry / evidence / replacement
          this card renders structurally below, so leaving it on printed every
          curation body TWICE — and the telemetry twice in two different date
          formats (server fmtTs above, client relativeTime below). The JSON
          `reasoning` field is deliberately KEPT for non-dashboard consumers;
          only this render is guarded (pass-4 finding fb1682b5). */}
      {row.kind === 'curation' && row.curation.globalNote && (
        <p data-testid="global-consequence" className="mb-2.5 text-xs font-medium leading-relaxed text-deny">
          {row.curation.globalNote}
        </p>
      )}
      {row.kind === 'curation' && row.curation.replacementSummary && (
        <p data-testid="replacement" className="mb-2.5 text-xs leading-relaxed text-ink-dim">
          replaces with: {row.curation.replacementSummary}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {row.kind === 'fact' ? (
          <span
            data-testid="kind-chip"
            className="rounded-full border border-kind-schema/50 px-2 py-0.5 text-[0.68rem] text-kind-schema"
          >
            fact/{row.decision_type}
          </span>
        ) : row.kind === 'curation' ? (
          <>
            <span
              data-testid="kind-chip"
              className="rounded-full border border-flow-400/50 px-2 py-0.5 text-[0.68rem] text-flow-300"
            >
              curation/{row.curation.basis}
            </span>
            {row.curation.isGlobal && (
              <span
                data-testid="global-badge"
                className="rounded-full border border-deny px-2 py-0.5 text-[0.68rem] font-semibold text-deny"
              >
                GLOBAL
              </span>
            )}
            <Chip>{row.curation.targetKind}</Chip>
            {row.curation.basis === 'agent-evidence' ? (
              <Chip>proposed by {row.curation.proposedBy ?? 'an agent'}</Chip>
            ) : row.curation.basis === 'graduate' ? (
              <Chip data-testid="telemetry">relearned ×{row.curation.relearnedCount ?? 0}</Chip>
            ) : (
              <Chip data-testid="telemetry">
                surfaced ×{row.curation.surfacedCount} / cited ×{row.curation.citedCount} ·{' '}
                last surfaced{' '}
                {row.curation.lastSurfacedAt ? relativeTime(row.curation.lastSurfacedAt) : 'never'}
              </Chip>
            )}
          </>
        ) : (
          <Chip>{row.decision_type}</Chip>
        )}
        {row.kind !== 'curation' && <Chip>conf {row.confidence.toFixed(2)}</Chip>}
        {row.kind !== 'curation' && <Chip>{relativeTime(row.timestamp)}</Chip>}
        {row.keywords.slice(0, 5).map((k) => (
          <span key={k} className="font-mono text-[0.66rem] text-flow-300/80">
            #{k}
          </span>
        ))}
      </div>
      {row.kind === 'curation' && (
        // The labels come from the SERVER because approve/deny invert between
        // kinds (plan 22 §5.1). Nothing here derives the wording.
        <p data-testid="curation-actions" className="mt-2.5 text-[0.68rem] text-ink-faint">
          a = {row.curation.approveLabel} · d = {row.curation.denyLabel}
        </p>
      )}
    </div>
  );
}
