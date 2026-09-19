import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const DB = process.env.MAI_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54334/mai_brain';
const admin = new Pool({ connectionString: DB });
const SERVER = fileURLToPath(new URL('../../build/index.js', import.meta.url));
let projectId = '';

function firstText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const first: unknown = content[0];
  if (typeof first !== 'object' || first === null || !('text' in first)) return '';
  return typeof first.text === 'string' ? first.text : '';
}

beforeAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug='plan22-mcp-dispatch'`);
  const p = await admin.query<{ id: string }>(
    `INSERT INTO projects(slug,name) VALUES ('plan22-mcp-dispatch','Plan22 MCP') RETURNING id`);
  projectId = p.rows[0].id;
});

afterAll(async () => {
  await admin.query(`DELETE FROM projects WHERE slug='plan22-mcp-dispatch'`);
  await admin.end();
});

describe('mai_retract built MCP dispatch', () => {
  it('rejects omitted propose, then propose:true files one candidate without retracting', async () => {
    const d = await admin.query<{ id: string }>(
      `INSERT INTO code_decisions(project_id,decision_type,description)
       VALUES ($1,'arch','dispatch target') RETURNING id`, [projectId]);
    const id = d.rows[0].id;
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      MAI_DB_URL: DB,
      MAI_PROJECT_SLUG: 'plan22-mcp-dispatch',
      MAI_AGENT_ID: 'tester@vitest',
      MAI_LLM_SUMMARY: '0',
    };
    const client = new Client({ name: 'curation-dispatch-test', version: '0.0.0' });
    await client.connect(new StdioClientTransport({ command: 'node', args: [SERVER], env }));
    try {
      const rejected = await client.callTool({
        name: 'mai_retract', arguments: { decision_id: id, reason: 'agent evidence' },
      });
      expect(firstText(rejected.content)).toMatch(/propose: true/);
      const afterReject = await admin.query<{ still_valid: boolean }>(
        `SELECT still_valid FROM code_decisions WHERE id=$1`, [id]);
      expect(afterReject.rows[0].still_valid).toBe(true);
      expect((await admin.query(
        `SELECT id FROM curation_candidates WHERE project_id=$1 AND target_id=$2`, [projectId, id]
      )).rows).toHaveLength(0);

      const proposed = await client.callTool({
        name: 'mai_retract', arguments: { decision_id: id, reason: 'agent evidence', propose: true },
      });
      expect(firstText(proposed.content)).toMatch(/PROPOSED/);
      const final = await admin.query<{ still_valid: boolean }>(
        `SELECT still_valid FROM code_decisions WHERE id=$1`, [id]);
      expect(final.rows[0].still_valid).toBe(true);
      expect((await admin.query(
        `SELECT id FROM curation_candidates WHERE project_id=$1 AND target_id=$2 AND status='open'`,
        [projectId, id]
      )).rows).toHaveLength(1);
    } finally {
      await client.close();
    }
  }, 20_000);
});
