/**
 * The pure impact-risk classifier (plan 39, spec §5.2). Deterministic facts
 * only: the same evidence always yields the same risk, confidence and reason
 * order. It performs no I/O — `graphImpact` collects the evidence once and
 * hands it here.
 *
 * The deliberate asymmetry: a stale or unattributable graph can never report a
 * reassuring LOW. Uncertainty degrades to LIMITED confidence, and LIMITED is
 * itself a MEDIUM trigger.
 */
import { GRAPH_QUERY_EDGE_CAP } from './query-language.js';
import { isImpactBoundaryKind, isImpactBoundaryRelation } from './coverage.js';

export type ImpactRisk = 'LOW' | 'MEDIUM' | 'HIGH';
export type ImpactConfidence = 'SUFFICIENT' | 'LIMITED';

export const IMPACT_HIGH_DEPENDENTS = 20;
export const IMPACT_MEDIUM_DEPENDENTS = 5;
export const IMPACT_MEDIUM_RELATIONS = 2;

export interface ImpactEvidence {
  /** Dependent nodes reached (excluding the center). */
  dependentCount: number;
  /** Kinds of the center plus every returned dependent. */
  kinds: readonly string[];
  /** Distinct relations traversed. */
  relations: readonly string[];
  /** Confidence of every traversed edge (`extracted` | `inferred` | `behavioral`). */
  edgeConfidences: readonly string[];
  /** Configured repositories the affected nodes span. */
  repoCount: number;
  /** The traversal hit its examined-edge cap. */
  edgeCapHit: boolean;
  /** Still-valid linked decisions plus lessons. */
  validReasoningCount: number;
  /** A returned code node is stale or has no usable commit attribution. */
  staleReturnedNodes: boolean;
  /** A configured repository's HEAD could not be read, or a path never matched. */
  unresolvedFreshness: boolean;
  /** A returned node is a table/column/policy, so the schema layer participates. */
  schemaParticipates: boolean;
  /** The participating schema layer is stale or was never introspected. */
  schemaStale: boolean;
}

export interface ImpactAssessment {
  risk: ImpactRisk;
  confidence: ImpactConfidence;
  reasons: string[];
}

const distinct = (values: readonly string[]): string[] => [...new Set(values)];

export function classifyImpactRisk(evidence: ImpactEvidence): ImpactAssessment {
  const kinds = distinct(evidence.kinds);
  const relations = distinct(evidence.relations);
  const boundaryKinds = kinds.filter(isImpactBoundaryKind);
  const boundaryRelations = relations.filter(isImpactBoundaryRelation);
  const softEdges = distinct(evidence.edgeConfidences).filter((c) => c !== 'extracted');
  const schemaLimits = evidence.schemaParticipates && evidence.schemaStale;

  const confidence: ImpactConfidence =
    evidence.staleReturnedNodes || evidence.unresolvedFreshness || schemaLimits
      ? 'LIMITED'
      : 'SUFFICIENT';

  const high =
    evidence.edgeCapHit
    || boundaryKinds.length > 0
    || boundaryRelations.length > 0
    || evidence.repoCount > 1
    || evidence.dependentCount >= IMPACT_HIGH_DEPENDENTS;

  const medium =
    evidence.dependentCount >= IMPACT_MEDIUM_DEPENDENTS
    || relations.length >= IMPACT_MEDIUM_RELATIONS
    || evidence.validReasoningCount > 0
    || softEdges.length > 0
    || confidence === 'LIMITED';

  const risk: ImpactRisk = high ? 'HIGH' : medium ? 'MEDIUM' : 'LOW';

  // ONE stable order; every reason names the fact or threshold behind it.
  const reasons: string[] = [];
  if (evidence.edgeCapHit) reasons.push(`traversal capped at ${GRAPH_QUERY_EDGE_CAP} edges`);
  if (boundaryKinds.length > 0) reasons.push(`public boundary affected: ${boundaryKinds.join(', ')}`);
  if (boundaryRelations.length > 0) {
    reasons.push(`boundary relation traversed: ${boundaryRelations.join(', ')}`);
  }
  if (evidence.repoCount > 1) reasons.push(`spans ${evidence.repoCount} configured repositories`);
  if (evidence.dependentCount >= IMPACT_HIGH_DEPENDENTS) {
    reasons.push(`${evidence.dependentCount} dependents (>= ${IMPACT_HIGH_DEPENDENTS})`);
  } else if (evidence.dependentCount >= IMPACT_MEDIUM_DEPENDENTS) {
    reasons.push(`${evidence.dependentCount} dependents (>= ${IMPACT_MEDIUM_DEPENDENTS})`);
  }
  if (relations.length >= IMPACT_MEDIUM_RELATIONS) {
    reasons.push(`${relations.length} distinct dependency relations (>= ${IMPACT_MEDIUM_RELATIONS})`);
  }
  if (evidence.validReasoningCount > 0) {
    reasons.push(`${evidence.validReasoningCount} linked decisions/lessons`);
  }
  if (softEdges.length > 0) reasons.push(`non-extracted edge confidence: ${softEdges.join(', ')}`);
  if (evidence.staleReturnedNodes) reasons.push('a returned code node is stale or unattributed');
  if (evidence.unresolvedFreshness) reasons.push('repository HEAD could not be established');
  if (schemaLimits) reasons.push('participating DB schema is stale or never introspected');
  if (reasons.length === 0) reasons.push('no boundary, cap, reasoning or staleness signal');

  return { risk, confidence, reasons };
}
