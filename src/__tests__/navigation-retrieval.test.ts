import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { searchCode } from '../graph/semantic/service.js';
import type { resolveNode } from '../graph/semantic/identity.js';
import type { buildDocument } from '../graph/semantic/document.js';
import type { unifiedSearchSections } from '../decisions.js';
import type { collectOrderedTraversal, assessReturnedGraphFreshness } from '../graph/query.js';
import type { StableNode, CodeSearch } from '../graph/semantic/types.js';
import type { TraversalResult } from '../graph/query.js';
import { headlineField } from '../read-budget.js';
const fake = vi.hoisted(() => ({
  searchCode: vi.fn<typeof searchCode>(), resolveNode: vi.fn<typeof resolveNode>(),
  buildDocument: vi.fn<typeof buildDocument>(), unifiedSearchSections: vi.fn<typeof unifiedSearchSections>(),
  collectOrderedTraversal: vi.fn<typeof collectOrderedTraversal>(),
  assessReturnedGraphFreshness: vi.fn<typeof assessReturnedGraphFreshness>(),
}));
vi.mock('../graph/semantic/service.js', () => ({ searchCode: fake.searchCode }));
vi.mock('../graph/semantic/identity.js', () => ({ resolveNode: fake.resolveNode }));
vi.mock('../graph/semantic/document.js', () => ({ buildDocument: fake.buildDocument }));
vi.mock('../decisions.js', () => ({ unifiedSearchSections: fake.unifiedSearchSections }));
vi.mock('../graph/query.js', () => ({ collectOrderedTraversal: fake.collectOrderedTraversal, assessReturnedGraphFreshness: fake.assessReturnedGraphFreshness }));
import { createPorts } from '../navigation/retrieval.js';
const projectId = '00000000-0000-4000-8000-000000000001';
const node: StableNode = { projectId, identity: 'a'.repeat(64), nodeId: '00000000-0000-4000-8000-000000000002',
  name: 'save', kind: 'function', qualifiedName: 'fixture.ts#save', extractedBy: 'typescript',
  physicalPath: '/fixtures/fixture.ts', line: 1, signature: null, language: 'typescript' };
const emptyCode: CodeSearch = { state: 'fallback', reasons: ['off'], model: null, nodes: [],
  coverage: { eligible: 1, current: 0, skipped: 1, capped: false, declaration: { eligible: 1, current: 0 }, metadata: { eligible: 0, current: 0 }, complete: false } };
const id = '11111111-1111-1111-1111-111111111111';
const staleLabel = '_Also matched by text — not yet re-embedded with the current model (`mai embed --rebuild`):_';
const longRule = 'Rule '.repeat(600);
function longLesson() {
  return { heading: `## Lessons\n# Lessons matching "${'q'.repeat(1000)}"`,
    fullRows: [`- \`${id}\` **${longRule}** (global)`],
    headlineRows: [`- \`${id}\` **${headlineField(longRule)}** (global)`] };
}
beforeEach(() => {
  vi.resetAllMocks();
  fake.resolveNode.mockResolvedValue(node);
  fake.searchCode.mockResolvedValue(emptyCode);
  fake.unifiedSearchSections.mockResolvedValue([]);
});
describe('scoped navigation adapters', () => {
  it('retains contradictory memory records and provenance', async () => {
    fake.unifiedSearchSections.mockResolvedValue([{ heading: '## Decisions', fullRows: [
      `- \`${id}\` [architecture] (sim 0.800, conf 1, user-approved)\n  Use A.\n  why: legacy contract.`,
      '- `22222222-2222-2222-2222-222222222222` (architecture, agent-inferred) Consider B.',
    ], headlineRows: ['Use A', 'Consider B'] }]);
    const result = await createPorts(projectId).memory('contract');
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence.map(e => e.ref).join(' ')).toContain('user-approved');
    expect(result.evidence.map(e => e.ref).join(' ')).toContain('agent-inferred');
    expect(fake.unifiedSearchSections).toHaveBeenCalledWith({ query: 'contract', limit: 3, projectId, includeShares: false });
  });
  it('keeps long global lesson scope outside the clipped body and query heading', async () => {
    fake.unifiedSearchSections.mockResolvedValue([longLesson()]);
    const result = await createPorts(projectId).memory('query');
    expect(result.evidence[0]?.ref).toBe(`lesson ${id} (global); source not supplied by search`);
    expect(result.evidence[0]?.text).toHaveLength(2400);
    expect(result.evidence[0]?.truncated).toBe(true);
    expect(result.evidence[0]?.ref).not.toContain('qqqq');
  });
  it('keeps standalone stale and verbose lessons with paired scope', async () => {
    fake.unifiedSearchSections.mockResolvedValue([{ heading: staleLabel,
      fullRows: [`- \`${id}\` **Rule** — strong 0.9, reinforced ×3`],
      headlineRows: [`- \`${id}\` **Rule**`] }]);
    const result = await createPorts(projectId).memory('q');
    expect(result.evidence[0]?.ref).toContain('(project)');
    expect(result.evidence[0]?.freshness).toContain('not re-embedded');
    expect(result.evidence[0]?.text).toContain('reinforced');
  });
  it('keeps stale/trigram decision provenance', async () => {
    const row = `- \`${id}\` (architecture, agent-inferred) Earlier rationale`;
    fake.unifiedSearchSections.mockResolvedValue([{ heading: `## Decisions\n${staleLabel}`, fullRows: [row], headlineRows: [row] }]);
    const result = await createPorts(projectId).memory('q');
    expect(result.evidence[0]?.ref).toContain('agent-inferred');
    expect(result.evidence[0]?.freshness).toContain('not re-embedded');
  });
  it.each([512, 513])('bounds the complete document reference at %s characters', async length => {
    const ref = `document ${'p'.repeat(length - 'document '.length - ':1-2'.length)}:1-2`;
    const row = `- ${ref.slice(9)} · heading · text match (not re-embedded — mai embed --rebuild)`;
    fake.unifiedSearchSections.mockResolvedValue([{ heading: '## Plan/spec docs (pointers)', fullRows: [row], headlineRows: [row] }]);
    const result = await createPorts(projectId).memory('q');
    if (length === 512) expect(result.evidence[0]?.ref).toBe(ref);
    else { expect(result.evidence).toEqual([]); expect(result.gaps.join(' ')).toContain('unsupported'); }
  });
  it('preserves document spaces and stale provenance, omitting malformed rows', async () => {
    const row = '- docs/a plan.md:12-34 · section · text match (not re-embedded — mai embed --rebuild)';
    fake.unifiedSearchSections.mockResolvedValue([{ heading: '## Plan/spec docs (pointers)', fullRows: [row, 'unknown'], headlineRows: [row, 'unknown'] }]);
    const result = await createPorts(projectId).memory('q');
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.ref).toBe('document docs/a plan.md:12-34');
    expect(result.evidence[0]?.freshness).toContain('not re-embedded');
    expect(result.gaps.join(' ')).toContain('unsupported');
  });
  it('does not read a rejected node', async () => {
    fake.resolveNode.mockResolvedValue(null);
    expect((await createPorts(projectId).source(node.nodeId)).evidence).toEqual([]);
    expect(fake.buildDocument).not.toHaveBeenCalled();
  });
  it('marks missing source as a gap and metadata-only documents explicitly', async () => {
    fake.buildDocument.mockResolvedValue(null);
    expect((await createPorts(projectId).source(node.nodeId)).gaps.join(' ')).toContain('changed');
    fake.buildDocument.mockResolvedValue({ node, version: 'code-symbol/1', mode: 'metadata', sourceHash: null, fingerprint: 'f', text: 'metadata', truncated: false });
    const result = await createPorts(projectId).source(node.nodeId);
    expect(result.evidence[0]?.freshness).toBe('metadata only');
    expect(result.gaps.join(' ')).toContain('unavailable');
  });
  it('preserves source text/hash and lexical fallback coverage', async () => {
    fake.buildDocument.mockResolvedValue({ node, version: 'code-symbol/1', mode: 'declaration', sourceHash: 'a'.repeat(64), fingerprint: 'f', text: 'exact source', truncated: true });
    expect((await createPorts(projectId).source(node.nodeId)).evidence[0]).toMatchObject({ text: 'exact source', hash: 'a'.repeat(64), truncated: true });
    fake.searchCode.mockResolvedValue({ ...emptyCode, nodes: [{ id: node.nodeId, identity: node.identity, name: node.name, kind: node.kind, qualified_name: node.qualifiedName, file_path: node.physicalPath, line: 1, method: 'lexical', document_mode: 'metadata', score: 0.5, excerpt: 'indexed excerpt', freshness: { state: 'unverified', source_hash: null, document_fingerprint: null, document_version: null, indexed_at: null, verified_at: null } }] });
    const result = await createPorts(projectId).code('save');
    expect(result.gaps.join(' ')).toContain('fallback');
    expect(result.gaps.join(' ')).toContain('"complete":false');
    expect(result.evidence[0]?.freshness).toContain('lexical; unverified');
    expect(fake.resolveNode).toHaveBeenCalledWith(projectId, node.nodeId);
  });
  it('keeps inferred edge confidence and traversal caps without per-node freshness promotion', async () => {
    const traversal: TraversalResult = { nodes: [{ id: node.nodeId, name: node.name, kind: node.kind, qualified_name: node.qualifiedName, file_path: node.physicalPath, line: 1, commit_sha: null, content_hash: null, extracted_by: 'typescript', hop: 0 }],
      edges: [{ id: 'edge', from_node: node.nodeId, to_node: node.nodeId, relation: 'calls', confidence: 'inferred', hop: 1 }], examinedEdges: 1, fetchedRows: 2, edgeCapHit: true, resultCapHit: true };
    fake.collectOrderedTraversal.mockResolvedValue(traversal);
    fake.assessReturnedGraphFreshness.mockResolvedValue({ stale: true, unresolved: false, schemaParticipates: false, schemaStale: false, line: 'one stale node' });
    const result = await createPorts(projectId).expand(node.nodeId);
    expect(result.evidence.find(e => e.kind === 'edge')?.text).toContain('confidence=inferred');
    expect(result.evidence[0]?.freshness).toContain('returned-set assessment');
    expect(result.gaps.join(' ')).toContain('capped');
    expect(fake.collectOrderedTraversal).toHaveBeenCalledWith(projectId, [node.nodeId], [{ direction: 'both', relations: [], targetKinds: [] }], 12);
  });
});

import { runNavigation } from '../navigation/service.js';
import { normalizeInput } from '../navigation/input.js';
import { renderNavigation } from '../navigation/render.js';
import type { Evaluate } from '../navigation/types.js';
const config = { key: 'test-only', model: 'jev-1.13.0' };
const stop: Evaluate = async (_input, evidence) => ({ model: config.model, choice: 'stop', confidence: 1, scores: Object.fromEntries(evidence.map(item => [item.id, 0.5])), inputTokens: 1, outputTokens: 0, attempts: 1 });
it('actual no-match decision/lesson rows do not cause inference; one real decision survives', async () => {
  const emptyDecision = { heading: '## Decisions', fullRows: ['No decisions match "question".'], headlineRows: ['No decisions match "question".'] };
  const emptyLesson = { heading: '## Lessons', fullRows: ['No lessons match query: "question"'], headlineRows: ['No lessons match query: "question"'] };
  fake.unifiedSearchSections.mockResolvedValue([emptyDecision, emptyLesson]);
  const assess = vi.fn<Evaluate>().mockImplementation(stop);
  const input = normalizeInput({ question: 'question', intent: 'layout' });
  const deps = { ports: createPorts(projectId), evaluate: assess, now: Date.now };
  const result = await runNavigation(input, config, deps, new AbortController().signal);
  expect(result.status).toBe('insufficient_context'); expect(result.evidence).toEqual([]); expect(assess).not.toHaveBeenCalled();
  const row = `- \`${id}\` (architecture, user-approved) Actual decision`;
  fake.unifiedSearchSections.mockResolvedValue([{ ...emptyDecision, fullRows: [row], headlineRows: [row] }, emptyLesson]);
  const hit = await runNavigation(input, config, deps, new AbortController().signal);
  expect(hit.evidence).toHaveLength(1); expect(hit.evidence[0]?.ref).toContain(id);
  expect(hit.gaps.join(' ')).toContain('no attributable'); expect(assess).toHaveBeenCalledOnce();
});
it('real long lesson identity/scope survives state and whole-block rendering', async () => {
  fake.unifiedSearchSections.mockResolvedValue([longLesson()]);
  const result = await runNavigation(normalizeInput({ question: 'question', intent: 'decisions' }), config,
    { ports: createPorts(projectId), evaluate: stop, now: Date.now }, new AbortController().signal);
  const text = renderNavigation(result, { fullRows: 3, charBudget: 5488 });
  expect(text).toContain(`lesson ${id} (global); source not supplied by search`);
  expect(text).toContain('partial');
  const tiny = renderNavigation(result, { fullRows: 3, charBudget: 300 });
  expect(tiny).toContain('0/1'); expect(tiny).toContain('omitted: 1'); expect(tiny).not.toContain(id);
});
it.each([512, 513])('document ref %s survives or is omitted atomically through state/render', async length => {
  const ref = `document ${'p'.repeat(length - 13)}:1-2`;
  const row = `- ${ref.slice(9)} · heading`;
  fake.unifiedSearchSections.mockResolvedValue([{ heading: '## Plan/spec docs (pointers)', fullRows: [row], headlineRows: [row] }]);
  const result = await runNavigation(normalizeInput({ question: 'question', intent: 'decisions' }), config,
    { ports: createPorts(projectId), evaluate: stop, now: Date.now }, new AbortController().signal);
  if (length === 512) {
    expect(result.evidence[0]?.ref).toBe(ref);
    expect(renderNavigation(result, { fullRows: 3, charBudget: 5488 })).toContain(ref);
  } else { expect(result.evidence).toEqual([]); expect(result.gaps.join(' ')).toContain('unsupported'); }
});
