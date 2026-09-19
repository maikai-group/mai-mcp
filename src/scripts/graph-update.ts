#!/usr/bin/env node
// SessionEnd → incremental graph refresh for the pinned project (spec §4;
// trigger decision 2026-06-12: SessionEnd, not git hooks). Cheap: git-diff
// partitioned splices + a full glue pass. Never crashes teardown — the hook
// wrapper also appends `|| true`.
import '../env.js';
import { pathToFileURL } from 'node:url';
import { getPool, getProjectId } from '../db.js';
import { requirePinnedSlug } from '../env.js';
import { resolveConsumerGraphDbUrl } from '../graph/db-url.js';
import { runGraphUpdate } from '../graph/update.js';

export async function main(): Promise<void> {
  const slug = requirePinnedSlug();
  const projectId = await getProjectId();
  // The hook sources the consumer .env so MAI_GRAPH_DB_URL is normally already
  // here; fall back to reading the project's .env directly if sourcing missed it.
  const dbUrl = process.env.MAI_GRAPH_DB_URL ?? (await resolveConsumerGraphDbUrl(projectId));
  const summary = await runGraphUpdate({ projectId, slug, dbUrl });
  console.log(summary);
  await getPool().end();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`graph-update failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
