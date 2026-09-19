// Global user-facts layer (spec 2026-08-06 §B). No project_id BY CONSTRUCTION —
// facts describe the operator, not a project; the global layer is the
// sanctioned cross-project mechanism (decision 6fdeff6c). Agents propose
// (agent-inferred) → the review queue → user-approved facts prime everywhere.
import { getPool } from './db.js';
import { budgetRows, headlineField } from './read-budget.js';

export type FactCategory = 'identity' | 'preference' | 'workflow' | 'tooling';
export const FACT_CATEGORIES: FactCategory[] = ['identity', 'preference', 'workflow', 'tooling'];

export interface FactRow {
  id: string; category: FactCategory; fact: string; detail: string | null;
  source: string; evidence: string; retracted_at: string | null;
  retraction_reason: string | null; created_at: string;
}
interface FactDbRow extends Omit<FactRow, 'created_at' | 'retracted_at'> { created_at: Date; retracted_at: Date | null }
const toRow = (r: FactDbRow): FactRow => ({
  ...r,
  created_at: new Date(r.created_at).toISOString(),
  retracted_at: r.retracted_at ? new Date(r.retracted_at).toISOString() : null,
});

export async function factAdd(args: { category: FactCategory; fact: string; detail?: string; evidence: string }): Promise<FactRow> {
  if (!FACT_CATEGORIES.includes(args.category)) throw new Error(`category must be one of: ${FACT_CATEGORIES.join(', ')}`);
  const fact = (args.fact ?? '').trim();
  const evidence = (args.evidence ?? '').trim();
  if (!fact) throw new Error('fact is required — one sentence');
  if (fact.length > 300) throw new Error('fact exceeds 300 chars — one sentence; context goes in detail');
  if (!evidence) throw new Error('evidence is required — where/how was this learned?');
  const db = getPool();
  const r = await db.query<FactDbRow>(
    `INSERT INTO user_facts (category, fact, detail, evidence) VALUES ($1, $2, $3, $4) RETURNING *`,
    [args.category, fact, args.detail ?? null, evidence]
  );
  return toRow(r.rows[0]);
}

export async function factsList(args?: { includeRetracted?: boolean; source?: string }): Promise<FactRow[]> {
  const db = getPool();
  const where: string[] = [];
  const params: string[] = [];
  if (!args?.includeRetracted) where.push('retracted_at IS NULL');
  if (args?.source) { params.push(args.source); where.push(`source = $${params.length}`); }
  const r = await db.query<FactDbRow>(
    `SELECT * FROM user_facts ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY category, created_at`,
    params
  );
  return r.rows.map(toRow);
}

export async function factPromote(id: string): Promise<FactRow> {
  const db = getPool();
  const r = await db.query<FactDbRow>(
    `UPDATE user_facts SET source = 'user-approved' WHERE id = $1 AND retracted_at IS NULL RETURNING *`, [id]
  );
  if (r.rows.length === 0) throw new Error('fact not found (or retracted)');
  return toRow(r.rows[0]);
}

export async function factRetract(id: string, reason: string): Promise<FactRow> {
  if (!reason.trim()) throw new Error('retraction requires a reason');
  const db = getPool();
  const r = await db.query<FactDbRow>(
    `UPDATE user_facts SET retracted_at = NOW(), retraction_reason = $2 WHERE id = $1 RETURNING *`, [id, reason.trim()]
  );
  if (r.rows.length === 0) throw new Error('fact not found');
  return toRow(r.rows[0]);
}

export async function factUnretract(id: string): Promise<FactRow> {
  const db = getPool();
  const r = await db.query<FactDbRow>(
    `UPDATE user_facts SET retracted_at = NULL, retraction_reason = NULL WHERE id = $1 RETURNING *`, [id]
  );
  if (r.rows.length === 0) throw new Error('fact not found');
  return toRow(r.rows[0]);
}

/** Recovery route for a shortened facts block — the dashboard is where facts
 * are reviewed and approved; there is no agent-facing fact read. */
const FACTS_NARROWING = 'review operator-approved user facts in the dashboard before changing them';

/** Prime block: approved facts only, category-grouped, cap 12 (spec R5).
 * `charBudget` is the prime envelope's 200-character ceiling (plan 38): the
 * producer owns its own fit, so the composer never slices a fixed signal.
 * Omitting it returns today's bytes exactly. */
export async function primeFactsSection(charBudget?: number): Promise<string | null> {
  const db = getPool();
  const r = await db.query<FactDbRow>(
    `SELECT * FROM user_facts WHERE source = 'user-approved' AND retracted_at IS NULL
     ORDER BY category, created_at LIMIT 12`
  );
  if (r.rows.length === 0) return null;
  const renderFull = (rows: readonly FactDbRow[]): string => {
    const lines: string[] = ['## User facts (global — apply in every project)', ''];
    let last = '';
    for (const f of rows) {
      if (f.category !== last) { lines.push(`**${f.category}**`); last = f.category; }
      lines.push(`- ${f.fact}`);
    }
    return lines.join('\n');
  };
  if (charBudget === undefined) return renderFull(r.rows);
  return budgetRows(
    { fullRows: r.rows.length, charBudget }, r.rows, renderFull,
    (f) => `- ${headlineField(f.fact, 120)}`, '## User facts', 'fact', FACTS_NARROWING,
  );
}
