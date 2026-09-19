#!/usr/bin/env node
import '../env.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPool } from '../db.js';
import {
  parseCommitMap,
  remapGitHistory,
  type CommitRewrite,
  type RemapResult,
} from '../git/remap.js';
import { syncGit } from '../git/sync.js';

interface Args {
  map: string;
  repo: string;
  reason: string;
  apply: boolean;
}

export interface RemapCliDependencies {
  readMap(file: string): Promise<string>;
  remap(repo: string, mappings: CommitRewrite[], reason: string): Promise<RemapResult>;
  sync(options: { full: boolean; failFast: boolean }): Promise<string>;
}

const DEFAULT_DEPS: RemapCliDependencies = {
  readMap: (file) => readFile(file, 'utf8'),
  remap: remapGitHistory,
  sync: syncGit,
};

function parseArgs(argv: string[]): Args {
  let map = '';
  let repo = '';
  let reason = '';
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--map' || arg === '--repo' || arg === '--reason') {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      if (arg === '--map') map = value;
      else if (arg === '--repo') repo = value;
      else reason = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!map || !repo || !reason) {
    throw new Error(
      'Usage: remap-git-history --map <filter-repo commit-map> --repo <registered cleaned repo> --reason <text> [--apply]'
    );
  }
  return { map: path.resolve(map), repo: path.resolve(repo), reason, apply };
}

export async function run(
  argv: string[],
  dependencies: RemapCliDependencies = DEFAULT_DEPS
): Promise<string> {
  const args = parseArgs(argv);
  const mappings = parseCommitMap(await dependencies.readMap(args.map));
  const rewritten = mappings.filter(
    (row) => row.newHash !== null && row.newHash !== row.oldHash
  ).length;
  const pruned = mappings.filter((row) => row.newHash === null).length;
  const unchanged = mappings.length - rewritten - pruned;
  if (!args.apply) {
    return `DRY RUN: ${mappings.length} mapping(s): ${rewritten} rewritten, ${pruned} pruned, ${unchanged} unchanged; no database writes (pass --apply)`;
  }

  const result = await dependencies.remap(args.repo, mappings, args.reason);
  let sync: string;
  try {
    sync = await dependencies.sync({ full: true, failFast: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `PARTIAL: SHA remap committed, but the required full Git sync failed (${detail}). ` +
        'Repair the registered repo and rerun the same --apply command; remapping is idempotent.'
    );
  }
  return [
    `APPLIED: ${result.mappings} mapping(s): ${result.rewritten} rewritten, ${result.pruned} pruned, ${result.unchanged} unchanged`,
    `brain: ${result.indexed} indexed alias/tombstone row(s), ${result.unindexed} unindexed mapping(s), ${result.commitRowsUpdated} commit hash(es) updated`,
    `references: ${result.graphNodesUpdated} graph node(s), ${result.findingRefsUpdated} code-finding SHA field(s), ${result.preservedCommitEdges} commit edge(s) preserved`,
    sync,
  ].join('\n');
}

async function main(): Promise<void> {
  try {
    console.log(await run(process.argv.slice(2)));
  } catch (error) {
    console.error(
      `mai-remap-git-history: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  } finally {
    await getPool().end().catch(() => {});
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) await main();
