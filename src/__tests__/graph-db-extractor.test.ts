/** db extractor — introspects mai_brain itself (a real schema, no new infra). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { dbExtractor } from '../graph/extractors/db.js';

const URL = process.env.MAI_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54334/mai_brain';

/** Build a connection URL for a different role against the same host/db. */
function roleUrl(user: string, password: string): string {
  const u = new globalThis.URL(URL);
  return `postgresql://${user}:${password}@${u.host}${u.pathname}`;
}

describe('db extractor', () => {
  it('returns empty output without a URL — never guesses a connection', async () => {
    const out = await dbExtractor.extract({ projectId: 'unused', repoPaths: [] });
    expect(out.nodes).toHaveLength(0);
    expect(out.edges).toHaveLength(0);
  });

  it('emits table + column nodes and defines + fk_to edges', async () => {
    const out = await dbExtractor.extract({ projectId: 'unused', repoPaths: [], dbUrl: URL });
    const table = out.nodes.find((n) => n.kind === 'table' && n.qualifiedName === 'public.projects');
    expect(table).toBeDefined();
    const col = out.nodes.find((n) => n.kind === 'column' && n.qualifiedName === 'public.projects.slug');
    expect(col).toBeDefined();
    expect(
      out.edges.find(
        (e) => e.relation === 'defines' && e.from.qualifiedName === 'public.projects' && e.to.qualifiedName === 'public.projects.slug'
      )
    ).toBeDefined();
    expect(
      out.edges.find(
        (e) =>
          e.relation === 'fk_to' &&
          e.from.qualifiedName === 'public.code_decisions.project_id' &&
          e.to.qualifiedName === 'public.projects.id'
      )
    ).toBeDefined();
    expect(
      out.edges.find(
        (e) => e.relation === 'fk_to' && e.from.qualifiedName === 'public.code_decisions' && e.to.qualifiedName === 'public.projects'
      )
    ).toBeDefined();
  });

  // RLS policy bodies (2026-06-22): the schema graph stores tables/columns/FKs
  // but not the one thing security review actually needs — the policy SQL text
  // (USING / WITH CHECK). The extractor must emit a `policy` node carrying both
  // bodies in metadata and a `secured_by` edge from the table it protects.
  describe('RLS policies', () => {
    const admin = new Pool({ connectionString: URL });
    const TBL = 'public.mai_rls_test';

    beforeAll(async () => {
      await admin.query(`DROP TABLE IF EXISTS ${TBL}`);
      await admin.query(`CREATE TABLE ${TBL} (id int PRIMARY KEY, owner uuid)`);
      await admin.query(`ALTER TABLE ${TBL} ENABLE ROW LEVEL SECURITY`);
      await admin.query(
        `CREATE POLICY "owner_can_read" ON ${TBL} FOR SELECT USING (owner = '00000000-0000-0000-0000-000000000000'::uuid)`
      );
      await admin.query(`CREATE POLICY "owner_must_set" ON ${TBL} FOR INSERT WITH CHECK (owner IS NOT NULL)`);
    });

    afterAll(async () => {
      await admin.query(`DROP TABLE IF EXISTS ${TBL}`);
      await admin.end();
    });

    it('emits policy nodes with USING/WITH CHECK bodies and secured_by edges', async () => {
      const out = await dbExtractor.extract({ projectId: 'unused', repoPaths: [], dbUrl: URL });

      const read = out.nodes.find((n) => n.kind === 'policy' && n.qualifiedName === `${TBL}.owner_can_read`);
      expect(read).toBeDefined();
      expect(read?.metadata?.cmd).toBe('SELECT');
      // The USING body is the SQL text we were missing.
      expect(String(read?.metadata?.using)).toContain('owner');
      expect(read?.metadata?.check).toBeNull();

      const ins = out.nodes.find((n) => n.kind === 'policy' && n.qualifiedName === `${TBL}.owner_must_set`);
      expect(ins).toBeDefined();
      expect(ins?.metadata?.cmd).toBe('INSERT');
      expect(String(ins?.metadata?.check)).toContain('owner');
      expect(ins?.metadata?.using).toBeNull();

      // The table is linked to each policy via a dedicated relation.
      expect(
        out.edges.find(
          (e) => e.relation === 'secured_by' && e.from.qualifiedName === TBL && e.to.qualifiedName === `${TBL}.owner_can_read`
        )
      ).toBeDefined();
    });
  });

  // Regression (consumer dev DB, 2026-06-16): a NON-OWNER read-only role — the recommended
  // production setup — must still see FKs. information_schema.constraint_column_usage
  // only exposes constraints on tables the role OWNS, so the old query returned 0
  // FKs for such a role; the pg_catalog query fixes it. This test reproduces that
  // role and asserts fk_to edges survive (it fails against the pre-fix extractor).
  describe('read-only non-owner role', () => {
    const RO_USER = 'mai_ro_fk_test';
    const RO_PW = 'ro_fk_test_pw';
    const admin = new Pool({ connectionString: URL });

    afterAll(async () => {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${RO_USER}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${RO_USER}'; EXECUTE 'DROP ROLE ${RO_USER}'; END IF; END $$;`
      );
      await admin.end();
    });

    it('sees fk_to edges via a role that owns nothing (SELECT/USAGE only)', async () => {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${RO_USER}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${RO_USER}'; EXECUTE 'DROP ROLE ${RO_USER}'; END IF; END $$;`
      );
      await admin.query(`CREATE ROLE ${RO_USER} LOGIN PASSWORD '${RO_PW}'`);
      await admin.query(`GRANT USAGE ON SCHEMA public TO ${RO_USER}`);
      await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${RO_USER}`);

      const out = await dbExtractor.extract({ projectId: 'unused', repoPaths: [], dbUrl: roleUrl(RO_USER, RO_PW) });

      // Grants let it see tables/columns…
      expect(out.nodes.find((n) => n.kind === 'table' && n.qualifiedName === 'public.projects')).toBeDefined();
      // …and pg_catalog lets it see FKs despite owning nothing (the actual fix).
      expect(
        out.edges.find(
          (e) =>
            e.relation === 'fk_to' &&
            e.from.qualifiedName === 'public.code_decisions.project_id' &&
            e.to.qualifiedName === 'public.projects.id'
        )
      ).toBeDefined();
    });
  });
});
