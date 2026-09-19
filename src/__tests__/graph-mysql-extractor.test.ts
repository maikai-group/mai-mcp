/** MySQL dialect of the db extractor — REQUIRES scripts/run-with-disposable-mysql.sh.
 * The suite fails (never skips) without MAI_TEST_MYSQL_URL: a silently-skipped
 * suite is fail-open, the exact defect family this repo's gates exist to catch. */
import { describe, expect, it } from 'vitest';
import { dbExtractor, dialectOf } from '../graph/extractors/db.js';

function requiredUrl(): string {
  const url = process.env.MAI_TEST_MYSQL_URL;
  if (!url) throw new Error('MAI_TEST_MYSQL_URL is required — run via scripts/run-with-disposable-mysql.sh');
  return url;
}

describe('db extractor — dialect routing', () => {
  it('routes postgres and mysql schemes and fails closed on anything else', () => {
    expect(dialectOf('postgresql://u:p@h:5432/d')).toBe('postgres');
    expect(dialectOf('postgres://u:p@h:5432/d')).toBe('postgres');
    expect(dialectOf('mysql://u:p@h:3306/d')).toBe('mysql');
    expect(dialectOf('mysql2://u:p@h:3306/d')).toBe('mysql');
    expect(() => dialectOf('oracle://u:p@h/d')).toThrow(/unsupported graph dev-DB scheme 'oracle:'/);
    expect(() => dialectOf('not a url')).toThrow(/not a parseable URL/);
  });
});

describe('db extractor — MySQL introspection (disposable container)', () => {
  it('emits table + column nodes with pg-shaped qualified names', async () => {
    const out = await dbExtractor.extract({ projectId: 'unused', repoPaths: [], dbUrl: requiredUrl() });
    const tips = out.nodes.find((n) => n.kind === 'table' && n.qualifiedName === 'acmewp.wp_acme_tips');
    expect(tips).toBeDefined();
    expect(tips?.lang).toBe('sql');
    const col = out.nodes.find((n) => n.kind === 'column' && n.qualifiedName === 'acmewp.wp_acme_tips.amount');
    expect(col).toBeDefined();
    expect(col?.metadata).toMatchObject({ data_type: 'decimal', nullable: false });
    expect(
      out.nodes.find((n) => n.kind === 'column' && n.qualifiedName === 'acmewp.wp_acme_tips.note')?.metadata
    ).toMatchObject({ nullable: true });
    expect(
      out.edges.find(
        (e) => e.relation === 'defines' && e.from.qualifiedName === 'acmewp.wp_acme_tips' && e.to.qualifiedName === 'acmewp.wp_acme_tips.amount'
      )
    ).toBeDefined();
  });

  it('emits fk_to at column and table level from KEY_COLUMN_USAGE', async () => {
    const out = await dbExtractor.extract({ projectId: 'unused', repoPaths: [], dbUrl: requiredUrl() });
    expect(
      out.edges.find(
        (e) =>
          e.relation === 'fk_to' &&
          e.from.qualifiedName === 'acmewp.wp_acme_payouts.driver_id' &&
          e.to.qualifiedName === 'acmewp.wp_acme_drivers.id'
      )
    ).toBeDefined();
    expect(
      out.edges.find(
        (e) => e.relation === 'fk_to' && e.from.qualifiedName === 'acmewp.wp_acme_payouts' && e.to.qualifiedName === 'acmewp.wp_acme_drivers'
      )
    ).toBeDefined();
  });

  it('emits zero policy nodes and only the URL-named database', async () => {
    const out = await dbExtractor.extract({ projectId: 'unused', repoPaths: [], dbUrl: requiredUrl() });
    expect(out.nodes.filter((n) => n.kind === 'policy')).toHaveLength(0);
    // Server-wide pollution guard: the harness seeds otherdb.wp_acme_tips on the
    // SAME server; TABLE_SCHEMA = DATABASE() scoping must keep it out.
    expect(out.nodes.find((n) => n.qualifiedName?.startsWith('otherdb.'))).toBeUndefined();
    for (const sys of ['mysql.', 'information_schema.', 'performance_schema.', 'sys.']) {
      expect(out.nodes.find((n) => n.qualifiedName?.startsWith(sys))).toBeUndefined();
    }
    for (const n of out.nodes) expect(n.qualifiedName?.startsWith('acmewp.')).toBe(true);
  });
});
