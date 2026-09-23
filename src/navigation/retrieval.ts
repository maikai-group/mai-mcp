import { createHash } from 'node:crypto';
import { unifiedSearchSections } from '../decisions.js';
import { searchCode } from '../graph/semantic/service.js';
import { resolveNode } from '../graph/semantic/identity.js';
import { buildDocument } from '../graph/semantic/document.js';
import { collectOrderedTraversal, assessReturnedGraphFreshness } from '../graph/query.js';
import type { Batch, Evidence, Ports } from './types.js';

export function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
// Recognize only identity envelopes emitted by the existing section producers.
// Keep provenance as literal text; do not reconstruct decision/lesson facts.
const uuidText = '[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}';
const decisionEnvelope = new RegExp('^- `(' + uuidText + ')` (?:\\[[^\\]\\n]{1,100}\\] )?\\([^\\n)]{1,220}\\)');
const lessonEnvelope = new RegExp('^- `(' + uuidText + ')` \\*\\*');
function memoryReference(heading: string, row: string, headline: string): string | null {
  const text = row.trimStart();
  const decision = decisionEnvelope.exec(text);
  if (decision) return `decision ${decision[0].slice(2)}`;
  const lesson = lessonEnvelope.exec(text);
  if (lesson) {
    // headlineField bounds only rule text; UUID and terminal scope remain intact.
    // Both verbose and ordinary lesson rows share this same headline envelope.
    const compact = headline.trimStart();
    if (!compact.startsWith(lesson[0]) || !/\*\*(?: \(global\))?$/.test(compact)) return null;
    return `lesson ${lesson[1]}${compact.endsWith('** (global)') ? ' (global)' : ' (project)'}; source not supplied by search`;
  }
  if (heading.trimStart().startsWith('## Plan/spec docs (pointers')) {
    const pointer = /^- (.+?:\d+-\d+) · /.exec(text);
    if (pointer && `document ${pointer[1]}`.length <= 512) return `document ${pointer[1]}`;
  }
  return null;
}
function missing(): Batch { return { evidence: [], gaps: ['Node unavailable in the pinned project or allowed roots.'] }; }
export function createPorts(projectId: string): Ports {
  return {
    async memory(query) {
      const sections = await unifiedSearchSections({ query, limit: 3, projectId, includeShares: false });
      const evidence: Evidence[] = [];
      const gaps = ['Memory search is limited; absent rationale or conflicts require direct recall.'];
      const staleLabel = '_Also matched by text — not yet re-embedded with the current model (`mai embed --rebuild`):_';
      for (const section of sections) {
        if (section.fullRows.length !== section.headlineRows.length) {
          gaps.push('Memory section has inconsistent identity rows; omitted.'); continue;
        }
        for (const [index, row] of section.fullRows.entries()) {
          const headline = section.headlineRows[index];
          if (headline === undefined) continue;
          const ref = memoryReference(section.heading, row, headline);
          if (!ref) {
            gaps.push('Memory lane returned no attributable record or an unsupported row; inspect ordinary search.');
            continue;
          }
          const stale = section.heading.trimEnd().endsWith(staleLabel)
            || (ref.startsWith('document ') && row.endsWith(' · text match (not re-embedded — mai embed --rebuild)'));
          const raw = `${ref}\n${row}`;
          evidence.push({ id: `m_${digest(raw)}`, kind: 'memory', ref,
            text: row.slice(0, 2400), hash: digest(raw),
            freshness: `recorded memory; rationale may be an excerpt${stale ? '; text match, not re-embedded' : ''}`,
            truncated: row.length > 2400 });
        }
      }
      return { evidence, gaps };
    },
    async seed(nodeId) {
      const node = await resolveNode(projectId, nodeId);
      if (!node) return missing();
      return { evidence: [{ id: `n_${node.nodeId}`, kind: 'node', nodeId: node.nodeId,
        nodeName: node.name, ref: `${node.physicalPath ?? node.qualifiedName}:${node.line ?? '?'}`,
        text: `${node.kind} ${node.qualifiedName}\n${node.signature ?? ''}`,
        hash: null, freshness: 'scoped graph metadata; source not read', truncated: false }], gaps: [] };
    },
    async source(nodeId) {
      const node = await resolveNode(projectId, nodeId);
      if (!node) return missing();
      const doc = await buildDocument(node);
      if (!doc) return { evidence: [], gaps: ['Source missing, excluded, ambiguous, or changed since extraction.'] };
      return { evidence: [{ id: `s_${nodeId}`, kind: 'source', nodeId, nodeName: node.name,
        ref: `${node.physicalPath ?? node.qualifiedName}:${node.line ?? '?'}`,
        text: doc.text, hash: doc.sourceHash,
        freshness: doc.mode === 'declaration' ? 'hash-verified declaration' : 'metadata only',
        truncated: doc.truncated }], gaps: doc.mode === 'metadata' ? ['Source declaration unavailable.'] : [] };
    },
    async code(query) {
      const result = await searchCode(projectId, { query, limit: 12 });
      const evidence: Evidence[] = [];
      const gaps = [`Code search ${result.state}; coverage ${JSON.stringify(result.coverage)}; reasons ${result.reasons.join(',') || 'none'}.`];
      for (const hit of result.nodes) {
        const scoped = await resolveNode(projectId, hit.id);
        if (!scoped) { gaps.push('A search hit failed scoped identity validation.'); continue; }
        evidence.push({ id: `n_${hit.id}`, kind: 'node', nodeId: hit.id, nodeName: hit.name,
          ref: `${hit.file_path ?? hit.qualified_name}:${hit.line ?? '?'}`,
          text: `${hit.kind} ${hit.qualified_name}\n${hit.excerpt ?? ''}`,
          freshness: `${hit.method}; ${hit.freshness.state}`,
          hash: hit.freshness.source_hash, truncated: false });
      }
      return { evidence, gaps };
    },
    async expand(nodeId) {
      if (!await resolveNode(projectId, nodeId)) return missing();
      const result = await collectOrderedTraversal(projectId, [nodeId],
        [{ direction: 'both', relations: [], targetKinds: [] }], 12);
      const freshness = await assessReturnedGraphFreshness(projectId, result.nodes);
      const allowed = new Set<string>();
      const evidence: Evidence[] = [];
      const gaps = [freshness.line];
      for (const node of result.nodes) {
        if (!await resolveNode(projectId, node.id)) { gaps.push('A traversal node failed scoped identity validation.'); continue; }
        allowed.add(node.id);
        evidence.push({ id: `n_${node.id}`, kind: 'node', nodeId: node.id, nodeName: node.name,
          ref: `${node.file_path ?? node.qualified_name ?? node.name}:${node.line ?? '?'}`,
          text: `${node.kind} ${node.qualified_name ?? node.name}; extraction ${node.extracted_by ?? 'unknown'}; commit ${node.commit_sha ?? 'unknown'}`,
          hash: node.content_hash, freshness: `returned-set assessment: ${freshness.line}`, truncated: false });
      }
      for (const edge of result.edges) if (allowed.has(edge.from_node) && allowed.has(edge.to_node)) {
        evidence.push({ id: `e_${edge.id}`, kind: 'edge', ref: edge.id,
          text: `${edge.from_node} --${edge.relation}--> ${edge.to_node}; confidence=${edge.confidence}; hop=${edge.hop}`,
          hash: null, freshness: 'extracted graph edge; inspect source to confirm behavior', truncated: false });
      }
      if (result.edgeCapHit || result.resultCapHit) gaps.push('Graph expansion capped; additional nodes or edges may exist.');
      return { evidence, gaps };
    },
  };
}
