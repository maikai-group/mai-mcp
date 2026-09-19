// src/coordination-api.ts — the compile-time seam between the core and the
// coordination layer. One implementation ships; the seam keeps them decoupled.
import type { ParsedArgs } from './cli-util.js';
import type { Tool } from "@modelcontextprotocol/server";
import type { PoolClient } from 'pg';
import type { PreparedPrimeText } from './prime-budget.js';

export interface ToolTextResult {
  content: Array<{ type: 'text'; text: string }>;
}

// Match the existing tools-array element type in src/index.ts (name/description/
// inputSchema). index.ts's tool literals use `type: 'object' as const` in their
// inputSchema, so the schema field is a Record<string, unknown> here.
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Tool["inputSchema"];
}

// Concrete hook shape shared with init.ts (its local HookCmd/HookEntry become
// imports of these) — a Record<string, unknown> entry would force a cast at the
// merge/upgrade call sites, which the iron rules disallow.
export interface HookCmd {
  type: string;
  command: string;
}
export interface HookEntryShape {
  matcher?: string;
  hooks: HookCmd[];
}
export interface InitHookEntry {
  event: string;
  entry: HookEntryShape;
}

/** Refs a server-derived plan-thread note may carry (plan 21 §3.4). Assignable
 * to the board's own BoardRef. `plan_reviews` is deliberately NOT a ref kind:
 * validateRefs resolves only decision/commit/session against REF_TABLE, and
 * extending REF_TABLE is out of scope for this build. */
export interface PlanThreadRef {
  kind: 'commit' | 'file';
  id?: string;
  path?: string;
}

export interface PlanThreadNote {
  delivery: 'posted' | 'suppressed';
  messageId: string;
  /** Canonical thread root — persisted even on suppression so a recreated
   * plan row can self-heal to its surviving derived history. */
  threadRoot: string;
}

export interface CoordinationFacade {
  /** Tool definitions to append to the MCP tools list. */
  readonly toolDefs: ToolDef[];
  /** Handle a coordination tool call; null = not ours, caller falls through. */
  handleTool(name: string, params: Record<string, unknown>): Promise<ToolTextResult | null>;
  /** Prime/startup-briefing sections (board, claims). Empty strings are skipped by callers. */
  primeSections(projectId: string): Promise<string[]>;
  /** The same two sections PREPARED once (plan 38): each carries its complete
   * string, its truthful structural minimum, and a pure character-only
   * renderer. Empty demand means the source has no rows at all. */
  primePreparedSections(projectId: string): Promise<{ board: PreparedPrimeText; claims: PreparedPrimeText }>;
  /** Compact one-line counts for the slim startup briefing. */
  primeCounts(projectId: string): Promise<string>;

  /** Post ONE server-derived note into a plan's board thread, superseding that
   *  thread's newest OPEN server-derived message (plan 21 §3.6). Human rows
   *  remain open. Pass `threadId: null` for the
   *  first note and persist the returned `threadRoot`. `delivery='suppressed'`
   *  means the canonical thread's newest derived note — or this process's
   *  provenance-matched note — already carries this exact body (the repost
   *  trap, §4.5). Core must reach this ONLY through
   *  the facade: importing a coordination submodule from core bypasses the seam. */
  postPlanThreadNote(args: {
    threadId: string | null;
    body: string;
    refs: PlanThreadRef[];
  }, client: PoolClient): Promise<PlanThreadNote>;

  /** Close a stale server-derived lifecycle prompt without posting a finding-
   * transition note. Exact prefix/suffix matching protects verdict/human rows. */
  retractPlanThreadNote(args: {
    threadId: string | null;
    bodyPrefix: string;
    bodySuffixes: string[];
  }, client: PoolClient): Promise<boolean>;
  /** Piggyback rider. MUST run its heartbeat on EVERY call — including error
   *  results (decision b0fc1969). Returns the nudge text to append, or '' when
   *  isError or toolName is one of the four coordination tools OR mai_prime. */
  piggybackNudge(toolName: string, isError: boolean): Promise<string>;
  /** `mai claims` CLI command body (same parsed-args shape the CLI registry passes). */
  cliClaims(args: ParsedArgs): Promise<string>;
  /** Usage lines injected into the CLI help text. */
  readonly cliUsageLines: string[];
  /** Extra hook entries for `mai init`'s settings.json install. */
  initHookEntries(slug: string, maiRoot: string): InitHookEntry[];
  /** Hook script filenames `mai verify` must find installed. */
  readonly verifyHookScripts: string[];
}
