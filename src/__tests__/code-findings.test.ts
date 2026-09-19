/** Plan 24: the code-findings store — domain, built-CLI exit codes, and recall
 * across BOTH finding tables. Fake embedder throughout (plan 14 R8). Throwaway
 * projects; the DB URL comes from the validated disposable test variable below —
 * its database name must start `mai_plan23_` and can never be `mai_brain`, so
 * this file names no other database. */
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
// Type-only — erased at compile, so it cannot load app code before the env
// pinning below (every runtime import in this file stays dynamic for that reason).
import type { ReadBudget } from '../read-budget.js';
import { requireDisposableTestDbUrl } from './test-db-url.js';

const saved: Record<string, string | undefined> = {
  MAI_PROJECT_SLUG: process.env.MAI_PROJECT_SLUG,
  MAI_DB_URL: process.env.MAI_DB_URL,
  MAI_LLM_SUMMARY: process.env.MAI_LLM_SUMMARY,
  MAI_AGENT_ID: process.env.MAI_AGENT_ID,
};
const SLUG_A = 'plan24-test';
const SLUG_B = 'plan24-other';
process.env.MAI_PROJECT_SLUG = SLUG_A;
// The dedicated MAI_TEST_DB_URL is the authority, never an inherited
// MAI_DB_URL: this suite DELETES the projects it uses, so it must be
// impossible to point it at the operator's real brain.
process.env.MAI_DB_URL = requireDisposableTestDbUrl();
process.env.MAI_LLM_SUMMARY = '0';
process.env.MAI_AGENT_ID = 'tester@vitest';

const DB_URL = process.env.MAI_DB_URL;
const admin = new Pool({ connectionString: DB_URL });
let root: string;
let planRel: string;
let projectA: string;
let projectB: string;

const oneHot = (i: number): number[] => { const v = new Array(384).fill(0); v[i] = 1; return v; };
const smallBudget = (): ReadBudget => ({ fullRows: 0, charBudget: 900 });

interface CliResult { status: number; out: string }

/** Drive the BUILT binary (R7) and report the OUTER exit status. `dbUrl` is
 * explicit so test 23 can point one invocation at a closed port. */
function runCli(args: string[], input = '', dbUrl: string = DB_URL): CliResult {
  const env = { ...process.env, MAI_DB_URL: dbUrl, MAI_EMBEDDINGS: '0' };
  try {
    const out = execFileSync('node', ['build/cli.js', ...args], { input, env, encoding: 'utf8' });
    return { status: 0, out };
  } catch (err) {
    const rec = err !== null && typeof err === 'object' ? err : {};
    const status = Reflect.get(rec, 'status');
    const stdout = Reflect.get(rec, 'stdout');
    const stderr = Reflect.get(rec, 'stderr');
    return {
      status: typeof status === 'number' ? status : 1,
      out: `${typeof stdout === 'string' ? stdout : ''}${typeof stderr === 'string' ? stderr : ''}`,
    };
  }
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

/** Execute the built CLI with a real pseudo-terminal attached to stdin. Node's
 * child_process pipes are never TTYs, so ordinary Vitest children cannot prove
 * the interactive no-input guard. BSD script(1) itself requires a TTY on stdin,
 * so macOS uses its system Expect; Linux uses util-linux script(1). Unsupported
 * platforms fail loudly instead of silently skipping the release requirement. */
function runCliInPty(args: string[]): CliResult {
  const command = [process.execPath, 'build/cli.js', ...args];
  let executable: string;
  let ptyArgs: string[];
  if (process.platform === 'darwin') {
    executable = '/usr/bin/expect';
    const driver = path.join(root, 'pty-run.exp');
    fs.writeFileSync(driver, [
      'set timeout 5',
      'spawn -noecho {*}$argv',
      'expect eof',
      'set result [wait]',
      'exit [lindex $result 3]',
      '',
    ].join('\n'));
    ptyArgs = ['-f', driver, ...command];
  } else if (process.platform === 'linux') {
    executable = 'script';
    ptyArgs = ['-q', '-e', '-c', command.map(shellWord).join(' '), '/dev/null'];
  } else {
    throw new Error(`PTY integration test is unsupported on ${process.platform}`);
  }
  const result = spawnSync(executable, ptyArgs, {
    env: { ...process.env, MAI_DB_URL: DB_URL, MAI_EMBEDDINGS: '0' },
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function finding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    base_sha: 'aaaa', head_sha: 'bbbb', severity: 'warning',
    title: 'PLAN24 fixture finding', location: 'src/x.ts:1',
    issue: 'the issue', evidence: 'the evidence', fix: 'the fix',
    ...over,
  };
}

/** Raw-insert a row for the OTHER project, so negatives are one predicate — the
 * project one — away from being returned (test 19's seeding contract). */
async function seedForeign(over: {
  title: string; issue?: string; embedding?: number[] | null; model?: string | null;
}): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `INSERT INTO code_findings
       (project_id, base_sha, head_sha, reviewer_agent, severity, title, location,
        issue, evidence, fix, embedding, embedding_model)
     VALUES ($1,'a','b','foreign','warning',$2,'src/b.ts:1',$3,'e','f',$4,$5)
     RETURNING id`,
    [projectB, over.title, over.issue ?? 'foreign issue', over.embedding ?? null, over.model ?? null]
  );
  return r.rows[0].id;
}

beforeAll(async () => {
  await import('../db.js'); // dotenv defusal before scrubbing
  for (const k of ['MAI_EMBEDDINGS', 'OPENAI_API_KEY', 'VOYAGE_API_KEY']) saved[k] = process.env[k];
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan24-'));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  planRel = 'docs/2026-08-13-plan-98-fixture.md';
  fs.writeFileSync(path.join(root, planRel), '# Fixture plan\n');
  for (const s of [SLUG_A, SLUG_B]) await admin.query(`DELETE FROM projects WHERE slug = $1`, [s]);
  const a = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name, path) VALUES ($1,'Plan24 A',$2) RETURNING id`, [SLUG_A, root]);
  projectA = a.rows[0].id;
  const b = await admin.query<{ id: string }>(
    `INSERT INTO projects (slug, name, path) VALUES ($1,'Plan24 B',$2) RETURNING id`, [SLUG_B, root]);
  projectB = b.rows[0].id;
});

afterAll(async () => {
  const { setLocalEmbedderForTests } = await import('../embeddings.js');
  setLocalEmbedderForTests(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  for (const s of [SLUG_A, SLUG_B]) await admin.query(`DELETE FROM projects WHERE slug = $1`, [s]);
  await admin.end();
  const { getPool } = await import('../db.js');
  await getPool().end();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const p of [projectA, projectB]) {
    await admin.query(
      `DELETE FROM memory_citations WHERE project_id = $1
         AND citing_kind = 'finding' AND relation = 'finding_ref'`, [p]);
    await admin.query(`DELETE FROM code_findings WHERE project_id = $1`, [p]);
    await admin.query(`DELETE FROM code_decisions WHERE project_id = $1`, [p]);
    await admin.query(`DELETE FROM plans WHERE project_id = $1`, [p]);
  }
  process.env.MAI_EMBEDDINGS = '1';
  delete process.env.OPENAI_API_KEY;
  delete process.env.VOYAGE_API_KEY;
  const { setLocalEmbedderForTests } = await import('../embeddings.js');
  setLocalEmbedderForTests(async () => oneHot(3));
});

describe('code findings — domain', () => {
  it('1: add persists and attributes the reviewer from the configured identity', async () => {
    const { codeFindingAdd, parseFinding } = await import('../code-findings.js');
    const r = await codeFindingAdd(SLUG_A, parseFinding(finding({ title: 'PLAN24 identity' })));
    expect(r.status).toBe('open');
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    const row = await admin.query<{ reviewer_agent: string }>(
      `SELECT reviewer_agent FROM code_findings WHERE id = $1`, [r.id]);
    // Attribution comes from the identity, never from an argument (R2).
    expect(row.rows[0].reviewer_agent).toBe('tester@vitest');
  });

  it('2: add with no plan_id persists with plan_id IS NULL — the ad-hoc case', async () => {
    const { codeFindingAdd, parseFinding } = await import('../code-findings.js');
    const r = await codeFindingAdd(SLUG_A, parseFinding(finding()));
    const row = await admin.query<{ plan_id: string | null }>(
      `SELECT plan_id FROM code_findings WHERE id = $1`, [r.id]);
    expect(row.rows[0].plan_id).toBeNull();
  });

  it('3: deleting the plan leaves the finding with plan_id NULL, not deleted (ambiguity 3)', async () => {
    const { planRegister } = await import('../plans.js');
    const { codeFindingAdd, parseFinding } = await import('../code-findings.js');
    const plan = await planRegister({ path: planRel });
    const r = await codeFindingAdd(SLUG_A, parseFinding(finding({ plan_id: plan.id })));
    await admin.query(`DELETE FROM plans WHERE id = $1`, [plan.id]);
    const row = await admin.query<{ n: string; plan_id: string | null }>(
      `SELECT count(*)::text AS n, max(plan_id::text) AS plan_id FROM code_findings WHERE id = $1`, [r.id]);
    expect(row.rows[0].n).toBe('1');
    expect(row.rows[0].plan_id).toBeNull();
  });
});

describe('code findings — exit codes through the BUILT CLI (R4/R7)', () => {
  it('4: close with a nonexistent slug exits 4 and changes nothing', async () => {
    const { codeFindingAdd, parseFinding } = await import('../code-findings.js');
    const r = await codeFindingAdd(SLUG_A, parseFinding(finding()));
    const res = runCli(['code-findings', 'close', r.id, '--status', 'fixed', '--note', 'n',
      '--project', 'no-such-project-plan24']);
    expect(res.status).toBe(4);
    const row = await admin.query<{ status: string }>(
      `SELECT status FROM code_findings WHERE id = $1`, [r.id]);
    expect(row.rows[0].status).toBe('open');
  });

  it('5: close of a UUID that exists nowhere exits 3', () => {
    const res = runCli(['code-findings', 'close', '11111111-2222-3333-4444-555555555555',
      '--status', 'fixed', '--note', 'n', '--project', SLUG_A]);
    expect(res.status).toBe(3);
  });

  it('6: close to a non-open status without a note exits 2', async () => {
    const { codeFindingAdd, parseFinding } = await import('../code-findings.js');
    const r = await codeFindingAdd(SLUG_A, parseFinding(finding()));
    const res = runCli(['code-findings', 'close', r.id, '--status', 'fixed', '--project', SLUG_A]);
    expect(res.status).toBe(2);
  });

  it('6a: interactive add without stdin JSON exits 2 promptly under a real PTY', () => {
    const res = runCliInPty(['code-findings', 'add', '--project', SLUG_A]);
    expect(res.status).toBe(2);
    expect(res.out).toContain('pipe JSON on stdin or pass --file <path>');
  });

  it('9: add through the built CLI — valid exits 0, bad JSON exits 2, bad slug exits 4', async () => {
    const ok = runCli(['code-findings', 'add', '--project', SLUG_A], JSON.stringify(finding()));
    expect(ok.status).toBe(0);
    const parsedRaw: unknown = JSON.parse(ok.out.trim());
    const parsed: Record<string, unknown> = typeof parsedRaw === 'object' && parsedRaw !== null
      ? { ...parsedRaw } : {};
    expect(String(parsed.id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // Plan 26: bind the skill's documented file invocation and lowercase wire
    // severity to the BUILT CLI.
    //
    // AMENDMENT A2 (finding 5f3a6a2d, author-approved 2026-08-14). The previous
    // comment claimed the marker proves a shell never interprets the payload.
    // It cannot: runCli spawns via execFileSync with an ARGUMENT ARRAY, so no
    // shell exists in this path by construction and the marker could never
    // appear regardless of the CLI's behaviour — a check that cannot fail for
    // the reason it states. What this case actually proves is the falsifiable
    // part: hostile bytes survive the --file path as DATA and round-trip into
    // the store unchanged. The marker assertion is retained only as a cheap
    // backstop against the CLI itself ever shelling out internally.
    const skill = fs.readFileSync('skills/mai-code-review/SKILL.md', 'utf8');
    expect(skill).toContain('mai code-findings add --project <slug> --file "$FINDING_FILE"');
    expect(skill).toContain('"severity": "blocker"');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-code-review-cli-'));
    try {
      const marker = path.join(tmp, 'must-not-exist');
      const findingFile = path.join(tmp, 'finding.json');
      const hostile = `quotes "double" and 'single', backtick \`tick\`, literal $(touch ${marker})`;
      fs.writeFileSync(findingFile, JSON.stringify(finding({
        severity: 'blocker', title: 'PLAN26 skill --file path', evidence: hostile,
      })), { mode: 0o600 });
      const viaFile = runCli([
        'code-findings', 'add', '--project', SLUG_A, '--file', findingFile,
      ]);
      expect(viaFile.status).toBe(0);
      const viaFileRaw: unknown = JSON.parse(viaFile.out.trim());
      const viaFileJson: Record<string, unknown> =
        typeof viaFileRaw === 'object' && viaFileRaw !== null ? { ...viaFileRaw } : {};
      expect(String(viaFileJson.id)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(viaFileJson.status).toBe('open');
      // The falsifiable half: the hostile bytes are stored verbatim, proving
      // they were carried as data rather than expanded, truncated or escaped.
      const stored = await admin.query<{ evidence: string }>(
        `SELECT evidence FROM code_findings WHERE id = $1`, [String(viaFileJson.id)]);
      expect(stored.rows[0].evidence).toBe(hostile);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    expect(runCli(['code-findings', 'add', '--project', SLUG_A], 'not json{').status).toBe(2);
    expect(runCli(['code-findings', 'add', '--project', 'nope-plan24'],
      JSON.stringify(finding())).status).toBe(4);
  });

  it('11: the REAL cross-project close exits 4, not 3, and changes nothing', async () => {
    const { codeFindingAdd, parseFinding } = await import('../code-findings.js');
    const mine = await codeFindingAdd(SLUG_A, parseFinding(finding({ title: 'PLAN24 owned by A' })));
    const res = runCli(['code-findings', 'close', mine.id, '--status', 'fixed', '--note', 'n',
      '--project', SLUG_B]);
    expect(res.status).toBe(4);
    expect(res.out).toContain(SLUG_A);
    const row = await admin.query<{ status: string }>(
      `SELECT status FROM code_findings WHERE id = $1`, [mine.id]);
    expect(row.rows[0].status).toBe('open');
    // A UUID owned by nobody is still 3 — the two causes stay apart.
    expect(runCli(['code-findings', 'close', '99999999-8888-7777-6666-555555555555',
      '--status', 'fixed', '--note', 'n', '--project', SLUG_A]).status).toBe(3);
  });

  it('12: a cross-project plan_id exits 4 and persists nothing; a non-UUID exits 2, not 5', async () => {
    const foreignPlan = await admin.query<{ id: string }>(
      `INSERT INTO plans (project_id, slug, path, title, current_sha, status)
       VALUES ($1,'p24b','docs/b.md','B','0','draft') RETURNING id`, [projectB]);
    const res = runCli(['code-findings', 'add', '--project', SLUG_A],
      JSON.stringify(finding({ plan_id: foreignPlan.rows[0].id, title: 'PLAN24 cross plan' })));
    expect(res.status).toBe(4);
    const n = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM code_findings WHERE title = 'PLAN24 cross plan'`);
    expect(n.rows[0].n).toBe('0');
    // 22P02 from an unguarded non-UUID would surface as 5 (database failure).
    expect(runCli(['code-findings', 'add', '--project', SLUG_A],
      JSON.stringify(finding({ plan_id: 'not-a-uuid' }))).status).toBe(2);
  });

  it('13: bare --file exits 2, and a --file that does not exist exits 2 naming the path', () => {
    const bare = runCli(['code-findings', 'add', '--file', '--project', SLUG_A]);
    expect(bare.status).toBe(2);
    const missing = runCli(['code-findings', 'add', '--file', '/nonexistent/plan24.json',
      '--project', SLUG_A]);
    expect(missing.status).toBe(2);
    expect(missing.out).toContain('/nonexistent/plan24.json');
  });

  it('14: a body of exactly the cap persists; one char more exits 2 and says to trim', async () => {
    const { CODE_FINDING_BODY_MAX } = await import('../code-findings.js');
    const atCap = runCli(['code-findings', 'add', '--project', SLUG_A],
      JSON.stringify(finding({ fix: 'y'.repeat(CODE_FINDING_BODY_MAX), title: 'PLAN24 at cap' })));
    expect(atCap.status).toBe(0);
    const over = runCli(['code-findings', 'add', '--project', SLUG_A],
      JSON.stringify(finding({ fix: 'y'.repeat(CODE_FINDING_BODY_MAX + 1) })));
    expect(over.status).toBe(2);
    expect(over.out).toContain('trim it and re-file');
  });

  it('23: a genuine database failure exits 5, distinct from 2/3/4', () => {
    // Deliberately NOT the validated URL: a closed port is the one way to reach
    // the DB code with no other failure mode in the path.
    const res = runCli(['code-findings', 'add', '--project', SLUG_A], JSON.stringify(finding()),
      'postgresql://postgres:postgres@127.0.0.1:1/mai_plan23_closed_port');
    expect(res.status).toBe(5);
  });
});

describe('code findings — recall (R5)', () => {
  it('7: similar_to returns both kinds, labelled, in BOTH renderers; the plan row is unchanged', async () => {
    const { planRegister, reviewPost, findingsQuery } = await import('../plans.js');
    const { codeFindingAdd, parseFinding } = await import('../code-findings.js');
    await planRegister({ path: planRel });
    const rv = await reviewPost({
      plan: planRel, kind: 'author', verdict: 'blocked', synthesis: 's',
      findings: [{ ref: 'B1', severity: 'blocker', title: 'PLAN24 shared subject', location: 'src/p.ts:1',
        issue: 'i', evidence: 'e', fix: 'f' }],
    });
    const code = await codeFindingAdd(SLUG_A, parseFinding(finding({ title: 'PLAN24 shared subject too' })));
    // Pinned: the embedder decides whether this lands on :1050 or :1065.
    process.env.MAI_EMBEDDINGS = '0';
    const full = await findingsQuery({ similar_to: 'PLAN24 shared subject', limit: 5 });
    expect(full).toContain(`[code/warning/open]`);
    // The plan row's rendered line is byte-identical to its pre-change form.
    const planLine = full.split('\n').find((l) => l.includes(rv.findings[0].id));
    expect(planLine).toBe(`- \`${rv.findings[0].id}\` [blocker/open] (B1) **PLAN24 shared subject**`);
    const headline = await findingsQuery({ similar_to: 'PLAN24 shared subject', limit: 5, budget: smallBudget() });
    expect(headline).toContain('[code/warning/open]');
    expect(headline).toContain(code.id);
  });

  it('8: mai_findings {plan: X} includes a code finding linked to X', async () => {
    const { planRegister, findingsQuery } = await import('../plans.js');
    const { codeFindingAdd, parseFinding } = await import('../code-findings.js');
    const plan = await planRegister({ path: planRel });
    const code = await codeFindingAdd(SLUG_A,
      parseFinding(finding({ plan_id: plan.id, title: 'PLAN24 plan-linked code finding' })));
    const out = await findingsQuery({ plan: planRel });
    expect(out).toContain(code.id);
    expect(out).toContain('[code/warning/open]');
  });

  it('10: an oversized code finding renders headline-only AND its pointer resolves across parts', async () => {
    const { findingsQuery } = await import('../plans.js');
    const { codeFindingAdd, parseFinding } = await import('../code-findings.js');
    const big = 'z'.repeat(9000);
    const r = await codeFindingAdd(SLUG_A, parseFinding(finding({ issue: big, title: 'PLAN24 oversized' })));
    const shortened = await findingsQuery({ plan: undefined, budget: smallBudget() });
    expect(shortened).toContain(r.id);
    // The recovery pointer it advertises must actually work for a CODE finding.
    const p1 = await findingsQuery({ finding: r.id, budget: smallBudget() });
    const p2 = await findingsQuery({ finding: `${r.id}:2`, budget: smallBudget() });
    expect(`${p1}${p2}`).toContain('zzzz');
    const complete = await findingsQuery({ finding: r.id });
    expect(complete).toContain(big);
  });

  it('22: plan-finding renders stay byte-identical in both renderers (exact equality)', async () => {
    const { planRegister, reviewPost, findingsQuery } = await import('../plans.js');
    await planRegister({ path: planRel });
    const rv = await reviewPost({
      plan: planRel, kind: 'author', verdict: 'blocked', synthesis: 's',
      findings: [{ ref: 'B1', severity: 'blocker', title: 'PLAN24 render pin', location: 'src/r.ts:9',
        issue: 'i', evidence: 'e', fix: 'f' }],
    });
    const id = rv.findings[0].id;
    const full = await findingsQuery({ plan: planRel });
    const fullLine = full.split('\n').find((l) => l.includes(id));
    // toBe, never toContain: containment cannot detect an ADDED prefix.
    expect(fullLine).toBe(`- \`${id}\` [blocker/open] (B1) **PLAN24 render pin**`);
    const head = await findingsQuery({ plan: planRel, budget: { fullRows: 0, charBudget: 400 } });
    const headLine = head.split('\n').find((l) => l.includes(id));
    expect(headLine).toBe(`- \`${id}\` [blocker/open] (B1) **PLAN24 render pin** · src/r.ts:9`);
  });
});

describe('code findings — embeddings (ambiguity 6)', () => {
  it('15: embedded on write and surfaced under the semantic heading, not the stale one', async () => {
    const { findingsQuery } = await import('../plans.js');
    const { codeFindingAdd, parseFinding } = await import('../code-findings.js');
    const { currentEmbeddingModelId } = await import('../embeddings.js');
    const r = await codeFindingAdd(SLUG_A, parseFinding(finding({ title: 'PLAN24 embedded on write' })));
    const row = await admin.query<{ model: string | null; dim: number | null }>(
      `SELECT embedding_model AS model, array_length(embedding,1) AS dim
         FROM code_findings WHERE id = $1`, [r.id]);
    expect(row.rows[0].model).toBe(currentEmbeddingModelId());
    expect(row.rows[0].dim).toBe(384);
    const out = await findingsQuery({ similar_to: 'PLAN24 embedded on write', limit: 5 });
    // The heading is the reader-visible symptom W1 named.
    expect(out).toContain('Similar past findings');
    expect(out).not.toContain('not yet re-embedded');
  });

  it('16: rebuild backfills exactly one row and skippedCurrent is an exact number', async () => {
    const { codeFindingAdd, parseFinding } = await import('../code-findings.js');
    const { runEmbedRebuild } = await import('../scripts/embed-rebuild.js');
    const { currentEmbeddingModelId } = await import('../embeddings.js');
    const S = 2;
    for (let i = 0; i < S; i++) {
      await codeFindingAdd(SLUG_A, parseFinding(finding({ title: `PLAN24 current ${i}` })));
    }
    const nulled = await codeFindingAdd(SLUG_A, parseFinding(finding({ title: 'PLAN24 provider was down' })));
    await admin.query(
      `UPDATE code_findings SET embedding = NULL, embedding_model = NULL WHERE id = $1`, [nulled.id]);
    // The lessons loop is NOT project-scoped — an unseamed call would rewrite
    // every global lesson vector in this database. The sentinel matches nothing.
    const out = await runEmbedRebuild({ projectSlug: SLUG_A, lessonRuleLike: 'PLAN24NOLESSON %' });
    expect(out).toContain('code finding(s) re-embedded');
    const row = await admin.query<{ model: string | null }>(
      `SELECT embedding_model AS model FROM code_findings WHERE id = $1`, [nulled.id]);
    expect(row.rows[0].model).toBe(currentEmbeddingModelId());
    // Exact, not >= 0: omitting the total term drops this by S, omitting the
    // subtraction raises it by 1 — each moves it in a different direction.
    const m = out.match(/(\d+) already current/);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBe(S);
  });
});

describe('code findings — cross-store boundaries', () => {
  it('17: plan merge carries code findings to the survivor, not to NULL (Step 6)', async () => {
    const { planRegister } = await import('../plans.js');
    const { codeFindingAdd, parseFinding } = await import('../code-findings.js');
    await planRegister({ path: planRel });
    // A second physical row for the SAME path is what planRegister collapses.
    // Which row survives is decided by rank-then-lowest-UUID (plans.ts:207-211),
    // so the assertion pins "the finding follows the survivor", never a
    // particular one of the two — the merge is deterministic, the winning UUID
    // is not.
    const alias = await admin.query<{ id: string }>(
      `INSERT INTO plans (project_id, slug, path, title, current_sha, status)
       VALUES ($1,'alias-plan-98',$2,'Alias','0','draft') RETURNING id`, [projectA, planRel]);
    const code = await codeFindingAdd(SLUG_A,
      parseFinding(finding({ plan_id: alias.rows[0].id, title: 'PLAN24 merged across' })));
    const merged = await planRegister({ path: planRel });
    const plans = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM plans WHERE project_id = $1`, [projectA]);
    expect(plans.rows[0].n).toBe('1'); // the alias was collapsed
    const row = await admin.query<{ plan_id: string | null }>(
      `SELECT plan_id FROM code_findings WHERE id = $1`, [code.id]);
    // Without Step 6's UPDATE this is NULL — ON DELETE SET NULL destroys the link.
    expect(row.rows[0].plan_id).toBe(merged.id);
  });

  it('18: mai_finding_update on a code finding points at the CLI; an absent uuid keeps the old text', async () => {
    const { findingUpdate } = await import('../plans.js');
    const { codeFindingAdd, parseFinding } = await import('../code-findings.js');
    const code = await codeFindingAdd(SLUG_A, parseFinding(finding({ title: 'PLAN24 close me from the CLI' })));
    await expect(findingUpdate({ finding_id: code.id, status: 'fixed', note: 'n' }))
      .rejects.toThrow(/is a CODE finding — close it from the CLI: mai code-findings close/);
    // Discriminating, not swallowing: a genuinely absent id keeps the original.
    await expect(findingUpdate({
      finding_id: '00000000-1111-2222-3333-444444444444', status: 'fixed', note: 'n',
    })).rejects.toThrow(/No finding .* in this project\./);
  });

  it('21: recurrence_of pointing at a code finding names it, and the whole pass rolls back', async () => {
    const { planRegister, reviewPost } = await import('../plans.js');
    const { codeFindingAdd, parseFinding } = await import('../code-findings.js');
    const plan = await planRegister({ path: planRel });
    const code = await codeFindingAdd(SLUG_A, parseFinding(finding({ title: 'PLAN24 recurrence target' })));
    const before = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM plan_reviews WHERE plan_id = $1`, [plan.id]);
    await expect(reviewPost({
      plan: planRel, kind: 'author', verdict: 'blocked', synthesis: 's',
      findings: [{ severity: 'blocker', title: 'PLAN24 recurs from code', location: 'l',
        issue: 'i', evidence: 'e', fix: 'f', recurrence_of: code.id }],
    })).rejects.toThrow(/is a CODE finding/);
    const after = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM plan_reviews WHERE plan_id = $1`, [plan.id]);
    expect(after.rows[0].n).toBe(before.rows[0].n); // the pass was NOT recorded
    // The genuinely-absent branch keeps the original message.
    await expect(reviewPost({
      plan: planRel, kind: 'author', verdict: 'blocked', synthesis: 's',
      findings: [{ severity: 'blocker', title: 'PLAN24 recurs from nothing', location: 'l',
        issue: 'i', evidence: 'e', fix: 'f', recurrence_of: '00000000-0000-4000-8000-000000000000' }],
    })).rejects.toThrow(/matches no finding in this project\./);
  });

  it('20a: citations are recorded in the same transaction and bump the cited counter', async () => {
    const { codeFindingAdd, parseFinding } = await import('../code-findings.js');
    const dec = await admin.query<{ id: string }>(
      `INSERT INTO code_decisions (project_id, description, decision_type, still_valid)
       VALUES ($1,'PLAN24 cited decision','architecture',true) RETURNING id`, [projectA]);
    const decId = dec.rows[0].id;
    const r = await codeFindingAdd(SLUG_A, parseFinding(finding({
      title: 'PLAN24 cites a decision', issue: `caused by ${decId}`,
    })));
    const cite = await admin.query<{ n: string; reason: string }>(
      `SELECT count(*)::text AS n, max(reason) AS reason FROM memory_citations
        WHERE citing_kind = 'finding' AND citing_id = $1 AND relation = 'finding_ref'`, [r.id]);
    expect(cite.rows[0].n).toBe('1');
    // Finding a9e34a1f: the persisted reason must NOT claim a plan finding —
    // this helper serves both stores, and the reason is surfaced as evidence.
    expect(cite.rows[0].reason).toBe('Referenced by finding issue/evidence.');
    const bumped = await admin.query<{ c: number }>(
      `SELECT cited_count AS c FROM code_decisions WHERE id = $1`, [decId]);
    expect(bumped.rows[0].c).toBeGreaterThan(0);
  });
});

describe('19: cross-project isolation across ALL SIX read paths (iron rule 2)', () => {
  it('19a: :992 — the bounded single-finding selector', async () => {
    const { findingsQuery } = await import('../plans.js');
    const { codeFindingAdd, parseFinding } = await import('../code-findings.js');
    const mine = await codeFindingAdd(SLUG_A, parseFinding(finding({ title: 'PLAN24 19a mine' })));
    const theirs = await seedForeign({ title: 'PLAN24 19a theirs' });
    const out = await findingsQuery({ finding: mine.id });
    expect(out).toContain('the issue');           // positive: widened
    expect(out).toContain('[code/warning/open]'); // kind-labelled
    await expect(findingsQuery({ finding: theirs })).rejects.toThrow(/no finding .* in this project/);
  });

  it('19b: :1030 — the handoff read', async () => {
    const { findingsQuery } = await import('../plans.js');
    const { codeFindingAdd, parseFinding } = await import('../code-findings.js');
    const mine = await codeFindingAdd(SLUG_A, parseFinding(finding({ title: 'PLAN24 19b mine' })));
    await seedForeign({ title: 'PLAN24 19b theirs' });
    const out = await findingsQuery({});
    expect(out).toContain(mine.id);
    expect(out).toContain('[code/warning/open]');
    expect(out).not.toContain('PLAN24 19b theirs');
  });

  it('19c: :1050 — trigram with the embedder DISABLED', async () => {
    const { findingsQuery } = await import('../plans.js');
    const { codeFindingAdd, parseFinding } = await import('../code-findings.js');
    const mine = await codeFindingAdd(SLUG_A, parseFinding(finding({ title: 'PLAN24 19c distinctive subject' })));
    await seedForeign({ title: 'PLAN24 19c distinctive subject foreign' });
    process.env.MAI_EMBEDDINGS = '0';
    const out = await findingsQuery({ similar_to: 'PLAN24 19c distinctive subject', limit: 10 });
    expect(out).toContain(mine.id);
    expect(out).toContain('[code/warning/open]');
    expect(out).not.toContain('PLAN24 19c distinctive subject foreign');
  });

  it('19d: :1065 — the semantic site, B seeded WITH a current-model vector', async () => {
    const { findingsQuery } = await import('../plans.js');
    const { codeFindingAdd, parseFinding } = await import('../code-findings.js');
    const { setLocalEmbedderForTests, currentEmbeddingModelId } = await import('../embeddings.js');
    setLocalEmbedderForTests(async () => oneHot(11));
    const mine = await codeFindingAdd(SLUG_A, parseFinding(finding({ title: 'PLAN24 19d semantic' })));
    // B is one predicate — the project one — away from being returned.
    await seedForeign({ title: 'PLAN24 19d semantic foreign', embedding: oneHot(11),
      model: currentEmbeddingModelId() });
    const out = await findingsQuery({ similar_to: 'PLAN24 19d semantic', limit: 10 });
    expect(out).toContain(mine.id);
    expect(out).toContain('Similar past findings');
    expect(out).toContain('[code/warning/open]');
    expect(out).not.toContain('PLAN24 19d semantic foreign');
  });

  it('19e: :1093 — the all-row trigram rescue when nothing clears cosine', async () => {
    const { findingsQuery } = await import('../plans.js');
    const { codeFindingAdd, parseFinding } = await import('../code-findings.js');
    const { setLocalEmbedderForTests, currentEmbeddingModelId } = await import('../embeddings.js');
    setLocalEmbedderForTests(async () => oneHot(4));
    const mine = await codeFindingAdd(SLUG_A, parseFinding(finding({ title: 'PLAN24 19e rescued by text' })));
    await seedForeign({ title: 'PLAN24 19e rescued by text foreign', embedding: oneHot(4),
      model: currentEmbeddingModelId() });
    // Query vector orthogonal to every stored vector → zero semantic hits.
    setLocalEmbedderForTests(async () => oneHot(200));
    const out = await findingsQuery({ similar_to: 'PLAN24 19e rescued by text', limit: 10 });
    expect(out).toContain(mine.id);
    expect(out).toContain('text match');
    expect(out).toContain('[code/warning/open]');
    expect(out).not.toContain('PLAN24 19e rescued by text foreign');
  });

  it('19f: :1108 — the stale bucket, queried only when a semantic hit exists', async () => {
    const { findingsQuery } = await import('../plans.js');
    const { codeFindingAdd, parseFinding } = await import('../code-findings.js');
    const { setLocalEmbedderForTests } = await import('../embeddings.js');
    setLocalEmbedderForTests(async () => oneHot(17));
    // A's semantic hit keeps the stale bucket reachable.
    await codeFindingAdd(SLUG_A, parseFinding(finding({ title: 'PLAN24 19f stale subject current' })));
    const staleMine = await codeFindingAdd(SLUG_A,
      parseFinding(finding({ title: 'PLAN24 19f stale subject old' })));
    await admin.query(`UPDATE code_findings SET embedding_model = 'old:model' WHERE id = $1`, [staleMine.id]);
    await seedForeign({ title: 'PLAN24 19f stale subject foreign', embedding: oneHot(17), model: 'old:model' });
    const out = await findingsQuery({ similar_to: 'PLAN24 19f stale subject', limit: 10 });
    expect(out).toContain('not yet re-embedded');
    expect(out).toContain(staleMine.id);
    expect(out).toContain('[code/warning/open]');
    expect(out).not.toContain('PLAN24 19f stale subject foreign');
  });
});
