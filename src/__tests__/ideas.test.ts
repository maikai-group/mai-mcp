/** Ideas/roadmap board (plan 11 Task 1): add ordering, scope, the agent
 * transition whitelist, operator moves, markdown grouping. Fixture pattern from
 * web-json-api.test.ts (own slug, delete+insert the project around the run).
 * GLOBAL rows (project_id IS NULL) are shared with real data — they are seeded
 * with the TITLE MARKER below and deleted by it, never blanket-deleted. */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { requireDisposableTestDbUrl } from './test-db-url.js';

process.env.MAI_PROJECT_SLUG = 'ideas-test';
const testDbUrl = requireDisposableTestDbUrl();
process.env.MAI_TEST_DB_URL = testDbUrl;
process.env.MAI_DB_URL = testDbUrl;

const admin = new Pool({ connectionString: process.env.MAI_DB_URL });

const GLOBAL_MARKER = 'ideas-test-global';

let projectId = '';
let otherProjectId = '';
let scenarioCounter = 0;

async function createScenarioProject(label: string): Promise<string> {
  scenarioCounter += 1;
  const slug = `ideas-test-${label}-${scenarioCounter}`;
  const result = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name) VALUES ($1, $2) RETURNING id`,
    [slug, `Ideas ${label} ${scenarioCounter}`],
  );
  return result.rows[0].id;
}

async function within<T>(promise: Promise<T>, milliseconds = 5000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`operation exceeded ${milliseconds}ms deadline`)), milliseconds);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

beforeAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug IN ('ideas-test', 'ideas-test-other')`);
  await admin.query(`DELETE FROM ideas WHERE project_id IS NULL AND title LIKE $1`, [`${GLOBAL_MARKER}%`]);
  const p = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name) VALUES ('ideas-test', 'Ideas Test') RETURNING id`
  );
  projectId = p.rows[0].id;
  const other = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name) VALUES ('ideas-test-other', 'Ideas Test Other') RETURNING id`
  );
  otherProjectId = other.rows[0].id;
});

afterAll(async () => {
  await admin.query(`DELETE FROM ideas WHERE project_id IS NULL AND title LIKE $1`, [`${GLOBAL_MARKER}%`]);
  await admin.query(`DELETE FROM projects WHERE slug IN ('ideas-test', 'ideas-test-other')`);
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
});

describe('ideaAdd', () => {
  it('appends inside the exact project/status/priority band', async () => {
    const { ideaAdd } = await import('../ideas.js');
    const first = await ideaAdd({ title: 'first parked idea' });
    expect(first.status).toBe('idea');
    expect(first.priority).toBe('someday');
    expect(first.source).toBe('agent-inferred');
    expect(first.project_id).toBe(projectId);
    expect(first.sort_order).toBe(1000);

    const second = await ideaAdd({ title: 'second parked idea', priority: 'next' });
    expect(second.sort_order).toBe(1000);
    expect(second.priority).toBe('next');
  });

  it("scope 'global' stores a NULL project_id", async () => {
    const { ideaAdd } = await import('../ideas.js');
    const row = await ideaAdd({ title: `${GLOBAL_MARKER} fleet idea`, scope: 'global' });
    expect(row.project_id).toBeNull();
  });

  it('rejects a missing title and a title over 200 chars', async () => {
    const { ideaAdd } = await import('../ideas.js');
    await expect(ideaAdd({ title: '   ' })).rejects.toThrow(/title is required/);
    await expect(ideaAdd({ title: 'x'.repeat(201) })).rejects.toThrow(/exceeds 200 chars/);
    const invalid = { title: 'invalid priority', priority: 'later' } satisfies Parameters<typeof ideaAdd>[0];
    Object.defineProperty(invalid, 'priority', { value: 'urgent' });
    await expect(ideaAdd(invalid)).rejects.toThrow(/invalid priority/);
  });
});

describe('ideasBoard', () => {
  it("scope 'both' returns project + global rows and excludes shipped by default", async () => {
    const { ideasBoard } = await import('../ideas.js');
    await admin.query(
      `INSERT INTO ideas (project_id, title, status, priority, sort_order, source)
       VALUES ($1, 'already shipped', 'shipped', 'now', 1000, 'user')`,
      [projectId]
    );

    const both = await ideasBoard();
    expect(both.some((r) => r.project_id === projectId)).toBe(true);
    expect(both.some((r) => r.project_id === null && r.title.startsWith(GLOBAL_MARKER))).toBe(true);
    expect(both.some((r) => r.title === 'already shipped')).toBe(false);

    const withClosed = await ideasBoard({ includeClosed: true });
    expect(withClosed.some((r) => r.title === 'already shipped')).toBe(true);

    const projectOnly = await ideasBoard({ scope: 'project' });
    expect(projectOnly.every((r) => r.project_id === projectId)).toBe(true);

    const globalOnly = await ideasBoard({ scope: 'global' });
    expect(globalOnly.every((r) => r.project_id === null)).toBe(true);
  });

  it('orders explicit priority bands, project before global, then ties by creation and id', async () => {
    const { ideasBoard, ideasBoardMarkdown } = await import('../ideas.js');
    const prefix = 'p42-canonical';
    const seeded = await admin.query<{ id: string; title: string }>(
      `INSERT INTO ideas (project_id, title, status, priority, sort_order, source, created_at)
       VALUES
         ($1, $2, 'idea', 'someday', 100, 'user', '2026-08-27T10:00:00Z'),
         ($1, $3, 'idea', 'now', 9000, 'user', '2026-08-27T10:00:00Z'),
         ($1, $4, 'idea', 'later', 10, 'user', '2026-08-27T10:00:00Z'),
         ($1, $5, 'idea', 'next', 500, 'user', '2026-08-27T10:00:00Z'),
         ($1, $6, 'idea', 'next', 500, 'user', '2026-08-27T10:00:00Z'),
         (NULL, $7, 'idea', 'now', -100, 'user', '2026-08-27T09:00:00Z')
       RETURNING id, title`,
      [
        projectId,
        `${prefix}-someday`, `${prefix}-now`, `${prefix}-later`,
        `${prefix}-next-a`, `${prefix}-next-b`, `${GLOBAL_MARKER}-${prefix}-global-now`,
      ],
    );
    const ids = new Map(seeded.rows.map((row) => [row.title, row.id]));
    const tiedNext = [`${prefix}-next-a`, `${prefix}-next-b`]
      .sort((a, b) => (ids.get(a) ?? '').localeCompare(ids.get(b) ?? ''));
    const titles = (await ideasBoard({ scope: 'both' }))
      .map((row) => row.title)
      .filter((title) => title.includes(prefix));
    expect(titles).toEqual([
      `${prefix}-now`,
      `${GLOBAL_MARKER}-${prefix}-global-now`,
      ...tiedNext,
      `${prefix}-later`,
      `${prefix}-someday`,
    ]);

    const markdown = await ideasBoardMarkdown('both');
    const positions = titles.map((title) => markdown.indexOf(title));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe('ideaAgentMove', () => {
  it('moves planned→building, prepends to the column (min − 1000) and appends evidence', async () => {
    const { ideaAgentMove } = await import('../ideas.js');
    await admin.query(
      `INSERT INTO ideas (project_id, title, status, priority, sort_order, source)
       VALUES ($1, 'existing build', 'building', 'now', 5000, 'user')`,
      [projectId]
    );
    const untouched = await admin.query<{ id: string; sort_order: number; updated_at: Date }>(
      `INSERT INTO ideas (project_id, title, status, priority, sort_order, source, updated_at)
       VALUES ($1, 'other priority build', 'building', 'later', 77, 'user', '2026-08-27T08:00:00Z')
       RETURNING id, sort_order, updated_at`,
      [projectId],
    );
    const seeded = await admin.query<{ id: string; title: string }>(
      `INSERT INTO ideas (project_id, title, status, priority, sort_order, source, evidence)
       VALUES ($1, 'planned item', 'planned', 'now', 3000, 'user', 'parked by hand') RETURNING id`,
      [projectId]
    );

    const moved = await ideaAgentMove({
      ideaId: seeded.rows[0].id,
      to: 'building',
      evidence: 'plan 11 task 1 started',
    });
    expect(moved.status).toBe('building');
    expect(moved.sort_order).toBe(4000);
    expect(moved.evidence).toBe('parked by hand\nplan 11 task 1 started');
    expect(moved.source).toBe('user'); // provenance never overwritten
    const untouchedAfter = await admin.query<{ sort_order: number; updated_at: Date }>(
      `SELECT sort_order, updated_at FROM ideas WHERE id = $1`,
      [untouched.rows[0].id],
    );
    expect(Number(untouchedAfter.rows[0].sort_order)).toBe(Number(untouched.rows[0].sort_order));
    expect(untouchedAfter.rows[0].updated_at.toISOString()).toBe(untouched.rows[0].updated_at.toISOString());
  });

  it("rejects a move out of 'idea' (curation is the operator's)", async () => {
    const { ideaAdd, ideaAgentMove } = await import('../ideas.js');
    const parked = await ideaAdd({ title: 'not yet planned' });
    await expect(
      ideaAgentMove({ ideaId: parked.id, to: 'building', evidence: 'trying to skip curation' })
    ).rejects.toThrow(/move rejected/);
  });

  it('rejects a move without evidence, and a non-UUID id', async () => {
    const { ideaAdd, ideaAgentMove } = await import('../ideas.js');
    const parked = await ideaAdd({ title: 'evidence check' });
    await expect(ideaAgentMove({ ideaId: parked.id, to: 'building', evidence: '  ' })).rejects.toThrow(
      /evidence is required/
    );
    await expect(ideaAgentMove({ ideaId: 'nope', to: 'shipped', evidence: 'x' })).rejects.toThrow(
      /must be a UUID/
    );
  });
});

describe('ideaOperatorMove', () => {
  it('sets status, priority and sort_order; rejects an empty change', async () => {
    const { ideaAdd, ideaOperatorMove } = await import('../ideas.js');
    const parked = await ideaAdd({ title: 'operator curated' });

    const moved = await ideaOperatorMove({
      ideaId: parked.id,
      status: 'planned',
      priority: 'now',
      sortOrder: 1500,
    });
    expect(moved.status).toBe('planned');
    expect(moved.priority).toBe('now');
    expect(moved.sort_order).toBe(1500);

    await expect(ideaOperatorMove({ ideaId: parked.id })).rejects.toThrow(/nothing to change/);
  });

  it('keeps rank for same status/priority and prepends only when the band changes', async () => {
    const { ideaAdd, ideaOperatorMove } = await import('../ideas.js');
    const anchor = await ideaAdd({ title: 'operator move next anchor', priority: 'next' });
    const row = await ideaAdd({ title: 'operator move source' });
    const noOpBand = await ideaOperatorMove({
      ideaId: row.id,
      status: row.status,
      priority: row.priority,
    });
    expect(noOpBand.sort_order).toBe(row.sort_order);
    const moved = await ideaOperatorMove({ ideaId: row.id, priority: 'next' });
    expect(moved.sort_order).toBeLessThan(anchor.sort_order);
  });

  it('leaves every other priority band rank and timestamp byte-stable', async () => {
    const { ideaOperatorMove } = await import('../ideas.js');
    const isolatedProject = await createScenarioProject('untouched-bands');
    const seeded = await admin.query<{ id: string; title: string; sort_order: number; updated_at: Date }>(
      `INSERT INTO ideas (project_id, title, status, priority, sort_order, source, updated_at)
       VALUES
         ($1, 'move-source-now', 'planned', 'now', 2000, 'user', '2026-08-27T07:00:00Z'),
         ($1, 'untouched-now', 'planned', 'now', 3000, 'user', '2026-08-27T07:00:00Z'),
         ($1, 'target-next', 'planned', 'next', 1000, 'user', '2026-08-27T07:00:00Z'),
         ($1, 'untouched-later', 'planned', 'later', 17, 'user', '2026-08-27T07:00:00Z'),
         ($1, 'untouched-someday', 'planned', 'someday', 29, 'user', '2026-08-27T07:00:00Z')
       RETURNING id, title, sort_order, updated_at`,
      [isolatedProject],
    );
    const byTitle = new Map(seeded.rows.map((row) => [row.title, row]));
    const moved = await ideaOperatorMove({
      ideaId: byTitle.get('move-source-now')?.id ?? '',
      priority: 'next',
    });
    expect(moved.sort_order).toBe(0);
    const untouchedTitles = ['untouched-now', 'untouched-later', 'untouched-someday'];
    const after = await admin.query<{ title: string; sort_order: number; updated_at: Date }>(
      `SELECT title, sort_order, updated_at FROM ideas
       WHERE project_id = $1 AND title = ANY($2::text[]) ORDER BY title`,
      [isolatedProject, untouchedTitles],
    );
    for (const row of after.rows) {
      const before = byTitle.get(row.title);
      expect(Number(row.sort_order)).toBe(Number(before?.sort_order));
      expect(row.updated_at.toISOString()).toBe(before?.updated_at.toISOString());
    }
  });
});

describe('ideaOperatorReorder', () => {
  it('atomically realizes both directions when legacy rows share one rank', async () => {
    const { ideaOperatorReorder, ideasBoard, setIdeaBandTestHookForTests } = await import('../ideas.js');
    const seeded = await admin.query<{ id: string; title: string }>(
      `INSERT INTO ideas (project_id, title, status, priority, sort_order, source, created_at)
       VALUES
         ($1, 'tied-a', 'dropped', 'someday', 1000, 'user', '2026-08-06T09:00:00Z'),
         ($1, 'tied-b', 'dropped', 'someday', 1000, 'user', '2026-08-06T10:00:00Z'),
         ($1, 'tied-c', 'dropped', 'someday', 1000, 'user', '2026-08-06T11:00:00Z')
       RETURNING id, title`,
      [projectId]
    );
    const ids = new Map(seeded.rows.map((row) => [row.title, row.id]));
    const a = ids.get('tied-a') ?? '';
    const b = ids.get('tied-b') ?? '';
    const c = ids.get('tied-c') ?? '';

    await ideaOperatorReorder({
      ideaId: a,
      status: 'dropped',
      scope: 'project',
      includeClosed: true,
      expectedIds: [a, b, c],
      orderedIds: [b, a, c],
      projectId,
    });
    let dropped = (await ideasBoard({ scope: 'project', includeClosed: true }))
      .filter((row) => row.status === 'dropped');
    expect(dropped.map((row) => row.id)).toEqual([b, a, c]);
    expect(dropped.map((row) => row.sort_order)).toEqual([1000, 2000, 3000]);

    await ideaOperatorReorder({
      ideaId: c,
      status: 'dropped',
      scope: 'project',
      includeClosed: true,
      expectedIds: [b, a, c],
      orderedIds: [a, c, b],
      projectId,
    });
    dropped = (await ideasBoard({ scope: 'project', includeClosed: true }))
      .filter((row) => row.status === 'dropped');
    expect(dropped.map((row) => row.id)).toEqual([a, c, b]);
  });

  it('rejects stale and incomplete target-column snapshots', async () => {
    const { ideaOperatorReorder } = await import('../ideas.js');
    const rows = await admin.query<{ id: string }>(
      `SELECT id FROM ideas WHERE project_id = $1 AND status = 'dropped' ORDER BY sort_order`,
      [projectId]
    );
    await expect(ideaOperatorReorder({
      ideaId: rows.rows[0].id,
      status: 'dropped',
      scope: 'project',
      includeClosed: true,
      expectedIds: rows.rows.map((row) => row.id),
      orderedIds: [rows.rows[0].id],
      projectId,
    })).rejects.toThrow(/exactly describe/);

    const actual = rows.rows.map((row) => row.id);
    await expect(ideaOperatorReorder({
      ideaId: actual[0],
      status: 'dropped',
      scope: 'project',
      includeClosed: true,
      expectedIds: [...actual].reverse(),
      orderedIds: actual,
      projectId,
    })).rejects.toThrow(/board changed/);
  });

  it('can ship into a closed column whose older cards are hidden from the board', async () => {
    const { ideaAdd, ideaOperatorReorder } = await import('../ideas.js');
    const parked = await ideaAdd({ title: 'ship while history is hidden' });
    const moved = await ideaOperatorReorder({
      ideaId: parked.id,
      status: 'shipped',
      scope: 'project',
      includeClosed: false,
      expectedIds: [],
      orderedIds: [parked.id],
      projectId,
    });
    expect(moved.status).toBe('shipped');
    expect(moved.sort_order).toBe(1000);
  });

  it('cannot reorder an idea outside the selected project scope', async () => {
    const { ideaOperatorReorder } = await import('../ideas.js');
    const foreign = await admin.query<{ id: string }>(
      `SELECT id FROM ideas WHERE project_id IS NULL AND title LIKE $1 LIMIT 1`,
      [`${GLOBAL_MARKER}%`]
    );
    const target = await admin.query<{ id: string }>(
      `SELECT id FROM ideas WHERE project_id = $1 AND status = 'planned'
       ORDER BY sort_order, created_at, id`,
      [projectId]
    );
    const expectedIds = target.rows.map((row) => row.id);
    await expect(ideaOperatorReorder({
      ideaId: foreign.rows[0].id,
      status: 'planned',
      scope: 'project',
      includeClosed: false,
      expectedIds,
      orderedIds: [...expectedIds, foreign.rows[0].id],
      projectId,
    })).rejects.toThrow(/selected project scope/);
  });

  it('rejects cross-priority, cross-project, whole-column, duplicate, and hidden-row snapshots', async () => {
    const { ideaOperatorReorder } = await import('../ideas.js');
    const isolatedProject = await createScenarioProject('reorder-rejections');
    const seeded = await admin.query<{ id: string; title: string }>(
      `INSERT INTO ideas (project_id, title, status, priority, sort_order, source)
       VALUES
         ($1, 'band-now-a', 'idea', 'now', 1000, 'user'),
         ($1, 'band-now-b', 'idea', 'now', 2000, 'user'),
         ($1, 'band-later', 'idea', 'later', 1000, 'user'),
         (NULL, $2, 'idea', 'now', 1000, 'user'),
         ($1, 'hidden-shipped', 'shipped', 'now', 1000, 'user')
       RETURNING id, title`,
      [isolatedProject, `${GLOBAL_MARKER}-reorder-cross-project`],
    );
    const byTitle = new Map(seeded.rows.map((row) => [row.title, row.id]));
    const a = byTitle.get('band-now-a') ?? '';
    const b = byTitle.get('band-now-b') ?? '';
    const later = byTitle.get('band-later') ?? '';
    const global = byTitle.get(`${GLOBAL_MARKER}-reorder-cross-project`) ?? '';
    const hidden = byTitle.get('hidden-shipped') ?? '';
    const base = {
      ideaId: a,
      status: 'idea' as const,
      scope: 'both' as const,
      includeClosed: false,
      expectedIds: [a, b],
      projectId: isolatedProject,
    };
    await expect(ideaOperatorReorder({ ...base, orderedIds: [a, b, later] }))
      .rejects.toThrow(/project priority band/);
    await expect(ideaOperatorReorder({ ...base, orderedIds: [a, b, global] }))
      .rejects.toThrow(/project priority band/);
    await expect(ideaOperatorReorder({ ...base, expectedIds: [a, b, later], orderedIds: [a, b] }))
      .rejects.toThrow(/board changed/);
    await expect(ideaOperatorReorder({ ...base, orderedIds: [a, a] }))
      .rejects.toThrow(/duplicates/);
    await expect(ideaOperatorReorder({
      ideaId: hidden,
      status: 'shipped',
      scope: 'project',
      includeClosed: false,
      expectedIds: [],
      orderedIds: [hidden],
      projectId: isolatedProject,
    })).rejects.toThrow(/selected project scope/);
  });
});

describe('ideasBoardMarkdown', () => {
  it('groups the board by status', async () => {
    const { ideasBoardMarkdown } = await import('../ideas.js');
    const md = await ideasBoardMarkdown();
    expect(md).toContain('# Roadmap board');
    expect(md).toContain('## idea');
    expect(md).toContain('## building');
    expect(md).toContain('mai_idea_move');
  });

  it('renders a full UUID that can be passed directly to mai_idea_move', async () => {
    const { ideaAgentMove, ideasBoardMarkdown } = await import('../ideas.js');
    const seeded = await admin.query<{ id: string; title: string }>(
      `INSERT INTO ideas (project_id, title, status, priority, sort_order, source)
       VALUES ($1, 'copyable board id', 'planned', 'now', 9100, 'user') RETURNING id`,
      [projectId]
    );

    const md = await ideasBoardMarkdown();
    const line = md.split('\n').find((candidate) => candidate.includes('copyable board id'));
    const renderedId = line?.match(/`([0-9a-f-]{36})`/i)?.[1];
    expect(renderedId).toBe(seeded.rows[0].id);

    const moved = await ideaAgentMove({ ideaId: renderedId ?? '', to: 'building', evidence: 'board UUID copied verbatim' });
    expect(moved.status).toBe('building');
  });

  it('retrieves one complete card by UUID without reading the full board', async () => {
    const { ideasReadMarkdown } = await import('../ideas.js');
    const { mcpBudget, parseBudgetPage } = await import('../read-budget.js');
    const detail = `exact-card-detail\n${'D'.repeat(7_000)}`;
    const seeded = await admin.query<{ id: string }>(
      `INSERT INTO ideas (project_id, title, detail, status, priority, sort_order, source, evidence)
       VALUES ($1, 'exact UUID card', $2, 'shipped', 'later', 9200, 'user', 'commit abc123')
       RETURNING id`,
      [projectId, detail],
    );
    await admin.query(
      `INSERT INTO ideas (project_id, title, status, priority, sort_order, source)
       VALUES ($1, 'unrelated board card', 'idea', 'now', 9300, 'user')`,
      [projectId],
    );

    const selector = seeded.rows[0].id;
    const complete = await ideasReadMarkdown({ idea: selector });
    expect(complete).toContain('# Roadmap idea');
    expect(complete).toContain('exact UUID card');
    expect(complete).toContain(detail);
    expect(complete).toContain('commit abc123');
    expect(complete).not.toContain('unrelated board card');
    expect(await ideasReadMarkdown({ idea: selector.slice(0, 8) })).toBe(complete);

    const parts: string[] = [];
    for (let part = 1; ; part += 1) {
      const page = await ideasReadMarkdown({ idea: `${selector}:${part}`, budget: mcpBudget() });
      const parsed = parseBudgetPage(page);
      expect(parsed?.kind).toBe('idea');
      parts.push(parsed?.body ?? '');
      if (page.includes('; complete._')) break;
    }
    expect(parts.join('')).toBe(complete);

    await expect(ideasReadMarkdown({ idea: 'not-a-uuid' })).rejects.toThrow(/UUID.*8-character prefix/);
    await expect(ideasReadMarkdown({ idea: selector, scope: 'project' })).rejects.toThrow(/exclusive/);
    const hidden = await admin.query<{ id: string }>(
      `INSERT INTO ideas (project_id, title, status, priority, sort_order, source)
       VALUES ($1, 'other project exact card', 'idea', 'now', 9400, 'user') RETURNING id`,
      [otherProjectId],
    );
    await expect(ideasReadMarkdown({ idea: hidden.rows[0].id })).rejects.toThrow(/not found/);
    await admin.query(
      `INSERT INTO ideas (id, project_id, title, status, priority, sort_order, source)
       VALUES
         ('feedc0de-0000-4000-8000-000000000001', $1, 'ambiguous project card', 'idea', 'now', 9500, 'user'),
         ('feedc0de-0000-4000-8000-000000000002', NULL, $2, 'idea', 'now', 9500, 'user')`,
      [projectId, `${GLOBAL_MARKER}-ambiguous-global-card`],
    );
    await expect(ideasReadMarkdown({ idea: 'feedc0de' })).rejects.toThrow(/ambiguous.*full UUID/);
  });
});

describe('primeIdeasSection', () => {
  it('returns the in-flight slice (building + planned/now), capped', async () => {
    const { primeIdeasSection } = await import('../ideas.js');
    const section = await primeIdeasSection(projectId);
    expect(section).not.toBeNull();
    expect(section).toContain('## Roadmap — in flight');
    expect(section).toContain('existing build');
    expect(section).toMatch(/`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`/i);
  });

  it('keeps building before planned and priority-orders building rows', async () => {
    const { primeIdeasSection } = await import('../ideas.js');
    const isolatedProject = await createScenarioProject('prime-order');
    await admin.query(
      `INSERT INTO ideas (project_id, title, status, priority, sort_order, source)
       VALUES
         ($1, 'prime-someday', 'building', 'someday', 1, 'user'),
         ($1, 'prime-now', 'building', 'now', 9000, 'user'),
         ($1, 'prime-later', 'building', 'later', 1, 'user'),
         ($1, 'prime-next', 'building', 'next', 1, 'user'),
         ($1, 'prime-planned-now', 'planned', 'now', -100, 'user')`,
      [isolatedProject],
    );
    const section = await primeIdeasSection(isolatedProject);
    expect(section).not.toBeNull();
    const titles = ['prime-now', 'prime-next', 'prime-later', 'prime-someday', 'prime-planned-now'];
    const positions = titles.map((title) => section?.indexOf(title) ?? -1);
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe('idea row projection', () => {
  it('does not leak undeclared database columns through reads or RETURNING paths', async () => {
    const { ideaAddForProject, ideaOperatorMove, ideasBoard } = await import('../ideas.js');
    const isolatedProject = await createScenarioProject('projection');
    await admin.query(`ALTER TABLE ideas ADD COLUMN p42_undeclared TEXT DEFAULT 'secret'`);
    try {
      const added = await ideaAddForProject({ title: 'projection add' }, isolatedProject);
      const moved = await ideaOperatorMove({ ideaId: added.id, priority: 'now' });
      const read = (await ideasBoard({ scope: 'project', projectIdOverride: isolatedProject }))[0];
      expect(Object.keys(added)).not.toContain('p42_undeclared');
      expect(Object.keys(moved)).not.toContain('p42_undeclared');
      expect(Object.keys(read)).not.toContain('p42_undeclared');
      expect(Object.keys(read).sort()).toEqual([
        'created_at', 'detail', 'evidence', 'id', 'priority', 'project_id',
        'sort_order', 'source', 'status', 'title', 'updated_at',
      ]);
    } finally {
      await admin.query(`ALTER TABLE ideas DROP COLUMN p42_undeclared`);
    }
  });
});

describe('ideaOperatorUpdate', () => {
  it('edits title, detail, and priority; absent fields stay untouched', async () => {
    const { ideaAdd, ideaOperatorUpdate } = await import('../ideas.js');
    const nowAnchor = await ideaAdd({ title: 'priority destination anchor', priority: 'now' });
    const row = await ideaAdd({ title: 'editable idea', detail: 'original detail' });
    const updated = await ideaOperatorUpdate({
      ideaId: row.id, title: '  edited idea  ', priority: 'now', projectId,
    });
    expect(updated.title).toBe('edited idea');
    expect(updated.priority).toBe('now');
    expect(updated.detail).toBe('original detail');
    expect(updated.status).toBe('idea');
    expect(updated.sort_order).toBeLessThan(nowAnchor.sort_order);
  });

  it('detail null clears; detail undefined preserves', async () => {
    const { ideaAdd, ideaOperatorUpdate } = await import('../ideas.js');
    const row = await ideaAdd({ title: 'detail lifecycle', detail: 'to be cleared' });
    const kept = await ideaOperatorUpdate({ ideaId: row.id, priority: 'later', projectId });
    expect(kept.detail).toBe('to be cleared');
    const cleared = await ideaOperatorUpdate({ ideaId: row.id, detail: null, projectId });
    expect(cleared.detail).toBeNull();
  });

  it('re-homes project → global and prepends inside the exact global priority band', async () => {
    const { ideaAdd, ideaOperatorUpdate } = await import('../ideas.js');
    const anchor = await ideaAdd({ title: `${GLOBAL_MARKER} anchor`, scope: 'global' });
    const row = await ideaAdd({ title: `${GLOBAL_MARKER} homeward` });
    expect(row.project_id).toBe(projectId);
    const moved = await ideaOperatorUpdate({ ideaId: row.id, scope: 'global', projectId });
    expect(moved.project_id).toBeNull();
    expect(moved.sort_order).toBeLessThan(anchor.sort_order);
  });

  it('re-homes global → the viewing project and prepends inside the exact project priority band', async () => {
    const { ideaAdd, ideaOperatorUpdate } = await import('../ideas.js');
    const anchor = await ideaAdd({ title: 'project re-home anchor' });
    const row = await ideaAdd({ title: `${GLOBAL_MARKER} adopt me`, scope: 'global' });
    const moved = await ideaOperatorUpdate({ ideaId: row.id, scope: 'project', projectId });
    expect(moved.project_id).toBe(projectId);
    expect(moved.sort_order).toBeLessThan(anchor.sort_order);
    expect(moved.status).toBe(row.status);
  });

  it("scope 'project' on a card already in the viewing project keeps its rank", async () => {
    const { ideaAdd, ideaOperatorUpdate } = await import('../ideas.js');
    const row = await ideaAdd({ title: 'stay put' });
    const same = await ideaOperatorUpdate({ ideaId: row.id, scope: 'project', projectId });
    expect(same.project_id).toBe(projectId);
    expect(same.sort_order).toBe(row.sort_order);
  });

  it('simultaneously re-homes and reprioritizes into the new exact band', async () => {
    const { ideaAdd, ideaOperatorUpdate } = await import('../ideas.js');
    const anchor = await ideaAdd({ title: `${GLOBAL_MARKER} global-now-anchor`, scope: 'global', priority: 'now' });
    const row = await ideaAdd({ title: 'project-someday-to-global-now' });
    const moved = await ideaOperatorUpdate({
      ideaId: row.id,
      scope: 'global',
      priority: 'now',
      projectId,
    });
    expect(moved.project_id).toBeNull();
    expect(moved.priority).toBe('now');
    expect(moved.sort_order).toBeLessThan(anchor.sort_order);
  });

  it("rejects a card on another project's board (visibility guard)", async () => {
    const { ideaOperatorUpdate } = await import('../ideas.js');
    const foreign = await admin.query<{ id: string }>(
      `INSERT INTO ideas (project_id, title) VALUES ($1, 'foreign card') RETURNING id`,
      [otherProjectId]
    );
    await expect(
      ideaOperatorUpdate({ ideaId: foreign.rows[0].id, title: 'hijack', projectId })
    ).rejects.toThrow(/not found in the selected project scope/);
  });

  it('rejects bad input: invalid id, title bounds, invalid priority, no changes', async () => {
    const { ideaAdd, ideaOperatorUpdate } = await import('../ideas.js');
    const row = await ideaAdd({ title: 'validation target' });
    await expect(ideaOperatorUpdate({ ideaId: 'nope', title: 'x', projectId })).rejects.toThrow(/invalid idea id/);
    await expect(ideaOperatorUpdate({ ideaId: row.id, title: '   ', projectId })).rejects.toThrow(/title is required/);
    await expect(ideaOperatorUpdate({ ideaId: row.id, title: 'x'.repeat(201), projectId })).rejects.toThrow(/exceeds 200 chars/);
    const priorityArgs = {
      ideaId: row.id, priority: 'later', projectId,
    } satisfies Parameters<typeof ideaOperatorUpdate>[0];
    Object.defineProperty(priorityArgs, 'priority', { value: 'urgent' });
    await expect(ideaOperatorUpdate(priorityArgs)).rejects.toThrow(/invalid priority/);
    await expect(ideaOperatorUpdate({ ideaId: row.id, projectId })).rejects.toThrow(/nothing to change/);
  });
});

describe('priority-band concurrency', () => {
  it('serializes two reorders in one populated band and rejects the stale snapshot without deadlock', async () => {
    const { ideaOperatorReorder, ideasBoard, setIdeaBandTestHookForTests } = await import('../ideas.js');
    const isolatedProject = await createScenarioProject('same-band-race');
    const seeded = await admin.query<{ id: string; title: string }>(
      `INSERT INTO ideas (project_id, title, status, priority, sort_order, source)
       VALUES ($1, 'same-a', 'planned', 'now', 1000, 'user'),
              ($1, 'same-b', 'planned', 'now', 2000, 'user'),
              ($1, 'same-c', 'planned', 'now', 3000, 'user')
       RETURNING id, title`,
      [isolatedProject],
    );
    const byTitle = new Map(seeded.rows.map((row) => [row.title, row.id]));
    const a = byTitle.get('same-a') ?? '';
    const b = byTitle.get('same-b') ?? '';
    const c = byTitle.get('same-c') ?? '';
    const common = {
      status: 'planned' as const,
      scope: 'project' as const,
      includeClosed: false,
      expectedIds: [a, b, c],
      projectId: isolatedProject,
    };
    let beforeCount = 0;
    let firstLockedResolve: (() => void) | undefined;
    let secondReadyResolve: (() => void) | undefined;
    let releaseResolve: (() => void) | undefined;
    let paused = false;
    const firstLocked = new Promise<void>((resolve) => { firstLockedResolve = resolve; });
    const secondReady = new Promise<void>((resolve) => { secondReadyResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    setIdeaBandTestHookForTests(async (stage) => {
      if (stage === 'before-band-locks') {
        beforeCount += 1;
        if (beforeCount === 2) secondReadyResolve?.();
      }
      if (!paused && stage === 'after-first-band-lock') {
        paused = true;
        firstLockedResolve?.();
        await release;
      }
    });
    let results: PromiseSettledResult<Awaited<ReturnType<typeof ideaOperatorReorder>>>[];
    try {
      const firstMove = ideaOperatorReorder({ ...common, ideaId: a, orderedIds: [b, a, c] });
      await within(firstLocked);
      const secondMove = ideaOperatorReorder({ ...common, ideaId: c, orderedIds: [a, c, b] });
      await within(secondReady);
      releaseResolve?.();
      results = await within(Promise.allSettled([firstMove, secondMove]));
    } finally {
      releaseResolve?.();
      setIdeaBandTestHookForTests();
    }
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') {
      expect(String(rejected.reason)).toContain('board changed while moving the idea');
      expect(String(rejected.reason)).not.toContain('40P01');
    }
    const rows = (await ideasBoard({ scope: 'project', projectIdOverride: isolatedProject }))
      .filter((row) => row.status === 'planned' && row.priority === 'now');
    expect(rows.map((row) => row.sort_order)).toEqual([1000, 2000, 3000]);
  });

  it('serializes opposite band crossings and two moves into one empty band', async () => {
    const { ideaOperatorReorder, ideasBoard, setIdeaBandTestHookForTests } = await import('../ideas.js');
    const runForcedPair = async (
      firstOperation: () => Promise<unknown>,
      secondOperation: () => Promise<unknown>,
    ): Promise<PromiseSettledResult<unknown>[]> => {
      let beforeCount = 0;
      let firstLockedResolve: (() => void) | undefined;
      let secondReadyResolve: (() => void) | undefined;
      let releaseResolve: (() => void) | undefined;
      let paused = false;
      const firstLocked = new Promise<void>((resolve) => { firstLockedResolve = resolve; });
      const secondReady = new Promise<void>((resolve) => { secondReadyResolve = resolve; });
      const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
      setIdeaBandTestHookForTests(async (stage) => {
        if (stage === 'before-band-locks') {
          beforeCount += 1;
          if (beforeCount === 2) secondReadyResolve?.();
        }
        if (!paused && stage === 'after-first-band-lock') {
          paused = true;
          firstLockedResolve?.();
          await release;
        }
      });
      try {
        const first = firstOperation();
        await within(firstLocked);
        const second = secondOperation();
        await within(secondReady);
        releaseResolve?.();
        return await within(Promise.allSettled([first, second]));
      } finally {
        releaseResolve?.();
        setIdeaBandTestHookForTests();
      }
    };
    const crossingProject = await createScenarioProject('cross-band-race');
    const crossing = await admin.query<{ id: string; status: string }>(
      `INSERT INTO ideas (project_id, title, status, priority, sort_order, source)
       VALUES ($1, 'cross-planned', 'planned', 'next', 1000, 'user'),
              ($1, 'cross-building', 'building', 'next', 1000, 'user')
       RETURNING id, status`,
      [crossingProject],
    );
    const planned = crossing.rows.find((row) => row.status === 'planned')?.id ?? '';
    const building = crossing.rows.find((row) => row.status === 'building')?.id ?? '';
    const crossed = await runForcedPair(
      () => ideaOperatorReorder({
        ideaId: planned, status: 'building', scope: 'project', includeClosed: false,
        expectedIds: [building], orderedIds: [planned, building], projectId: crossingProject,
      }),
      () => ideaOperatorReorder({
        ideaId: building, status: 'planned', scope: 'project', includeClosed: false,
        expectedIds: [planned], orderedIds: [building, planned], projectId: crossingProject,
      }),
    );
    expect(crossed.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(crossed.every((result) => result.status === 'fulfilled' || !String(result.reason).includes('40P01'))).toBe(true);
    expect((await ideasBoard({ scope: 'project', projectIdOverride: crossingProject }))
      .filter((row) => row.priority === 'next')).toHaveLength(2);

    const emptyProject = await createScenarioProject('empty-band-race');
    const sources = await admin.query<{ id: string; status: string }>(
      `INSERT INTO ideas (project_id, title, status, priority, sort_order, source)
       VALUES ($1, 'empty-planned', 'planned', 'later', 1000, 'user'),
              ($1, 'empty-building', 'building', 'later', 1000, 'user')
       RETURNING id, status`,
      [emptyProject],
    );
    const first = sources.rows.find((row) => row.status === 'planned')?.id ?? '';
    const second = sources.rows.find((row) => row.status === 'building')?.id ?? '';
    const intoEmpty = await runForcedPair(
      () => ideaOperatorReorder({
        ideaId: first, status: 'dropped', scope: 'project', includeClosed: true,
        expectedIds: [], orderedIds: [first], projectId: emptyProject,
      }),
      () => ideaOperatorReorder({
        ideaId: second, status: 'dropped', scope: 'project', includeClosed: true,
        expectedIds: [], orderedIds: [second], projectId: emptyProject,
      }),
    );
    expect(intoEmpty.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(intoEmpty.every((result) => result.status === 'fulfilled' || !String(result.reason).includes('40P01'))).toBe(true);
    const persisted = await admin.query<{ sort_order: number }>(
      `SELECT sort_order FROM ideas
       WHERE project_id = $1 AND status = 'dropped' AND priority = 'later'`,
      [emptyProject],
    );
    expect(persisted.rows.map((row) => Number(row.sort_order))).toEqual([1000]);
    expect((await ideasBoard({ scope: 'project', includeClosed: true, projectIdOverride: emptyProject }))
      .filter((row) => row.status === 'dropped' && row.priority === 'later')).toHaveLength(1);
  });

  it('orders add and priority-move allocators relative to a committed reorder edge', async () => {
    const {
      ideaAddForProject,
      ideaOperatorMove,
      ideaOperatorReorder,
      setIdeaBandTestHookForTests,
    } = await import('../ideas.js');
    const isolatedProject = await createScenarioProject('allocator-races');
    const seeded = await admin.query<{ id: string; title: string }>(
      `INSERT INTO ideas (project_id, title, status, priority, sort_order, source)
       VALUES ($1, 'edge-a', 'idea', 'later', 1000, 'user'),
              ($1, 'edge-b', 'idea', 'later', 2000, 'user'),
              ($1, 'priority-source', 'idea', 'someday', 1000, 'user')
       RETURNING id, title`,
      [isolatedProject],
    );
    const byTitle = new Map(seeded.rows.map((row) => [row.title, row.id]));
    const a = byTitle.get('edge-a') ?? '';
    const b = byTitle.get('edge-b') ?? '';
    const source = byTitle.get('priority-source') ?? '';
    let reachedResolve: (() => void) | undefined;
    let releaseResolve: (() => void) | undefined;
    let paused = false;
    const reached = new Promise<void>((resolve) => { reachedResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    setIdeaBandTestHookForTests(async (stage, detail) => {
      if (!paused && stage === 'before-target-row-locks' && detail.band?.projectId === isolatedProject) {
        paused = true;
        reachedResolve?.();
        await release;
      }
    });
    try {
      const reorder = ideaOperatorReorder({
        ideaId: a, status: 'idea', scope: 'project', includeClosed: false,
        expectedIds: [a, b], orderedIds: [b, a], projectId: isolatedProject,
      });
      await within(reached);
      const add = ideaAddForProject({ title: 'edge-added', priority: 'later' }, isolatedProject);
      releaseResolve?.();
      const [, added] = await within(Promise.all([reorder, add]));
      expect(added.sort_order).toBe(3000);

      paused = false;
      let reachedMoveResolve: (() => void) | undefined;
      let releaseMoveResolve: (() => void) | undefined;
      const reachedMove = new Promise<void>((resolve) => { reachedMoveResolve = resolve; });
      const releaseMove = new Promise<void>((resolve) => { releaseMoveResolve = resolve; });
      setIdeaBandTestHookForTests(async (stage, detail) => {
        if (!paused && stage === 'before-target-row-locks' && detail.band?.projectId === isolatedProject) {
          paused = true;
          reachedMoveResolve?.();
          await releaseMove;
        }
      });
      const reorderAgain = ideaOperatorReorder({
        ideaId: b, status: 'idea', scope: 'project', includeClosed: false,
        expectedIds: [b, a, added.id], orderedIds: [a, b, added.id], projectId: isolatedProject,
      });
      await within(reachedMove);
      const priorityMove = ideaOperatorMove({ ideaId: source, priority: 'later' });
      releaseMoveResolve?.();
      const [, moved] = await within(Promise.all([reorderAgain, priorityMove]));
      expect(moved.sort_order).toBe(0);
      const final = await admin.query<{ title: string }>(
        `SELECT title FROM ideas
         WHERE project_id = $1 AND status = 'idea' AND priority = 'later'
         ORDER BY sort_order, created_at, id`,
        [isolatedProject],
      );
      expect(final.rows.map((row) => row.title)).toEqual(['priority-source', 'edge-a', 'edge-b', 'edge-added']);
    } finally {
      setIdeaBandTestHookForTests();
      releaseResolve?.();
    }
  });

  it('rolls back an error after allocation and exhausts identity drift after exactly three attempts', async () => {
    const { ideaAgentMove, setIdeaBandTestHookForTests } = await import('../ideas.js');
    const isolatedProject = await createScenarioProject('rollback-retry');
    const seeded = await admin.query<{ id: string; title: string; sort_order: number; updated_at: Date }>(
      `INSERT INTO ideas (project_id, title, status, priority, sort_order, source, evidence, updated_at)
       VALUES ($1, 'rollback-after-allocation', 'planned', 'now', 5000, 'user', 'initial', '2026-08-27T08:00:00Z'),
              ($1, 'rollback-target-a', 'building', 'now', 1000, 'user', NULL, '2026-08-27T08:00:00Z'),
              ($1, 'rollback-target-b', 'building', 'now', 2000, 'user', NULL, '2026-08-27T08:00:00Z')
       RETURNING id, title, sort_order, updated_at`,
      [isolatedProject],
    );
    const moving = seeded.rows.find((row) => row.title === 'rollback-after-allocation');
    await admin.query(`
      CREATE FUNCTION p42_fail_after_allocation() RETURNS trigger AS $$
      BEGIN
        IF NEW.title = 'rollback-after-allocation' AND NEW.status = 'building' THEN
          RAISE EXCEPTION 'forced p42 allocation failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER p42_fail_after_allocation_trigger
      BEFORE UPDATE ON ideas FOR EACH ROW EXECUTE FUNCTION p42_fail_after_allocation();
    `);
    try {
      await expect(ideaAgentMove({
        ideaId: moving?.id ?? '', to: 'building', evidence: 'must roll back',
      })).rejects.toThrow(/forced p42 allocation failure/);
    } finally {
      await admin.query(`DROP TRIGGER p42_fail_after_allocation_trigger ON ideas`);
      await admin.query(`DROP FUNCTION p42_fail_after_allocation()`);
    }
    const afterFailure = await admin.query<{
      id: string; title: string; status: string; sort_order: number; evidence: string | null; updated_at: Date;
    }>(
      `SELECT id, title, status, sort_order, evidence, updated_at FROM ideas
       WHERE project_id = $1 ORDER BY title`,
      [isolatedProject],
    );
    expect(afterFailure.rows.map((row) => [row.title, row.status, Number(row.sort_order)])).toEqual([
      ['rollback-after-allocation', 'planned', 5000],
      ['rollback-target-a', 'building', 1000],
      ['rollback-target-b', 'building', 2000],
    ]);
    expect(afterFailure.rows.find((row) => row.id === moving?.id)?.evidence).toBe('initial');
    expect(afterFailure.rows.every((row) => row.updated_at.toISOString() === '2026-08-27T08:00:00.000Z')).toBe(true);

    const priorities = ['next', 'later', 'now'] as const;
    let attempts = 0;
    setIdeaBandTestHookForTests(async (stage) => {
      if (stage !== 'before-band-locks') return;
      const priority = priorities[attempts];
      attempts += 1;
      await admin.query(`UPDATE ideas SET priority = $2 WHERE id = $1`, [moving?.id, priority]);
    });
    try {
      await expect(ideaAgentMove({
        ideaId: moving?.id ?? '', to: 'building', evidence: 'never committed',
      })).rejects.toThrow('board changed while moving the idea — reload and try again');
    } finally {
      setIdeaBandTestHookForTests();
    }
    expect(attempts).toBe(3);
    const afterRetries = await admin.query<{ status: string; sort_order: number; evidence: string | null }>(
      `SELECT status, sort_order, evidence FROM ideas WHERE id = $1`,
      [moving?.id],
    );
    expect(afterRetries.rows[0]).toMatchObject({ status: 'planned', evidence: 'initial' });
    expect(Number(afterRetries.rows[0].sort_order)).toBe(5000);
  });
});
