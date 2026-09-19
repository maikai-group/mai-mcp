/**
 * Plan 39 Task 3: conservative dead-code candidates. Every exclusion gets an
 * exact fixture, every partial extractor×kind pair gets both a candidate and a
 * positive incoming-use control, and invalid or foreign evidence must neither
 * suppress a candidate nor leak across the project boundary.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';
import { DEAD_CODE_COVERAGE, DEAD_CODE_ROOT_KINDS } from '../graph/coverage.js';

const TEST_DB = requireDisposableTestDbUrl();
process.env.MAI_PROJECT_SLUG = 'wave2-dead';
process.env.MAI_DB_URL = TEST_DB;
const admin = new Pool({ connectionString: TEST_DB });

let projectId = '';
let foreignId = '';
const ids = new Map<string, string>();
const id = (key: string): string => {
  const value = ids.get(key);
  if (value === undefined) throw new Error(`fixture ${key} missing`);
  return value;
};

async function node(project: string, key: string, args: {
  kind: string; extractor: string; file?: string | null; line?: number | null;
}): Promise<string> {
  const row = await admin.query<{ id: string }>(
    `INSERT INTO graph_nodes (project_id, kind, name, qualified_name, file_path, line,
       extracted_by, extracted_at, commit_sha)
     VALUES ($1,$2,$3,$3,$4,$5,$6, now(),'deadhead') RETURNING id`,
    [project, args.kind, key,
     args.file === undefined ? `/repo/dead/${key}.src` : args.file,
     args.line === undefined ? 10 : args.line, args.extractor],
  );
  ids.set(key, row.rows[0].id);
  return row.rows[0].id;
}

async function edge(project: string, from: string, to: string, relation: string): Promise<void> {
  await admin.query(
    `INSERT INTO graph_edges (project_id, from_node, to_node, relation, confidence)
     VALUES ($1,$2,$3,$4,'extracted') ON CONFLICT DO NOTHING`,
    [project, id(from), id(to), relation]);
}

async function linkDecision(project: string, nodeKey: string, args: {
  stillValid?: boolean; retracted?: boolean; owner?: string;
}): Promise<void> {
  const owner = args.owner ?? project;
  const decision = await admin.query<{ id: string }>(
    `INSERT INTO code_decisions (project_id, decision_type, description, source, still_valid,
       retracted_at, timestamp)
     VALUES ($1,'architecture',$2,'user-approved',$3,$4, now()) RETURNING id`,
    [owner, `reasoning for ${nodeKey}`, args.stillValid ?? true,
     args.retracted === true ? new Date().toISOString() : null]);
  await admin.query(
    `INSERT INTO memory_edges (project_id, from_kind, from_id, to_kind, to_id, relation)
     VALUES ($1,'decision',$2,'graph_node',$3,'implemented_by') ON CONFLICT DO NOTHING`,
    [owner, decision.rows[0].id, id(nodeKey)]);
}

async function linkLesson(project: string, nodeKey: string, args: {
  global?: boolean; superseded?: boolean; retired?: boolean; owner?: string;
}): Promise<void> {
  const owner = args.owner ?? project;
  const lesson = await admin.query<{ id: string }>(
    `INSERT INTO lessons (project_id, rule, confidence_score, reinforcement_count, tags, retired_at)
     VALUES ($1,$2,0.9,1,'{}',$3) RETURNING id`,
    [args.global === true ? null : owner, `lesson for ${nodeKey}`,
     args.retired === true ? new Date().toISOString() : null]);
  if (args.superseded === true) {
    const replacement = await admin.query<{ id: string }>(
      `INSERT INTO lessons (project_id, rule, confidence_score, reinforcement_count, tags)
       VALUES ($1,$2,0.9,1,'{}') RETURNING id`,
      [args.global === true ? null : owner, `replacement for ${nodeKey}`]);
    await admin.query(`UPDATE lessons SET superseded_by = $2 WHERE id = $1`,
      [lesson.rows[0].id, replacement.rows[0].id]);
  }
  await admin.query(
    `INSERT INTO memory_edges (project_id, from_kind, from_id, to_kind, to_id, relation)
     VALUES ($1,'lesson',$2,'graph_node',$3,'implemented_by') ON CONFLICT DO NOTHING`,
    [owner, lesson.rows[0].id, id(nodeKey)]);
}

/** Root-kind fixtures: one per root kind, each through a root-role relation. */
const ROOT_CASES = [
  { kind: 'endpoint', relation: 'serves_route' },
  { kind: 'hook', relation: 'listens_to' },
  { kind: 'scheduled_job', relation: 'scheduled_by' },
  { kind: 'mcp_server', relation: 'serves_route' },
  { kind: 'shortcode', relation: 'fires' },
  { kind: 'capability', relation: 'secured_by' },
  { kind: 'event_channel', relation: 'listens_on' },
] as const;

beforeAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug IN ('wave2-dead','wave2-dead-foreign')`);
  projectId = (await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name, path, metadata) VALUES ('wave2-dead','Wave2 Dead',$1,
       jsonb_build_object('repos', jsonb_build_array($1::text))) RETURNING id`, [process.cwd()])).rows[0].id;
  foreignId = (await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name, path, metadata) VALUES ('wave2-dead-foreign','Foreign',$1,
       jsonb_build_object('repos', jsonb_build_array($1::text))) RETURNING id`, [process.cwd()])).rows[0].id;

  // Every partial pair: one candidate plus one positive incoming-use control.
  for (const pair of Object.keys(DEAD_CODE_COVERAGE)) {
    const [extractor, kind] = pair.split(':');
    await node(projectId, `cand_${extractor}_${kind}`, { kind, extractor });
    await node(projectId, `used_${extractor}_${kind}`, { kind, extractor });
    await node(projectId, `caller_${extractor}_${kind}`, { kind: 'function', extractor });
    await edge(projectId, `caller_${extractor}_${kind}`, `used_${extractor}_${kind}`,
      kind === 'class' ? 'inherits' : 'calls');
  }

  // Semantic use exclusions that are easy to get wrong.
  for (const relation of ['inherits', 'depends_on']) {
    await node(projectId, `use_${relation}`, { kind: 'function', extractor: 'php' });
    await node(projectId, `user_${relation}`, { kind: 'function', extractor: 'php' });
    await edge(projectId, `user_${relation}`, `use_${relation}`, relation);
  }

  // Export in either direction.
  await node(projectId, 'exported_out', { kind: 'function', extractor: 'php' });
  await node(projectId, 'export_holder', { kind: 'function', extractor: 'php' });
  await edge(projectId, 'exported_out', 'export_holder', 'exports');
  await node(projectId, 'exported_in', { kind: 'function', extractor: 'php' });
  await edge(projectId, 'export_holder', 'exported_in', 'exports');

  // One root fixture per root kind.
  for (const root of ROOT_CASES) {
    await node(projectId, `rooted_${root.kind}`, { kind: 'function', extractor: 'php' });
    await node(projectId, `root_${root.kind}`, { kind: root.kind, extractor: 'php' });
    await edge(projectId, `root_${root.kind}`, `rooted_${root.kind}`, root.relation);
  }

  // Reasoning: valid suppresses; invalid must not.
  await node(projectId, 'has_decision', { kind: 'function', extractor: 'php' });
  await linkDecision(projectId, 'has_decision', {});
  await node(projectId, 'has_lesson', { kind: 'function', extractor: 'php' });
  await linkLesson(projectId, 'has_lesson', {});
  await node(projectId, 'has_global_lesson', { kind: 'function', extractor: 'php' });
  await linkLesson(projectId, 'has_global_lesson', { global: true });
  await node(projectId, 'has_retracted_decision', { kind: 'function', extractor: 'php' });
  await linkDecision(projectId, 'has_retracted_decision', { retracted: true });
  await node(projectId, 'has_invalid_decision', { kind: 'function', extractor: 'php' });
  await linkDecision(projectId, 'has_invalid_decision', { stillValid: false });
  await node(projectId, 'has_superseded_lesson', { kind: 'function', extractor: 'php' });
  await linkLesson(projectId, 'has_superseded_lesson', { superseded: true });
  await node(projectId, 'has_retired_lesson', { kind: 'function', extractor: 'php' });
  await linkLesson(projectId, 'has_retired_lesson', { retired: true });
  await node(projectId, 'has_foreign_decision', { kind: 'function', extractor: 'php' });
  await linkDecision(projectId, 'has_foreign_decision', { owner: foreignId });

  // Never candidates at all.
  await node(projectId, 'unsupported_extractor', { kind: 'function', extractor: 'ts' });
  await node(projectId, 'unsupported_kind', { kind: 'component', extractor: 'php' });
  await node(projectId, 'wrong_kind', { kind: 'file', extractor: 'php' });
  await node(projectId, 'no_location', { kind: 'function', extractor: 'php', file: null, line: null });
  await node(projectId, 'other_path', { kind: 'function', extractor: 'php', file: '/repo/other/x.php' });
});

afterAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug IN ('wave2-dead','wave2-dead-foreign')`);
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
});

const scan = async (input: unknown = {}): Promise<string> => {
  const { graphDeadCode } = await import('../graph/query.js');
  return graphDeadCode(input, projectId);
};

describe('dead-code candidates', () => {
  it('reports a candidate for every partial pair and excludes its used sibling', async () => {
    const out = await scan({ limit: 50 });
    for (const pair of Object.keys(DEAD_CODE_COVERAGE)) {
      const [extractor, kind] = pair.split(':');
      expect(out).toContain(`cand_${extractor}_${kind}`);
      expect(out).not.toContain(`used_${extractor}_${kind}`);
    }
  });

  it('treats incoming inherits and depends_on as use', async () => {
    const out = await scan({ limit: 50 });
    expect(out).not.toContain('use_inherits');
    expect(out).not.toContain('use_depends_on');
  });

  it('excludes exports in either direction and every root kind', async () => {
    const out = await scan({ limit: 50 });
    expect(out).not.toContain('exported_out');
    expect(out).not.toContain('exported_in');
    for (const root of ROOT_CASES) expect(out).not.toContain(`rooted_${root.kind}`);
    expect(DEAD_CODE_ROOT_KINDS.length).toBe(ROOT_CASES.length);
  });

  it('excludes valid reasoning only — invalid and foreign reasoning never suppress', async () => {
    const out = await scan({ limit: 50 });
    expect(out).not.toContain('has_decision');
    expect(out).not.toContain('has_lesson');
    expect(out).not.toContain('has_global_lesson');   // a valid GLOBAL lesson counts
    expect(out).toContain('has_retracted_decision');
    expect(out).toContain('has_invalid_decision');
    expect(out).toContain('has_superseded_lesson');
    expect(out).toContain('has_retired_lesson');
    expect(out).toContain('has_foreign_decision');    // another project's evidence is not ours
  });

  it('never considers unsupported coverage, wrong kinds or unlocated nodes', async () => {
    const out = await scan({ limit: 50 });
    for (const key of ['unsupported_extractor', 'unsupported_kind', 'wrong_kind', 'no_location']) {
      expect(out).not.toContain(key);
    }
    const unsupportedOnly = await scan({ kinds: ['component'], limit: 50 });
    expect(unsupportedOnly).toContain('No supported extractor coverage');
    expect(unsupportedOnly).toContain('not evidence');
  });

  it('honours kind, path and limit filters in a deterministic order', async () => {
    const classesOnly = await scan({ kinds: ['class'], limit: 50 });
    expect(classesOnly).toContain('cand_php_class');
    expect(classesOnly).not.toContain('cand_php_function');
    const scoped = await scan({ path_prefix: '/repo/other', limit: 50 });
    expect(scoped).toContain('other_path');
    expect(scoped).not.toContain('cand_php_function');
    const limited = await scan({ limit: 2 });
    const rows = limited.split('\n').filter((line) => line.startsWith('- ['));
    expect(rows).toHaveLength(2);
    const again = await scan({ limit: 2 });
    expect(again).toBe(limited);
  });

  it('labels every launch candidate `limited` and never claims safety', async () => {
    const out = await scan({ limit: 50 });
    expect(out).toContain('# Dead-code candidates');
    expect(out).toContain('· limited · ');
    expect(out).not.toContain('· strong · ');
    expect(out).not.toContain('safe to delete');
    expect(out).toContain('verify source/runtime behavior');
    expect(out).toContain('checked incoming use relations: imports, calls');
    expect(out).toContain('_Returned-node freshness:');
  });

  it('reads evidence in bounded set queries — no per-row growth', async () => {
    const { getPool } = await import('../db.js');
    const pool = getPool();
    const spyOne = vi.spyOn(pool, 'query');
    await scan({ limit: 1 });
    const one = spyOne.mock.calls.length;
    spyOne.mockRestore();
    const spyMany = vi.spyOn(pool, 'query');
    await scan({ limit: 50 });
    const many = spyMany.mock.calls.length;
    spyMany.mockRestore();
    expect(many).toBe(one);           // identical query count for 1 and 50 rows
  });

  it('separates an unsupported analysis from a supported scan with no candidates', async () => {
    const { graphDeadCode } = await import('../graph/query.js');
    const empty = (await admin.query<{ id: string }>(
      `INSERT INTO projects (slug, name, path, metadata) VALUES ('wave2-dead-empty','Empty',$1,
         jsonb_build_object('repos', jsonb_build_array($1::text))) RETURNING id`, [process.cwd()])).rows[0].id;
    try {
      const out = await graphDeadCode({ limit: 10 }, empty);
      expect(out).toContain('No candidates: every node with supported coverage');
      expect(out).not.toContain('No supported extractor coverage');
    } finally {
      await admin.query(`DELETE FROM projects WHERE slug = 'wave2-dead-empty'`);
    }
  });

  it('rejects malformed input before touching the database', async () => {
    const { getPool } = await import('../db.js');
    const spy = vi.spyOn(getPool(), 'query');
    const out = await scan({ kinds: ['endpoint'] });
    const calls = spy.mock.calls.length;
    spy.mockRestore();
    expect(out).toContain('Invalid dead-code request');
    expect(calls).toBe(0);
  });
});
