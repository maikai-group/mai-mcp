// Manual-run schema refresh (decision 8c86dbbe, extended): the SessionEnd hook
// sources the consumer project's .env before calling graph-update, so /exit
// refreshes the live db: layer. An agent running `mai graph update` by hand
// never sources that .env, so MAI_GRAPH_DB_URL is absent and the schema layer
// silently skips. This resolver closes that gap for the PINNED project: it
// reads the dev-DB URL straight from the project's own .env.
//
// Hard safety line: we parse the file and take ONLY the MAI_GRAPH_DB_URL key —
// the consumer .env is never sourced wholesale and process.env is never
// mutated, so a stray MAI_DB_URL there can never redirect a brain write (iron
// rule 5). The URL is returned to the caller for a single introspection run and
// is never persisted to the brain.
import { parse } from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { loadProjectGraphRoots } from '../db.js';

/**
 * Resolve MAI_GRAPH_DB_URL from the project's own .env, scanning the project
 * root (project.path) then each registered repo, then cwd as a last resort.
 * Returns undefined when no .env defines the key. Never throws — a missing or
 * unreadable .env just means "no URL", and the caller falls back to skipping.
 */
export async function resolveConsumerGraphDbUrl(projectId: string): Promise<string | undefined> {
  const candidates = await candidateDirs(projectId);
  for (const dir of candidates) {
    const url = readGraphUrl(path.join(dir, '.env'));
    if (url) return url;
  }
  return undefined;
}

async function candidateDirs(projectId: string): Promise<string[]> {
  try {
    const roots = await loadProjectGraphRoots(projectId);
    return [...new Set([roots.productRoot, ...roots.repos, process.cwd()].map((dir) => path.resolve(dir)))];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Invalid registered graph path|Project metadata\.|Repair with: mai init/.test(message)) throw error;
    return [path.resolve(process.cwd())];
  }
}

/** Read a .env and return its MAI_GRAPH_DB_URL value only. No process.env writes. */
function readGraphUrl(envPath: string): string | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch {
    return undefined; // no .env here
  }
  const url = parse(raw).MAI_GRAPH_DB_URL?.trim();
  return url ? url : undefined;
}
