// Pure mappers: server JSON → cytoscape elements (spec §5). Kept React/cytoscape-
// runtime-free so they unit-test cleanly (type-only cytoscape import).
import type { ElementDefinition } from 'cytoscape';
import type { GraphOverview, GraphNeighborsJson, GraphFull } from '../../lib/types';

export function edgeId(source: string, target: string, relation: string): string {
  return `${source}__${relation}__${target}`;
}

/** One old-server compatibility seam (R7/W1). Both renderers receive the same
 * finite positive value; neither invents its own missing-field fallback. */
export function normalizeStrength(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
}

/** Landing constellation: top-degree nodes per module + inter-top edges. */
export function overviewToElements(o: GraphOverview): ElementDefinition[] {
  const nodes: ElementDefinition[] = o.topNodes.map((n) => ({
    group: 'nodes',
    data: {
      id: n.id, label: n.name, kind: n.kind, module: n.module, degree: n.degree,
      qualified_name: n.qualified_name, file_path: n.file_path, line: n.line,
      lastTouched: n.lastTouched, confidence: n.confidence, isLanding: 1,
    },
  }));
  const edges: ElementDefinition[] = o.topEdges.map((e) => ({
    group: 'edges',
    data: {
      id: edgeId(e.source, e.target, e.relation),
      source: e.source, target: e.target, relation: e.relation,
      strength: normalizeStrength(e.strength),
    },
  }));
  return [...nodes, ...edges];
}

/**
 * The whole graph for hero mode. A sibling of overviewToElements, deliberately:
 * both produce the same ElementDefinition shape, so LandscapeProps.elements is
 * unchanged and the landscape cannot tell which payload it is drawing.
 *
 * `module` is absent from the hero payload — it is a summary concept — so it is
 * omitted here rather than filled with a placeholder.
 */
export function fullToElements(f: GraphFull): ElementDefinition[] {
  const nodes: ElementDefinition[] = f.nodes.map((n) => ({
    group: 'nodes',
    data: {
      id: n.id, label: n.name, kind: n.kind, degree: n.degree,
      qualified_name: n.qualified_name, file_path: n.file_path, line: n.line,
      lastTouched: n.lastTouched, confidence: n.confidence,
      isLanding: n.isLanding,
    },
  }));
  const edges: ElementDefinition[] = f.edges.map((e) => ({
    group: 'edges',
    data: {
      id: edgeId(e.source, e.target, e.relation),
      source: e.source, target: e.target, relation: e.relation,
      strength: normalizeStrength(e.strength),
    },
  }));
  return [...nodes, ...edges];
}

/** A neighborhood expansion around one node. */
export function neighborsToElements(n: GraphNeighborsJson): ElementDefinition[] {
  const nodes: ElementDefinition[] = n.nodes.map((nd) => ({
    group: 'nodes',
    data: {
      id: nd.id, label: nd.name, kind: nd.kind,
      qualified_name: nd.qualified_name, file_path: nd.file_path, line: nd.line,
      degree: nd.degree,
      lastTouched: nd.lastTouched, confidence: nd.confidence, isLanding: 0,
      center: nd.id === n.center ? 1 : 0,
    },
  }));
  const edges: ElementDefinition[] = n.edges.map((e) => ({
    group: 'edges',
    data: {
      id: edgeId(e.source, e.target, e.relation),
      source: e.source, target: e.target, relation: e.relation,
      strength: normalizeStrength(e.strength),
    },
  }));
  return [...nodes, ...edges];
}

/**
 * Merge incoming elements into existing, deduped by id. Existing wins (its
 * position/state is preserved on click-expand). Edges whose endpoints are absent
 * from the merged node set are dropped so cytoscape never errors.
 */
export function mergeElements(existing: ElementDefinition[], incoming: ElementDefinition[]): ElementDefinition[] {
  const byId = new Map<string, ElementDefinition>();
  const add = (el: ElementDefinition, overwrite: boolean) => {
    const id = el.data?.id;
    if (id == null) return;
    const key = String(id);
    if (overwrite || !byId.has(key)) byId.set(key, el);
  };
  for (const el of existing) add(el, true);
  for (const el of incoming) add(el, false);

  const all = [...byId.values()];
  const nodeIds = new Set(all.filter((e) => e.data?.source == null).map((e) => String(e.data?.id)));
  return all.filter((e) => {
    const src = e.data?.source;
    const tgt = e.data?.target;
    if (src == null) return true; // node
    return nodeIds.has(String(src)) && nodeIds.has(String(tgt));
  });
}
