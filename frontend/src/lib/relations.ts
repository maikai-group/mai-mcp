// Relation → edge line style (spec §3). Open vocabulary → fallback, mirroring
// the kinds.ts Record + fallback pattern.
export type LineStyle = 'solid' | 'dashed' | 'dotted';
export interface RelationStyle { color: string; lineStyle: LineStyle }
const R = (color: string, lineStyle: LineStyle): RelationStyle => ({ color, lineStyle });

const TEAL = '#2dd4bf';
const BLUE = '#60a5fa';
const AMBER = '#f59e0b';
const VIOLET = '#a78bfa';
const FAINT = '#64748b';

export const RELATION_STYLES: Record<string, RelationStyle> = {
  // call graph — solid teal
  calls: R(TEAL, 'solid'),
  invokes: R(TEAL, 'solid'),
  defines: R(TEAL, 'solid'),
  exports: R(TEAL, 'solid'),
  // structural containment / dependency — dashed blue
  imports: R(BLUE, 'dashed'),
  depends_on: R(BLUE, 'dashed'),
  contains: R(BLUE, 'dashed'),
  // data / env / temporal — dotted amber
  fk_to: R(AMBER, 'dotted'),
  reads_env: R(AMBER, 'dotted'),
  co_changed_with: R(AMBER, 'dotted'),
  // inheritance — solid violet
  inherits: R(VIOLET, 'solid'),
};
export const FALLBACK_RELATION: RelationStyle = R(FAINT, 'solid');
export const relationStyle = (relation: string): RelationStyle =>
  RELATION_STYLES[relation] ?? FALLBACK_RELATION;
