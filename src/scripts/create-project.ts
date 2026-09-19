#!/usr/bin/env node
// Seed a project row. Temporary CLI until `mai init` (Plan 3).
// Usage: npm run create-project -- <slug> "<name>" <abs-path> [<abs-path-2> ...]
import '../env.js';
import { Pool } from 'pg';
import { poolConfig } from '../db.js';

const [slug, name, ...repoPaths] = process.argv.slice(2);
if (!slug || !name || repoPaths.length === 0) {
  console.error('Usage: create-project <slug> "<name>" <abs-repo-path> [<more paths>...]');
  process.exit(1);
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
  console.error(`Invalid slug '${slug}' — lowercase kebab-case only.`);
  process.exit(1);
}

// poolConfig's default connectionString already resolves MAI_DB_URL ?? the
// local brain — the duplicate literal here predated it.
const pool = new Pool(poolConfig());

const existing = await pool.query('SELECT id FROM projects WHERE slug = $1', [slug]);
if (existing.rows.length > 0) {
  console.error(`Project '${slug}' already exists (${existing.rows[0].id}).`);
  process.exit(1);
}
const result = await pool.query<{ id: string }>(
  `INSERT INTO projects (slug, name, path, metadata)
   VALUES ($1, $2, $3, jsonb_build_object('repos', $4::jsonb))
   RETURNING id`,
  [slug, name, repoPaths[0], JSON.stringify(repoPaths)]
);
console.log(`Created project '${slug}' (${result.rows[0].id}) with ${repoPaths.length} repo(s).`);
await pool.end();
