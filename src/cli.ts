#!/usr/bin/env node
// Origin: forked from the Mai Group's predecessor memory server (private).
// mai — zero-LLM-cost CLI over the mai-brain backend functions. Cross-project
// reads/curation via --project (resolved to an id; the MCP layer stays pinned).

import { DB_URL } from "./env.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  dailyReport,
  reviewQueue,
  decisionRetract,
  decisionUnretract,
  decisionPromote,
  unifiedSearch,
  decisionsQuery,
  timeline,
  recentSessions,
  projectRecall,
} from "./decisions.js";
import { lessonGlobalize } from "./lessons.js";
import { edgesOf, type EdgeKind } from "./edges.js";
import { violationsRecent } from "./write-violations.js";
import { formatCatalogMarkdown, getContext } from "./topics.js";
import { appendNote } from "./notes.js";
import type { NoteTriggerEvidence } from "./write-gate.js";
import { resolveProjectId, listProjects, getProjectId } from "./db.js";
import { finishAndExit } from "./exit.js";
import {
  type ParsedArgs,
  flagString,
  flagNumber,
  flagBool,
  requirePositional,
  requireFlag,
  dim,
  green,
  pid,
} from "./cli-util.js";
import { coordination } from "./coordination/index.js";
import { ideasReadMarkdown } from "./ideas.js";

// ---------- argv parsing ----------

export function parseArgs(argv: string[]): ParsedArgs {
  const verb = argv[0] ?? "";
  const rest = argv.slice(1);
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq >= 0) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
      } else {
        const name = token.slice(2);
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[name] = next;
          i++;
        } else {
          flags[name] = true;
        }
      }
    } else if (token.startsWith("-") && token.length > 1) {
      flags[token.slice(1)] = true;
    } else {
      positional.push(token);
    }
  }

  return { verb, positional, flags, argv };
}

// ---------- usage ----------

const USAGE = `${dim("mai — mai-brain CLI (zero-LLM-cost)")}

Usage: mai <command> [args] [flags]

Reads:
  report                          Daily digest        [--days N] [--project S]
  review                          Review queue        [--limit N] [--project S]
  search <query>                  Decisions + lessons [--kind decisions|lessons|all] [--project S]
  decisions                       Decision query      [--type T] [--tags a,b] [--verbose] [--project S]
  timeline                        Sessions+decisions+commits feed [--days N] [--limit N] [--project S]
  sessions                        Recent sessions     [--limit N] [--project S]
  recall                          Full project context dump [--project S]
  edges <kind> <id>               Typed links touching a record [--project S]
  violations                      Recent write-gate rejections [--hours N] [--project S]
  ideas get <uuid-or-prefix>      One complete roadmap card [--project S]
  ${coordination.cliUsageLines.join('\n  ')}
  topics                          Topic catalog (pinned project — use MAI_PROJECT_SLUG=<S> mai topics)
  context <topic>                 Load one topic body (pinned project, as above)

Setup:
  setup [--slug S] [--root PATH] [--harness claude-code|codex|all]
        [--llm claude-code|codex-cli|none] [--embeddings local|none]
        [--yes] [--no-skills]
  skills status|install|upgrade [--target claude|codex|all]
         [--codex-scope repo|user|admin] [--force]
  codex profile add <name> --codex-home <path> [--agent-id <id>] [--launcher-dir <path>]
  codex profile list
  codex profile remove <name>

Curation (write):
  promote <id>                    Agent-inferred → user-approved [--confidence N] [--project S]
  retract <id> --reason "..."     Soft-delete a decision (reason required) [--project S]
  unretract <id>                  Reverse a retraction [--project S]
  globalize <lesson-id> --reason "..."   Move a lesson to the global layer [--project S]
  note <type> "<content>"         Append a tracking note (decision|progress|todo|question; pinned project)
  curation --recount               Rebuild citation counters from source-of-truth rows [--project S]
  curation unpromote --lesson ID --note-file PATH  Remove a promoted rule without deleting its lesson [--project S]
  code-findings add                Record a code-review finding; JSON on stdin or --file <path> [--project S]
  code-findings close <uuid>       Close one: --status <fixed|disputed|accepted-risk|open> --note "..." [--project S]

Cross-project references (operator-only; agents never gain a project param):
  link <target> [--with S | --remove S]   Declare/undeclare which source slugs <target> may see
                                          (updates metadata + rewrites MAI_LINKED_PROJECTS in its repos;
                                          diff+confirm per repo unless --yes; unrelated to the mai_link memory-edge tool)
  share <kind> <id> --to <slug>           Grant ONE artifact (decision|handoff|idea by id/prefix)
  share doc --path <p> --to <slug>        Grant one spec/plan pointer [--repo-root R] [--heading H]
                                          [--note "why"] — run against the SOURCE project
  unshare <share-id> --reason "..."       Revoke (immediate, audited)
  shares                                  List shares [--incoming|--outgoing] [--project S]

Projects:
  projects                        List all projects (slug, name, last active)
  init <slug> --root <path>       Onboard a project (idempotent). [--repo <path>]... [--replace-repos --repo <absolute-path>... [--repo-map <stored-root> <absolute-root>]...] [--postgres <postgresql:// or mysql:// url>] [--draft-topics] [--harness <name>]... [--rules-file <file>] [--llm claude-code|codex-cli|none] [--embeddings local|none] [--yes]
                                  Merges .mcp.json + hooks in each repo, builds the structure graph, optional topic drafts.
  verify <slug>                   Check a project's wiring (.mcp.json, hooks, CLAUDE.md block) [--smoke boots the server]
  upgrade <slug>|--all            Refresh mai-owned config (blocks/hooks/env) to current templates
                                  [--dry-run] [--yes] [--agent-id <id>] [--llm claude-code|codex-cli|none] [--embeddings local|none]  Legacy blocks: diff + confirm.
  ingest --transcript <path>      Ingest one transcript (any harness; format auto-sniffed) [--harness <name>]
  ingest --scan                   Ingest the pinned project's Codex rollouts (~/.codex/sessions) [--since-days N]
                                  Both need MAI_PROJECT_SLUG in the env (e.g. MAI_PROJECT_SLUG=slug mai ingest --scan).
  reingest                        One-off segmentation migration [--harness codex|claude-code|all] [--dry-run]  (env-pinned: MAI_PROJECT_SLUG=<S> mai reingest)
  embed --rebuild                 Re-embed with the current provider: decisions + plan findings + doc
                                  chunks for ALL projects unless --project S, plus the global lessons layer

Dashboard:
  dashboard start                Start the private review dashboard (detached)
  dashboard run [--env-file <path>] [--launch-id <uuid>]
                                 Run supervised in the foreground (for launchd/Task Scheduler);
                                 --env-file builds the server environment ONLY from that private allowlisted file
  dashboard status               Verify launch identity + current build + API health
  dashboard stop                 Stop only the verified managed process
  dashboard persist install      Register the per-user supervisor (LaunchAgent / Task Scheduler) for dashboard run
  dashboard persist status       Supervisor loaded?, run-as user, run level, current build, Health
  dashboard persist restart      Bounce the supervised dashboard through the supervisor
  dashboard persist stop         Stop the supervised dashboard (identity-proven); the supervisor stays installed
  dashboard persist logs         Print the private supervisor/dashboard log paths and tail the dashboard log
  dashboard persist uninstall    Remove exactly com.mai.brain-web / mai-mcp-dashboard; never a foreign job

Maintenance:
  backup                         Atomic brain dump
  backup --commit               Deprecated no-op alias; warns, stays local-only
  backup --push                 Deprecated no-op alias; warns, stays local-only
  backup --log-file <absolute>  Append one redacted line per run (the Windows scheduled task passes it)

Graph:
  graph build                     Full structure-graph extraction [--project S] [--db-url <dev-db-url>] (--postgres = alias; postgresql:// or mysql://)
  graph update                    Incremental refresh (tracked working-tree source) [--project S] [--db-url <dev-db-url>] (--postgres = alias)
  graph watch                     Foreground source watcher [--project S] [--db-url <dev-db-url>] (--postgres = alias)
  graph find <query>              Find nodes by name [--kind K] [--limit N] [--project S]
  graph neighbors <id>            N-hop neighborhood [--depth 1-3] [--relation R] [--project S]
  graph trace <from-id> <to-id>   Shortest path — the full-stack trace [--project S]
  graph impact <id>               Reverse deps + recorded reasoning [--depth 1-3] [--project S]
  graph query '<json>'            Bounded multi-hop query (GraphQueryInput JSON) [--project S]
  graph dead-code                 Dead-code CANDIDATES [--kind function,class,component] [--path-prefix P] [--limit N] [--project S]
  graph stale                     Freshness vs extracted source [--project S]

Flags:
  --project SLUG                  Target a specific project (default: MAI_PROJECT_SLUG)
  -h, --help                      Show this message

Env:
  MAI_DB_URL                      Override Postgres URL (default: 127.0.0.1:54334/mai_brain)
  MAI_PROJECT_SLUG                Pinned project when --project is omitted
  MAI_GRAPH_DB_URL                Dev-DB URL for graph schema introspection — postgresql:// or mysql:// (never stored in the brain)

Exit codes: 0 success, 1 error.
  code-findings is the exception — it reports typed failures so a caller never
  parses prose: 0 ok, 2 validation, 3 finding exists nowhere, 4 project mismatch,
  5 database failure.
`;

// ---------- commands ----------

type CommandFn = (args: ParsedArgs) => Promise<string>;

const cmdReport: CommandFn = async (args) =>
  dailyReport(flagNumber(args, "days") ?? 1, await pid(args));

const cmdReview: CommandFn = async (args) =>
  reviewQueue(flagNumber(args, "limit") ?? 30, await pid(args));

const cmdSearch: CommandFn = async (args) => {
  const query = requirePositional(args, 0, "query");
  const kind = flagString(args, "kind") as "decisions" | "lessons" | "all" | undefined;
  return unifiedSearch({ query, kind, limit: flagNumber(args, "limit"), projectId: await pid(args) });
};

const cmdDecisions: CommandFn = async (args) =>
  decisionsQuery({
    type: flagString(args, "type"),
    tags: flagString(args, "tags")?.split(",").map((t) => t.trim()).filter(Boolean),
    limit: flagNumber(args, "limit"),
    verbose: flagBool(args, "verbose"),
    projectId: await pid(args),
  });

const cmdTimeline: CommandFn = async (args) =>
  timeline(flagNumber(args, "days") ?? 30, flagNumber(args, "limit") ?? 40, await pid(args));

const cmdSessions: CommandFn = async (args) =>
  recentSessions(flagNumber(args, "limit") ?? 10, await pid(args));

const cmdRecall: CommandFn = async (args) => projectRecall(await pid(args));

const cmdEdges: CommandFn = async (args) => {
  const kind = requirePositional(args, 0, "kind") as EdgeKind;
  const id = requirePositional(args, 1, "id");
  return edgesOf({ kind, id, projectId: await pid(args) });
};

const cmdViolations: CommandFn = async (args) =>
  violationsRecent({
    hours: flagNumber(args, "hours"),
    toolName: flagString(args, "tool"),
    kind: flagString(args, "kind"),
    limit: flagNumber(args, "limit"),
    projectId: await pid(args),
  });

const cmdIdeas: CommandFn = async (args) => {
  const subcommand = requirePositional(args, 0, "subcommand");
  if (subcommand !== "get") throw new Error("unknown ideas subcommand — available: get");
  return ideasReadMarkdown({
    idea: requirePositional(args, 1, "idea-id"),
    projectIdOverride: await pid(args),
  });
};

const cmdTopics: CommandFn = async () => formatCatalogMarkdown();

const cmdContext: CommandFn = async (args) => getContext(requirePositional(args, 0, "topic"));

const cmdPromote: CommandFn = async (args) => {
  const id = requirePositional(args, 0, "id");
  return green(await decisionPromote(id, flagNumber(args, "confidence"), await pid(args)));
};

const cmdRetract: CommandFn = async (args) => {
  const id = requirePositional(args, 0, "id");
  const reason = requireFlag(args, "reason");
  return green(await decisionRetract({ decisionId: id, reason, projectId: await pid(args) }));
};

const cmdUnretract: CommandFn = async (args) => {
  const id = requirePositional(args, 0, "id");
  return green(await decisionUnretract(id, await pid(args)));
};

const cmdGlobalize: CommandFn = async (args) => {
  const id = requirePositional(args, 0, "lesson-id");
  const reason = requireFlag(args, "reason");
  return green(await lessonGlobalize(id, reason, await pid(args)));
};

const cmdLink: CommandFn = async (args) => {
  const target = requirePositional(args, 0, "target-slug");
  const { runLink } = await import("./scripts/link.js");
  return green(await runLink({
    targetSlug: target,
    withSlug: flagString(args, "with"),
    removeSlug: flagString(args, "remove"),
    yes: flagBool(args, "yes"),
  }));
};

const cmdShare: CommandFn = async (args) => {
  const kind = requirePositional(args, 0, "kind");
  if (kind !== "decision" && kind !== "doc" && kind !== "handoff" && kind !== "idea") {
    throw new Error("kind must be decision|doc|handoff|idea");
  }
  const { shareCreate } = await import("./shares.js");
  const projectId = (await pid(args)) ?? await getProjectId();
  return green(await shareCreate({
    sourceProjectId: projectId,
    targetSlug: requireFlag(args, "to"),
    kind,
    artifactId: kind === "doc" ? undefined : requirePositional(args, 1, "artifact-id"),
    docPath: kind === "doc" ? requireFlag(args, "path") : undefined,
    docRepoRoot: flagString(args, "repo-root"),
    docHeading: flagString(args, "heading"),
    note: flagString(args, "note"),
    createdVia: "cli",
  }));
};

const cmdUnshare: CommandFn = async (args) => {
  const { shareRevoke } = await import("./shares.js");
  const projectId = (await pid(args)) ?? await getProjectId();
  return green(await shareRevoke({
    shareId: requirePositional(args, 0, "share-id"),
    reason: requireFlag(args, "reason"),
    via: "cli",
    projectId,
  }));
};

const cmdShares: CommandFn = async (args) => {
  const { sharesOperatorView } = await import("./shares.js");
  const direction = flagBool(args, "incoming") ? "in" : flagBool(args, "outgoing") ? "out" : "both";
  const projectId = (await pid(args)) ?? await getProjectId();
  const rows = await sharesOperatorView(projectId, direction);
  if (rows.length === 0) return "No shares in this direction.";
  return rows.map((s) => {
    const arrow = s.direction === "in" ? `← ${s.source_slug}` : `→ ${s.target_slug}`;
    const state = s.status === "revoked" ? "revoked" : (s.live?.status ?? "active");
    const link = s.direction === "in" && s.link_state !== "linked" ? ` · ${s.link_state.toUpperCase()} (mai link)` : "";
    return `- \`${s.id.slice(0, 8)}\` [${s.kind} · ${state}] ${arrow} — ${s.headline}${link}`;
  }).join("\n");
};

const cmdNote: CommandFn = async (args) => {
  const type = requirePositional(args, 0, "type");
  const content = requirePositional(args, 1, "content");
  // CLI is the user's direct (interactive) entry; synthesize minimal evidence so
  // the Cat C gate passes. Agent calls go via MCP and construct evidence themselves.
  const evidence: NoteTriggerEvidence =
    type === "decision"
      ? { type: "decision", user_quote: `mai-cli direct entry: ${content}`.slice(0, 1000) }
      : type === "progress"
        ? { type: "progress", tool_call_id: "mai-cli" }
        : type === "todo"
          ? {
              type: "todo",
              reason: `mai-cli direct entry — deferred work captured for later attention: ${content}`.slice(0, 1000),
            }
          : type === "question"
            ? { type: "question", question: content.slice(0, 1000) }
            : { type: "agent_observation", what_happened: `mai-cli direct entry: ${content}`.slice(0, 1000) };
  const paths = await appendNote(type, content, evidence);
  return green(`Note appended to:\n${paths.map((p) => `- ${p}`).join("\n")}`);
};

const cmdClaims: CommandFn = (args) => coordination.cliClaims(args);

const cmdProjects: CommandFn = async () => {
  const rows = await listProjects();
  if (rows.length === 0) return "No projects yet. Onboard one with `mai init <slug> --root <path>`.";
  const lines = ["# Projects", ""];
  for (const r of rows) {
    const last = r.last_active_at ? new Date(r.last_active_at).toISOString().slice(0, 10) : "?";
    lines.push(`- ${r.slug}${r.name ? ` — ${r.name}` : ""}  ${dim(`(last active ${last})`)}`);
  }
  return lines.join("\n");
};

/** parseArgs collapses repeated flags; re-scan the INJECTED argv for every
 * repeated value (Plan 15 Task 3: one collector, no process.argv rescans). */
function collectRepeatedFlag(argv: readonly string[], name: string): string[] {
  const flag = `--${name}`;
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1]) values.push(argv[i + 1]);
  }
  return values;
}

function collectRepeatedPairs(
  argv: readonly string[],
  name: string,
): Array<{ storedRoot: string; targetRoot: string }> {
  const flag = `--${name}`;
  const values: Array<{ storedRoot: string; targetRoot: string }> = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== flag) continue;
    const storedRoot = argv[i + 1];
    const targetRoot = argv[i + 2];
    if (!storedRoot || !targetRoot || storedRoot.startsWith('--') || targetRoot.startsWith('--')) {
      throw new Error(`${flag} requires adjacent <stored-root> <absolute-root> values`);
    }
    values.push({ storedRoot, targetRoot });
    i += 2;
  }
  return values;
}

const cmdInit: CommandFn = async (args) => {
  const slug = requirePositional(args, 0, "slug");
  const root = requireFlag(args, "root");
  // Every repeated flag derives from the SAME injected argv (Plan 15 Task 3);
  // scalar flags keep coming from parseArgs. No harness keeps the Claude default.
  const argv = args.argv ?? [];
  const repos = collectRepeatedFlag(argv, "repo");
  const { runInit } = await import("./scripts/init.js");
  await runInit({
    slug,
    root,
    repos,
    replaceRepos: flagBool(args, "replace-repos"),
    repoMaps: collectRepeatedPairs(argv, "repo-map"),
    excludes: collectRepeatedFlag(argv, "exclude"),
    postgres: flagString(args, "postgres"),
    draftTopics: flagBool(args, "draft-topics"),
    harnesses: collectRepeatedFlag(argv, "harness"),
    rulesFile: flagString(args, "rules-file"),
    llm: parseLlmFlag(args),
    embeddings: parseEmbeddingsFlag(args),
    yes: flagBool(args, "yes"),
  });
  return ""; // runInit prints its own summary
};

const SKILLS_USAGE =
  'usage: mai skills status|install|upgrade [--target claude|codex|all] [--codex-scope repo|user|admin] [--force]';

/** Plan 15 Task 6: skills lifecycle over Task 2's runtime inventory. `setup`
 * is deliberately NOT here — entry.ts owns that route before cli/env load. */
const cmdSkills: CommandFn = async (args) => {
  const action = args.positional[0];
  if (action !== 'status' && action !== 'install' && action !== 'upgrade') {
    throw new Error(SKILLS_USAGE);
  }
  const target = flagString(args, 'target');
  if (target !== undefined && target !== 'claude' && target !== 'codex' && target !== 'all') {
    throw new Error(`--target must be claude|codex|all\n${SKILLS_USAGE}`);
  }
  const codexScope = flagString(args, 'codex-scope');
  if (codexScope !== undefined && codexScope !== 'repo' && codexScope !== 'user' && codexScope !== 'admin') {
    throw new Error(`--codex-scope must be repo|user|admin\n${SKILLS_USAGE}`);
  }
  const { runSkills, formatSkillResult } = await import('./scripts/skills.js');
  const result = runSkills({ action, target, codexScope, force: flagBool(args, 'force') });
  if (!result.ok) process.exitCode = 1; // runCli's single drain preserves this
  return formatSkillResult(result);
};

const CODEX_PROFILE_USAGE =
  'usage: mai codex profile add <name> --codex-home <path> [--agent-id <id>] [--launcher-dir <path>] | list | remove <name>';

const cmdCodex: CommandFn = async (args) => {
  if (args.positional[0] !== 'profile') throw new Error(CODEX_PROFILE_USAGE);
  const action = args.positional[1];
  if (action !== 'add' && action !== 'list' && action !== 'remove') {
    throw new Error(CODEX_PROFILE_USAGE);
  }
  const { runCodexProfile } = await import('./scripts/codex-profile.js');
  return runCodexProfile({
    action,
    name: args.positional[2],
    codexHome: flagString(args, 'codex-home'),
    agentId: flagString(args, 'agent-id'),
    launcherDir: flagString(args, 'launcher-dir'),
  });
};

const cmdUpgrade: CommandFn = async (args) => {
  const { runUpgrade } = await import("./scripts/upgrade.js");
  const slugs = flagBool(args, "all")
    ? (await listProjects()).map((p) => p.slug)
    : [requirePositional(args, 0, "slug")];
  return runUpgrade({
    slugs,
    dryRun: flagBool(args, "dry-run"),
    yes: flagBool(args, "yes"),
    agentId: flagString(args, "agent-id"),
    llm: parseLlmFlag(args),
    embeddings: parseEmbeddingsFlag(args),
  });
};

const cmdVerify: CommandFn = async (args) => {
  const slug = requirePositional(args, 0, "slug");
  const { verifyProject, formatVerification } = await import("./scripts/verify.js");
  const v = await verifyProject(slug, { smoke: flagBool(args, "smoke") });
  if (!v.ok) {
    process.stderr.write(formatVerification(v) + "\n");
    process.exitCode = 1; // main()'s single finishAndExit preserves this
    return "";
  }
  const { llmProviderStatus, detectLLMProviderId } = await import("./llm/provider.js");
  const { claudeBinaryAvailable } = await import("./llm/claude-code.js");
  const { codexBinaryAvailable } = await import("./llm/codex-cli.js");
  const { CC_HINT, CODEX_HINT } = await import("./scripts/llm-consent.js");
  const llmLines = [`llm: ${llmProviderStatus()}`];
  if (detectLLMProviderId() === null && process.env.MAI_LLM_PROVIDER === undefined) {
    if (claudeBinaryAvailable()) llmLines.push(CC_HINT);
    if (codexBinaryAvailable()) llmLines.push(CODEX_HINT);
  }
  const { embeddingsStatus, currentEmbeddingModelId } = await import("./embeddings.js");
  llmLines.push(`embeddings: ${embeddingsStatus()}`);
  const embModelId = currentEmbeddingModelId();
  if (embModelId) {
    const { getPool, resolveProjectId } = await import("./db.js");
    // No `embedding IS NOT NULL` clause (pass-4 W7): never-embedded rows are
    // the population most in need of the hint — this count matches EXACTLY
    // what runEmbedRebuild would process for this scope.
    const stale = await getPool().query<{ dec: string; les: string }>(
      `SELECT (SELECT count(*) FROM code_decisions
                WHERE embedding_model IS DISTINCT FROM $1 AND project_id = $2) AS dec,
              (SELECT count(*) FROM lessons
                WHERE embedding_model IS DISTINCT FROM $1) AS les`,
      [embModelId, await resolveProjectId(slug)]
    );
    const dec = Number(stale.rows[0].dec);
    const les = Number(stale.rows[0].les);
    if (dec + les > 0) {
      llmLines.push(
        `  ↳ not embedded with the current model: ${dec} decision(s) in ${slug}, ` +
          `${les} lesson(s) (global) — run: mai embed --rebuild --project ${slug}`
      );
    }
  }
  return green(formatVerification(v)) + "\n" + llmLines.join("\n");
};

const cmdIngest: CommandFn = async (args) => {
  const transcript = flagString(args, "transcript");
  if (transcript) {
    const { readRolloutMeta } = await import("./capture/codex.js");
    const { getCaptureAdapter } = await import("./capture/adapter.js");
    const { ingestTranscriptSegmented } = await import("./capture/segment-ingest.js");
    const { basename } = await import("node:path");
    const meta = await readRolloutMeta(transcript);
    const harness = flagString(args, "harness") ?? (meta ? "codex" : "claude-code");
    const adapter = getCaptureAdapter(harness);
    const transcriptId = meta?.sessionId ?? basename(transcript).replace(/\.jsonl$/, "");
    const report = await ingestTranscriptSegmented(adapter, {
      path: transcript,
      transcriptId,
      harness,
      cwd: meta?.cwd ?? null,
    });
    return `ingested ${report.segmentsPersisted} segment(s) (${report.status}${report.fullReingest ? ", full" : ""})`;
  }
  if (flagBool(args, "scan")) {
    const { runCodexScan } = await import("./scripts/ingest-codex.js");
    const sinceDays = Number(flagString(args, "since-days") ?? "7");
    return await runCodexScan({ sinceDays: Number.isFinite(sinceDays) ? sinceDays : 7 });
  }
  throw new Error(
    "Usage: mai ingest --transcript <path> [--harness <name>] | mai ingest --scan [--since-days N] (requires MAI_PROJECT_SLUG in env)"
  );
};

function isHarnessChoice(s: string): s is import("./scripts/reingest.js").ReingestOpts["harness"] {
  return s === "codex" || s === "claude-code" || s === "all";
}

function parseLlmFlag(args: ParsedArgs): 'claude-code' | 'codex-cli' | 'none' | undefined {
  const v = flagString(args, 'llm');
  if (v === undefined) return undefined;
  if (v === 'claude-code' || v === 'codex-cli' || v === 'none') return v;
  throw new Error(`--llm must be claude-code|codex-cli|none, got '${v}'`);
}

function parseEmbeddingsFlag(args: ParsedArgs): 'local' | 'none' | undefined {
  const v = flagString(args, 'embeddings');
  if (v === undefined) return undefined;
  if (v === 'local' || v === 'none') return v;
  throw new Error(`--embeddings must be local|none, got '${v}'`);
}

/** Read the whole of stdin. Content arrives as JSON, never as shell arguments
 * (plan 24 ambiguity 4): finding text quotes real source, and the writer is a
 * subagent composing a command line. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

const cmdCodeFindings: CommandFn = async (args) => {
  const sub = args.positional[0];
  const slug = typeof args.flags.project === 'string' ? args.flags.project : '';
  const {
    codeFindingAdd, codeFindingClose, parseFinding, CodeFindingError, EXIT,
  } = await import('./code-findings.js');
  try {
    if (sub === 'add') {
      // Bare `--file` parses to boolean true (cli.ts:55-62) and would otherwise
      // fall silently back to stdin. Borrows the `=== true` shape cmdEmbed uses
      // for `--project` at cli.ts:407-413 (pass-1 W5). Never infer input from a
      // malformed flag.
      if (args.flags.file === true) {
        throw new CodeFindingError(EXIT.VALIDATION, '--file needs a path: --file <path>');
      }
      const fileFlag = typeof args.flags.file === 'string' ? args.flags.file : '';
      // readFileSync throws ENOENT/EACCES/EISDIR, none of them a
      // CodeFindingError — so without this the catch below maps a typo'd path
      // to exit 5, DATABASE FAILURE, for an error the database never saw
      // (pass-4 W4). Same species as the non-UUID plan_id defect fixed in
      // pass 1: every reachable throw on the validation path must carry a
      // typed code, or R4's promise is only true for the paths we remembered.
      // Without this, `mai code-findings add --project x` typed by a human — or
      // by a subagent that forgot the pipe — blocks forever: the for-await ends
      // only at EOF, and exit.ts's watchdog is armed inside finishAndExit,
      // which never runs while the command is still awaiting stdin (pass-1 W5).
      if (!fileFlag && process.stdin.isTTY) {
        throw new CodeFindingError(EXIT.VALIDATION, 'pipe JSON on stdin or pass --file <path>');
      }
      let raw: string;
      if (fileFlag) {
        try {
          raw = fs.readFileSync(fileFlag, 'utf8');
        } catch (e) {
          throw new CodeFindingError(
            EXIT.VALIDATION,
            `could not read --file ${fileFlag}: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      } else {
        raw = await readStdin();
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new CodeFindingError(EXIT.VALIDATION, 'stdin/--file did not contain valid JSON');
      }
      return JSON.stringify(await codeFindingAdd(slug, parseFinding(parsed)));
    }
    if (sub === 'close') {
      const id = args.positional[1] ?? '';
      const status = typeof args.flags.status === 'string' ? args.flags.status : '';
      const note = typeof args.flags.note === 'string' ? args.flags.note : '';
      if (!id) throw new CodeFindingError(EXIT.VALIDATION, 'usage: mai code-findings close <uuid> --status S --note "..." --project SLUG');
      return JSON.stringify(await codeFindingClose(slug, id, status, note));
    }
    throw new CodeFindingError(EXIT.VALIDATION, 'usage: mai code-findings add|close [...] --project <slug>');
  } catch (err) {
    if (err instanceof CodeFindingError) {
      process.exitCode = err.code;
      return JSON.stringify({ error: err.message, exit: err.code });
    }
    process.exitCode = EXIT.DB;
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err), exit: EXIT.DB });
  }
};

const CURATION_USAGE =
  'Usage: mai curation --recount [--project <slug>] | ' +
  'mai curation unpromote --lesson <id> --note-file <path> [--project <slug>]';

const cmdCuration: CommandFn = async (args) => {
  const sub = args.positional[0];
  if (flagBool(args, 'recount')) {
    if (
      args.positional.length !== 0 ||
      args.flags.lesson !== undefined ||
      args.flags['note-file'] !== undefined
    ) {
      throw new Error(CURATION_USAGE);
    }
    if (args.flags.project === true) {
      throw new Error('--project needs a slug: mai curation --recount --project <slug>');
    }
    const { curationRecount } = await import('./curation.js');
    return curationRecount(await pid(args));
  }

  if (sub !== 'unpromote' || args.positional.length !== 1) {
    throw new Error(CURATION_USAGE);
  }
  const lessonId = typeof args.flags.lesson === 'string' ? args.flags.lesson.trim() : '';
  if (!lessonId) {
    throw new Error('--lesson needs an id: mai curation unpromote --lesson <id>');
  }
  const noteFile =
    typeof args.flags['note-file'] === 'string' ? args.flags['note-file'].trim() : '';
  if (!noteFile) {
    throw new Error('--note-file needs a path: mai curation unpromote --note-file <path>');
  }
  if (args.flags.project === true) {
    throw new Error('--project needs a slug: mai curation unpromote --project <slug>');
  }
  let raw: string;
  try {
    raw = fs.readFileSync(noteFile, 'utf8');
  } catch (err) {
    throw new Error(
      `could not read --note-file ${noteFile}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const note = raw.trim();
  if (!note) throw new Error('--note-file must contain a non-empty note');
  const { curationUnpromote } = await import('./curation.js');
  return curationUnpromote({ lessonId, note, projectId: await pid(args) });
};

const cmdEmbed: CommandFn = async (args) => {
  if (!flagBool(args, "rebuild")) {
    throw new Error("Usage: mai embed --rebuild [--project <slug>]");
  }
  // Bare `--project` parses to `true` (cli.ts:56 `flags[name] = true`), and
  // flagString returns undefined for non-strings — so a typo'd `--project`
  // silently selects the WIDEST scope and rewrites every project's vectors
  // (pass-7 W3). Never infer scope from a malformed flag.
  if (args.flags.project === true) {
    throw new Error("--project needs a slug: mai embed --rebuild --project <slug>");
  }
  const { runEmbedRebuild } = await import("./scripts/embed-rebuild.js");
  return runEmbedRebuild({
    projectSlug: flagString(args, "project"),
    onProgress: (line) => console.log(line), // CLI owns stdout; tests pass nothing
  });
};

const cmdReingest: CommandFn = async (args) => {
  const { runReingest } = await import("./scripts/reingest.js");
  const harness = flagString(args, "harness") ?? "all";
  if (!isHarnessChoice(harness)) {
    throw new Error(`--harness must be codex|claude-code|all, got '${harness}'`);
  }
  const dryRun = flagBool(args, "dry-run");
  const rep = await runReingest({ harness, dryRun });
  const lines = [...rep.lines];
  lines.push(
    `reingest: ${rep.scanned} transcript(s), ${rep.supersededRows} old row(s) superseded, ` +
      `${dryRun ? rep.segmentsPlanned : rep.segmentsPersisted} segment(s)` +
      (rep.skippedMigrated ? `, ${rep.skippedMigrated} already migrated (skipped)` : "") +
      `, ${rep.llmCalls} LLM call(s)` +
      (rep.curatedPreserved ? `, ${rep.curatedPreserved} curated decision(s) preserved` : "") +
      (dryRun ? " [dry-run — nothing written]" : "")
  );
  return lines.join("\n");
};

const cmdGraph: CommandFn = async (args) => {
  const sub = requirePositional(args, 0, "subcommand");

  if (sub === "lessons") return (await import('./graph/lessons/cli.js')).lessonCli(args);
  if (sub === "semantic") {
    const { semanticCli } = await import('./graph/semantic/cli.js');
    return semanticCli(args);
  }

  if (sub === "build" || sub === "update" || sub === "watch") {
    const slug = flagString(args, "project") ?? process.env.MAI_PROJECT_SLUG;
    if (!slug) {
      throw new Error("no project selected — pass --project <slug> (or set MAI_PROJECT_SLUG). Run `mai projects` to list.");
    }
    const projectId = await resolveProjectId(slug);
    // The dev-DB URL is for the PINNED project only. Honoring it for an
    // arbitrary --project would introspect the wrong dev DB into that project's
    // graph — cross-project pollution, the one unforgivable bug here. Resolution
    // order, all gated to the pinned slug: explicit --db-url (--postgres alias) > MAI_GRAPH_DB_URL
    // in the env (e.g. the SessionEnd hook) > the project's own .env. The last
    // one lets a hand-run `mai graph update` refresh the schema like /exit does,
    // instead of silently skipping because the agent's shell never sourced .env.
    const isPinned = slug === process.env.MAI_PROJECT_SLUG;
    // --db-url is the dialect-neutral surface (plan 34); --postgres survives as
    // an alias so nothing breaks.
    let dbUrl = flagString(args, "db-url") ?? flagString(args, "postgres") ?? (isPinned ? process.env.MAI_GRAPH_DB_URL : undefined);
    if (!dbUrl && isPinned) {
      const { resolveConsumerGraphDbUrl } = await import("./graph/db-url.js");
      dbUrl = await resolveConsumerGraphDbUrl(projectId);
    }
    if (sub === "watch") {
      const { runGraphWatch } = await import("./graph/watch-cli.js");
      return runGraphWatch({ projectId, slug, dbUrl });
    }
    if (sub === "update") {
      const { runGraphUpdate } = await import("./graph/update.js");
      return runGraphUpdate({ projectId, slug, dbUrl });
    }
    const { runGraphBuild } = await import("./graph/build.js");
    return runGraphBuild({ projectId, slug, dbUrl });
  }

  const q = await import("./graph/query.js");
  const projectId = await pid(args);
  switch (sub) {
    case "find":
      return q.graphFind({
        query: requirePositional(args, 1, "query"),
        kind: flagString(args, "kind"),
        limit: flagNumber(args, "limit"),
        projectId,
      });
    case "neighbors":
      return q.graphNeighbors({
        nodeId: requirePositional(args, 1, "node-id"),
        depth: flagNumber(args, "depth"),
        relation: flagString(args, "relation"),
        projectId,
      });
    case "query": {
      // The CLI parses JSON and hands the result to the SAME validator the MCP
      // path uses — as `unknown`, with no budget, so the operator sees it all.
      const raw = requirePositional(args, 1, "query-json");
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch (err) {
        throw new Error(`graph query needs one JSON argument: ${err instanceof Error ? err.message : String(err)}`);
      }
      return q.graphQuery(payload, projectId);
    }
    case "dead-code": {
      const kinds = flagString(args, "kind");
      const pathPrefix = flagString(args, "path-prefix");
      // The RAW flag value reaches the shared normalizer: a non-finite or
      // fractional count must be REFUSED, never silently defaulted away.
      const limit = flagString(args, "limit");
      const payload: Record<string, unknown> = {};
      if (kinds !== undefined) payload.kinds = kinds.split(",").map((k) => k.trim());
      if (pathPrefix !== undefined) payload.path_prefix = pathPrefix;
      if (limit !== undefined) payload.limit = Number(limit);
      return q.graphDeadCode(payload, projectId);
    }
    case "trace":
      return q.graphTrace({
        fromId: requirePositional(args, 1, "from-id"),
        toId: requirePositional(args, 2, "to-id"),
        projectId,
      });
    case "impact":
      return q.graphImpact({
        nodeId: requirePositional(args, 1, "node-id"),
        depth: flagNumber(args, "depth"),
        projectId,
      });
    case "stale":
      return q.graphStale({ projectId });
    default:
      throw new Error(`unknown graph subcommand '${sub}' — available: build, update, watch, find, neighbors, trace, impact, stale`);
  }
};

interface DashboardCommandResult { code: number; text: string; }
function finishDashboardCommand(result: DashboardCommandResult): string {
  process.exitCode = result.code;
  return result.text;
}
function dashboardUsage(message: string): string {
  return finishDashboardCommand({ code: 2, text: `usage: ${message}` });
}

const DASHBOARD_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
type DashboardPersistenceAction = 'install' | 'status' | 'restart' | 'stop' | 'logs' | 'uninstall';
function isDashboardPersistenceAction(value: string | undefined): value is DashboardPersistenceAction {
  return value === 'install' || value === 'status' || value === 'restart'
    || value === 'stop' || value === 'logs' || value === 'uninstall';
}
const cmdDashboard: CommandFn = async (args) => {
  const raw = args.argv?.slice(1) ?? [];
  const action = raw[0];
  if (!['start', 'run', 'status', 'stop', 'persist'].includes(action ?? '')) {
    return dashboardUsage('mai dashboard <start|run|status|stop|persist>');
  }
  if (action === 'persist') {
    const persistAction = raw[1];
    if (!isDashboardPersistenceAction(persistAction)) {
      return dashboardUsage('mai dashboard persist <install|status|restart|stop|logs|uninstall> [--checkout-root <absolute>]');
    }
    const tail = raw.slice(2);
    let checkoutRoot: string | undefined;
    if (tail.length > 0) {
      if (tail.length !== 2 || tail[0] !== '--checkout-root' || !path.isAbsolute(tail[1])) {
        return dashboardUsage(`mai dashboard persist ${persistAction} [--checkout-root <absolute>]`);
      }
      checkoutRoot = tail[1];
    }
    if (persistAction === 'install') {
      if (process.platform === 'win32' && checkoutRoot === undefined) {
        return dashboardUsage('mai dashboard persist install --checkout-root <absolute>');
      }
      checkoutRoot ??= path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    }
    const persistence = await import('./scripts/dashboard-persistence.js');
    const result = await persistence.runPersistence(persistAction, {
      platform: process.platform,
      env: process.env,
      ...(checkoutRoot === undefined ? {} : { checkoutRoot }),
    });
    return finishDashboardCommand({ code: result.ok ? 0 : 1, text: result.text });
  }
  if (action !== 'run') {
    if (raw.length !== 1) return dashboardUsage(`mai dashboard ${action}`);
    const controller = await import('./scripts/dashboard.js');
    if (action === 'start') return finishDashboardCommand({ code: 0, text: await controller.dashboardStart() });
    if (action === 'stop') return finishDashboardCommand({ code: 0, text: await controller.dashboardStop() });
    const status = await controller.dashboardStatus();
    return finishDashboardCommand({ code: status.ok ? 0 : 1, text: status.text });
  }
  const options: { envFile?: string; launchId?: string } = {};
  const seen = new Set<string>();
  for (let index = 1; index < raw.length; index += 2) {
    const flag = raw[index];
    const value = raw[index + 1];
    if ((flag !== '--env-file' && flag !== '--launch-id') || value === undefined || value.startsWith('--')
        || seen.has(flag) || index + 2 < raw.length && !raw[index + 2].startsWith('--')) {
      return dashboardUsage('mai dashboard run [--env-file <path>] [--launch-id <uuid>]');
    }
    seen.add(flag);
    if (flag === '--launch-id') {
      if (!DASHBOARD_UUID.test(value)) return dashboardUsage('mai dashboard run [--env-file <path>] [--launch-id <uuid>]');
      options.launchId = value.toLowerCase();
    } else {
      if (!path.isAbsolute(value)) return dashboardUsage('mai dashboard run [--env-file <path>] [--launch-id <uuid>]');
      let stat: fs.Stats;
      try { stat = fs.lstatSync(value); } catch { return dashboardUsage('mai dashboard run [--env-file <path>] [--launch-id <uuid>]'); }
      if (!stat.isFile() || stat.isSymbolicLink()) return dashboardUsage('mai dashboard run [--env-file <path>] [--launch-id <uuid>]');
      options.envFile = value;
    }
  }
  const { dashboardRun } = await import('./scripts/dashboard.js');
  const code = await dashboardRun(options);
  return finishDashboardCommand({ code, text: '' });
};

/** `mai backup` — local-only atomic dump. The checkout root is the installed
 * package root (this module's parent), never cwd; the deprecated aliases are
 * consumed by backupMain's argv boundary; a nonzero code rides runCli's drain. */
const cmdBackup: CommandFn = async (args) => {
  const raw = args.argv?.slice(1) ?? [];
  const { backupMain, defaultBackupIO } = await import('./scripts/backup.js');
  const result = await backupMain(raw, {
    io: defaultBackupIO(),
    checkoutRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    dbUrl: DB_URL,
  });
  for (const line of result.stderr) process.stderr.write(`${line}\n`);
  process.exitCode = result.code;
  return result.stdout.join('\n');
};

const COMMANDS: Record<string, CommandFn> = {
  report: cmdReport,
  review: cmdReview,
  search: cmdSearch,
  decisions: cmdDecisions,
  timeline: cmdTimeline,
  sessions: cmdSessions,
  recall: cmdRecall,
  edges: cmdEdges,
  violations: cmdViolations,
  ideas: cmdIdeas,
  claims: cmdClaims,
  topics: cmdTopics,
  context: cmdContext,
  promote: cmdPromote,
  retract: cmdRetract,
  unretract: cmdUnretract,
  globalize: cmdGlobalize,
  link: cmdLink,
  share: cmdShare,
  unshare: cmdUnshare,
  shares: cmdShares,
  note: cmdNote,
  projects: cmdProjects,
  init: cmdInit,
  skills: cmdSkills,
  codex: cmdCodex,
  verify: cmdVerify,
  upgrade: cmdUpgrade,
  ingest: cmdIngest,
  reingest: cmdReingest,
  "code-findings": cmdCodeFindings,
  curation: cmdCuration,
  embed: cmdEmbed,
  graph: cmdGraph,
  dashboard: cmdDashboard,
  backup: cmdBackup,
};

// ---------- main ----------

/** Dispatch only — lifecycle (drain/exit) is runCli's job (Plan 15 Task 3). */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  if (!args.verb || args.verb === "--help" || args.verb === "-h" || flagBool(args, "help") || flagBool(args, "h")) {
    process.stdout.write(USAGE);
    return;
  }

  const fn = COMMANDS[args.verb];
  if (!fn) {
    process.stderr.write(`error: unknown command '${args.verb}'. Run 'mai --help' for usage.\n`);
    // pre-flight: no pool, no pipeline — bare exit is safe
    process.exit(1);
  }

  const out = await fn(args);
  if (out) process.stdout.write(out + (out.endsWith("\n") ? "" : "\n"));
}

/** The ONE lifecycle-owning CLI entry: dispatches through main, preserves an
 * already-set nonzero exit code, and routes success AND error through a single
 * finishAndExit drain (Plan 15 Task 3). Never starts a second drain. */
export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    await main(argv);
    // Preserve a non-zero code a command already recorded (review B2): calling
    // finishAndExit(0) unconditionally would reset process.exitCode back to 0
    // and report a FAILED `mai verify` as success.
    await finishAndExit(typeof process.exitCode === "number" ? process.exitCode : 0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${message}\n`);
    // Drain on the ERROR path too: without this a failed command that had
    // embedded would abort and report 134, masking the real exit 1.
    await finishAndExit(1);
  }
}

// Guarded module execution: direct `node build/cli.js` runs the full
// lifecycle; importing this module (entry.ts verb branch, tests) does not.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCli();
}
