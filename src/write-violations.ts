// Origin: forked from the Mai Group's predecessor memory server (private).
import { getPool, getProjectId } from './db.js';
import { budgetRows, MCP_READ_NARROWING, type ReadBudget } from './read-budget.js';

interface ViolationRow {
  id: string;
  tool_name: string;
  violation_kind: string;
  attempted_payload: string;
  preview_results: Array<{ id: string; summary: string; meta?: string }>;
  followup_succeeded: boolean | null;
  rejected_at: Date;
}

/**
 * Query recent violations. Used by mai_violations MCP tool + the digest writer.
 */
export async function violationsRecent(args: {
  hours?: number;
  toolName?: string;
  kind?: string;
  limit?: number;
  projectId?: string;
  budget?: ReadBudget;
}): Promise<string> {
  const pool = getPool();
  const projectId = args.projectId ?? (await getProjectId());
  // Coerce to a bounded integer before interpolating into INTERVAL — the raw
  // param is untrusted (the MCP SDK does not enforce inputSchema at runtime).
  const rawHours = Math.floor(Number(args.hours ?? 24));
  const hours = Number.isFinite(rawHours) ? Math.max(1, Math.min(8760, rawHours)) : 24;
  const limit = args.limit ?? 50;

  const conditions: string[] = ['project_id = $1', `rejected_at > NOW() - INTERVAL '${hours} hours'`];
  const params: unknown[] = [projectId];
  let p = 2;
  if (args.toolName) {
    conditions.push(`tool_name = $${p++}`);
    params.push(args.toolName);
  }
  if (args.kind) {
    conditions.push(`violation_kind = $${p++}`);
    params.push(args.kind);
  }
  params.push(limit);

  const result = await pool.query<ViolationRow>(
    `SELECT id, tool_name, violation_kind, attempted_payload,
            preview_results, followup_succeeded, rejected_at
     FROM write_violations
     WHERE ${conditions.join(' AND ')}
     ORDER BY rejected_at DESC
     LIMIT $${p}`,
    params
  );

  if (result.rows.length === 0) {
    return `No violations in the last ${hours} hours.`;
  }

  const lines: string[] = [
    `# Brain write violations — last ${hours}h (${result.rows.length} entries)`,
    '',
  ];

  const byKind: Record<string, number> = {};
  let recoveredCount = 0;
  for (const r of result.rows) {
    byKind[r.violation_kind] = (byKind[r.violation_kind] ?? 0) + 1;
    if (r.followup_succeeded) recoveredCount++;
  }
  lines.push(`## Summary`);
  lines.push('');
  for (const [kind, count] of Object.entries(byKind)) {
    lines.push(`- ${kind}: ${count}`);
  }
  lines.push(`- Recovered (next write succeeded): ${recoveredCount}/${result.rows.length}`);
  lines.push('');

  lines.push(`## Detail (most recent first)`);
  lines.push('');

  // The heading block above (title + summary + detail label) is identical in
  // both shapes; only the per-violation DETAIL differs. Time/tool/kind/recovery
  // are the headline — payload and preview are the omitted body.
  const heading = lines.join('\n');
  const headlineRows = new Map<ViolationRow, string>(result.rows.map((r) => {
    const ts = r.rejected_at.toISOString().slice(0, 19).replace('T', ' ');
    const status = r.followup_succeeded === true ? '✓ recovered'
      : r.followup_succeeded === false ? '✗ unfollowed' : '? pending';
    return [r, `- **${ts}** \`${r.tool_name}\` — ${r.violation_kind} (${status})`];
  }));

  for (const r of result.rows) {
    const ts = r.rejected_at.toISOString().slice(0, 19).replace('T', ' ');
    const status = r.followup_succeeded === true ? '✓ recovered' : r.followup_succeeded === false ? '✗ unfollowed' : '? pending';
    lines.push(
      `- **${ts}** \`${r.tool_name}\` — ${r.violation_kind} (${status})`
    );
    if (r.attempted_payload) {
      const payloadSnip = r.attempted_payload.slice(0, 100).replace(/\n/g, ' ');
      lines.push(`  payload: \`${payloadSnip}${r.attempted_payload.length > 100 ? '…' : ''}\``);
    }
  }

  return budgetRows(
    args.budget, result.rows, () => lines.join('\n'),
    (r) => headlineRows.get(r) ?? '', heading,
    'violation', MCP_READ_NARROWING.mai_violations,
  );
}
