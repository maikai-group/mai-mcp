#!/usr/bin/env node
import { graphLessonsText, mutateAgentAttachment } from './graph/lessons/service.js';
import { semanticSearchResult } from './graph/semantic/service.js';
import { object as semanticObject, SemanticError } from './graph/semantic/validation.js';
import { requirePinnedSlug } from "./env.js";
import { dbErrorHint } from "./db.js";
import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { CallToolResult } from "@modelcontextprotocol/server";

import {
  unifiedSearch,
  projectRecall,
  timeline,
  decisionAdd,
  decisionUnretract,
  decisionPromote,
  reviewQueue,
  dailyReport,
} from "./decisions.js";
import { lessonAdd, lessonGlobalize } from "./lessons.js";
import { edgeAdd, edgesOf, type EdgeKind, type EdgeRelation } from "./edges.js";
import { violationsRecent } from "./write-violations.js";
import type { CitationKind, NoteTriggerEvidence } from "./write-gate.js";
import { formatCatalogMarkdown, getContext } from "./topics.js";
import { appendNote, appendProgress } from "./notes.js";
import { ideaAdd, ideasReadMarkdown, ideaAgentMove, type IdeaPriority } from "./ideas.js";
import { factAdd, type FactCategory } from "./facts.js";
import type {
  ReviewKind, ReviewVerdict, FindingInput, FindingStatus, FindingSeverity,
} from "./plans.js";
import { prime } from "./prime.js";
import {
  graphFind, graphNeighbors, graphTrace, graphImpact, graphStale, graphQuery, graphDeadCode,
} from "./graph/query.js";
import { specFromInputSchema, validateRequiredParams, rejectMergedParams } from "./validate-params.js";
import { coordination } from "./coordination/index.js";
import { TOOLS } from "./tool-defs.js";
import { finalizeToolResult, mcpBudget, pageBudget } from "./read-budget.js";
import { measureAndRecordMaiShadow } from './token-mai-shadow.js';
import type { MaiShadowDraft } from './token-mai-shadow.js';
import { receiptRoot } from './token-test-shadow.js';
import { pathToFileURL } from "node:url";
import { bindChatIdentity, currentChatIdentity } from './session-identity.js';

const PINNED = requirePinnedSlug();
const maiShadowDrafts = new WeakMap<CallToolResult, MaiShadowDraft>();

// Core tools plus the coordination layer's.
const ALL_TOOLS = [...TOOLS, ...coordination.toolDefs];

// The SDK does not enforce inputSchema — required-param presence is checked
// at dispatch so a misnamed key fails with a self-correcting message instead
// of a TypeError deep in the call path. Specs derive from ALL_TOOLS (core +
// coordination) — deriving from core TOOLS alone would silently drop
// required-param validation for the coordination tools (the 435bf0d class).
const TOOL_PARAM_SPECS = new Map(
  ALL_TOOLS.map((t) => [t.name, specFromInputSchema(t.inputSchema)])
);

// Factory handed to serveStdio: called once per connection (stdio = one, plus a
// discarded server/discover probe). All state it touches is module-level and
// created exactly once — the factory only wires handlers (spec §2.2 singleton
// constraint).
export function buildServer(
  piggyback: typeof coordination.piggybackNudge = coordination.piggybackNudge,
): Server {
  const server = new Server(
    { name: "mai-mcp", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      // Static tool list — changes only with a rebuild. ttl 0 (the default)
      // would advertise "never cache" (spec §2.3).
      cacheHints: { "tools/list": { ttlMs: 3_600_000, cacheScope: "private" } },
    }
  );

  server.setRequestHandler("tools/list", async () => ({ tools: ALL_TOOLS }));

  // THE one true final wire cap (plan 23 R7). Order is load-bearing: the
  // piggyback rider is appended FIRST, then the completed result — nudge
  // included — is capped, so a nudge can never push a read past the budget.
  // handleToolCall converts thrown errors to isError:true, so success and
  // error results both cross this same finalizer; writes are never capped.
  server.setRequestHandler("tools/call", async (request, extra) => {
    const result = await handleToolCall(request, extra.mcpReq.signal);
    // Piggyback rider (coordination facade): the claims heartbeat runs on EVERY
    // call (decision b0fc1969), and appendable results may carry one-line
    // board/claims deltas. The facade owns the full design + gating; the wrapper
    // stays silent-by-contract and never lets a nudge break a tool result.
    let nudge = "";
    try {
      nudge = await piggyback(request.params.name, result.isError === true);
    } catch {
      // nudge failures are silent by contract
    }
    const delivered = finalizeToolResult(request.params.name, result, nudge);
    const draftForResult = maiShadowDrafts.get(result);
    const tool = request.params.name;
    if (draftForResult && (tool === 'mai_findings' || tool === 'mai_plan')) {
      try { await measureAndRecordMaiShadow(receiptRoot(), tool, delivered, draftForResult, nudge); }
      catch { /* shadow telemetry is best effort; delivered is untouched */ }
    }
    return delivered;
  });

  return server;
}

const handleToolCall = async (
  request: { params: { name: string; arguments?: Record<string, unknown> } },
  signal?: AbortSignal,
): Promise<CallToolResult> => {
  const { name, arguments: args } = request.params;
  // The wave-2 graph tools parse their own UNKNOWN payload (plan 39): they are
  // branched BEFORE `args ?? {}` and the required-only validator, so a null,
  // array or primitive payload is refused with a precise message instead of
  // being silently converted into an empty object.
  const rawArguments: unknown = request.params.arguments;
  if (name === 'mai_navigate') {
    try {
      const { navigate } = await import('./navigation/service.js');
      const { renderNavigation } = await import('./navigation/render.js');
      const report = await navigate(rawArguments, signal);
      return { content: [{ type: 'text' as const, text: renderNavigation(report, pageBudget()) }] };
    } catch {
      return { isError: true, content: [{ type: 'text' as const,
        text: 'mai_navigate: invalid input or unavailable navigation service. Check question, intent and bounded optional fields.' }] };
    }
  }
  if (name === "mai_graph_query" || name === "mai_graph_dead_code"
      || name === "mai_user_tasks" || name === "mai_user_tasks_post"
      || name === "mai_receipt_add" || name === "mai_receipts"
      || name === "mai_artifact_put") {
    try {
      let text: string;
      if (name === "mai_graph_query") text = await graphQuery(rawArguments, undefined, pageBudget());
      else if (name === "mai_graph_dead_code") text = await graphDeadCode(rawArguments, undefined, pageBudget());
      else if (name === "mai_receipt_add" || name === "mai_receipts" || name === "mai_artifact_put") {
        const { receiptAdd, receiptsQuery, ReceiptValidationError, ReceiptConflictError } = await import('./receipts.js');
        const { artifactPut, ArtifactValidationError } = await import('./artifacts.js');
        try {
          if (name === "mai_receipt_add") text = JSON.stringify(await receiptAdd(rawArguments));
          else if (name === "mai_receipts") text = JSON.stringify(await receiptsQuery(rawArguments));
          else text = JSON.stringify(await artifactPut(rawArguments));
        } catch (err) {
          if (err instanceof ReceiptConflictError) {
            text = JSON.stringify({ ok: false, error: 'conflict', message: err.message });
          } else if (err instanceof ReceiptValidationError || err instanceof ArtifactValidationError) {
            text = JSON.stringify({ ok: false, error: 'validation', message: err.message });
          } else {
            throw err;
          }
        }
      } else {
        const { operatorTasksPost, operatorTasksText } = await import('./operator-tasks.js');
        text = name === "mai_user_tasks_post"
          ? await operatorTasksPost(rawArguments)
          : await operatorTasksText(rawArguments, mcpBudget());
      }
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const hint = dbErrorHint(err);
      return {
        isError: true,
        content: [{ type: "text" as const, text: `mai-mcp error: ${message}${hint ? `\n${hint}` : ""}` }],
      };
    }
  }
  const params = args ?? {};

  try {
    const spec = TOOL_PARAM_SPECS.get(name);
    if (spec) validateRequiredParams(name, params, spec);
    rejectMergedParams(name, params);

    switch (name) {
      case "mai_search": {
        const p = params as {
          query: string;
          keywords?: string[];
          kind?: "decisions" | "lessons" | "all";
          limit?: number;
        };
        const text = await unifiedSearch({
          query: p.query,
          keywords: p.keywords,
          kind: p.kind,
          limit: p.limit,
          budget: mcpBudget(),
        });
        return { content: [{ type: "text" as const, text }] };
      }

      case "mai_recall": {
        const text = await projectRecall(undefined, mcpBudget());
        return { content: [{ type: "text" as const, text }] };
      }

      case "mai_timeline": {
        const p = params as { days?: number; limit?: number };
        const text = await timeline(p.days ?? 30, p.limit ?? 40);
        return { content: [{ type: "text" as const, text }] };
      }

      case "mai_edges": {
        const p = params as { kind: EdgeKind; id: string };
        const text = await edgesOf({ kind: p.kind, id: p.id });
        return { content: [{ type: "text" as const, text }] };
      }

      case "mai_git_context": {
        const p = params as { task?: string; paths?: string[]; limit?: number };
        const { gitContext } = await import("./git/tools.js");
        return { content: [{ type: "text" as const, text: await gitContext(p) }] };
      }

      case "mai_git_show": {
        const p = params as { hash: string; patch?: boolean; paths?: string[] };
        const { gitShow } = await import("./git/tools.js");
        return { content: [{ type: "text" as const, text: await gitShow(p) }] };
      }

      case "mai_git_trace_decision": {
        const p = params as { decision_id: string };
        const { gitTraceDecision } = await import("./git/tools.js");
        return { content: [{ type: "text" as const, text: await gitTraceDecision(p) }] };
      }

      case "mai_remember": {
        const p = params as {
          citation: CitationKind;
          decision_type: string;
          description: string;
          reasoning?: string;
          alternatives_considered?: string[];
          files_affected?: string[];
          tags?: string[];
          keywords?: string[];
          confidence?: number;
          // 'matt-approved' accepted for one release (aliased in decisionAdd).
          source?: "user-approved" | "matt-approved" | "agent-inferred" | "user-selected";
        };
        const text = await decisionAdd({
          citation: p.citation,
          decisionType: p.decision_type,
          description: p.description,
          reasoning: p.reasoning,
          alternativesConsidered: p.alternatives_considered,
          filesAffected: p.files_affected,
          tags: p.tags,
          keywords: p.keywords,
          confidence: p.confidence,
          source: p.source,
        });
        return { content: [{ type: "text" as const, text }] };
      }

      case "mai_lesson_add": {
        const p = params as {
          rule: string;
          citation: CitationKind;
          context?: string;
          why?: string;
          how_to_apply?: string;
          expected_outcome?: string;
          actual_outcome?: string;
          tags?: string[];
          initial_confidence?: number;
        };
        const text = await lessonAdd({
          rule: p.rule,
          citation: p.citation,
          context: p.context,
          why: p.why,
          howToApply: p.how_to_apply,
          expectedOutcome: p.expected_outcome,
          actualOutcome: p.actual_outcome,
          tags: p.tags,
          initialConfidence: p.initial_confidence,
        });
        return { content: [{ type: "text" as const, text }] };
      }

      case "mai_link": {
        if(params.to_kind==='graph_node'||params.from_kind==='graph_node'||params.relation==='applies_to'){
          const input=semanticObject(params,['from_kind','from_id','to_kind','to_id','relation','note','action','citation']);
          if(input.from_kind!=='lesson'||input.to_kind!=='graph_node'||input.relation!=='applies_to')throw new Error('Unsupported graph link');
          const result=await mutateAgentAttachment({action:input.action??'attach',node_id:input.to_id,lesson_id:input.from_id,reason:input.note,citation:input.citation});
          return {content:[{type:'text' as const,text:JSON.stringify(result)}]};
        }
        if(params.action!==undefined||params.citation!==undefined)throw new Error('Action and citation require a graph lesson attachment');
        const p = params as {
          from_kind: EdgeKind;
          from_id: string;
          to_kind: EdgeKind;
          to_id: string;
          relation: EdgeRelation;
          note?: string;
        };
        const text = await edgeAdd({
          fromKind: p.from_kind,
          fromId: p.from_id,
          toKind: p.to_kind,
          toId: p.to_id,
          relation: p.relation,
          note: p.note,
        });
        return { content: [{ type: "text" as const, text }] };
      }

      case "mai_retract": {
        // PROPOSE-ONLY for agents (spec §4.2, decision aebc6583). Direct
        // retraction survives on the surfaces that already belong to the
        // operator — the dashboard triage, /api/curation/retire, and `mai
        // retract` in the CLI. This arm files a review candidate and changes
        // nothing. Strictly a hardening under iron rule 3.
        const p = params as { decision_id: string; reason: string; propose?: boolean };
        const { retractFromAgent } = await import("./curation.js");
        const text = await retractFromAgent({
          decisionId: p.decision_id,
          reason: p.reason,
          propose: p.propose,
        });
        return { content: [{ type: "text" as const, text }] };
      }

      case "mai_unretract": {
        const p = params as { decision_id: string };
        const text = await decisionUnretract(p.decision_id);
        return { content: [{ type: "text" as const, text }] };
      }

      case "mai_promote": {
        const p = params as { decision_id: string; confidence?: number };
        const text = await decisionPromote(p.decision_id, p.confidence);
        return { content: [{ type: "text" as const, text }] };
      }

      case "mai_globalize": {
        const p = params as { lesson_id: string; reason: string };
        const text = await lessonGlobalize(p.lesson_id, p.reason);
        return { content: [{ type: "text" as const, text }] };
      }

      case "mai_report": {
        const p = params as { days?: number };
        const text = await dailyReport(p.days ?? 1, undefined, mcpBudget());
        return { content: [{ type: "text" as const, text }] };
      }

      case "mai_review": {
        const p = params as { limit?: number };
        const text = await reviewQueue(p.limit ?? 30);
        return { content: [{ type: "text" as const, text }] };
      }

      case "mai_violations": {
        const p = params as { hours?: number; tool_name?: string; kind?: string; limit?: number };
        const text = await violationsRecent({
          hours: p.hours,
          toolName: p.tool_name,
          kind: p.kind,
          limit: p.limit,
          budget: mcpBudget(),
        });
        return { content: [{ type: "text" as const, text }] };
      }

      case "mai_prime": {
        const p = params as { task_description: string; mode?: "summary" | "full"; chat?: unknown };
        if (p.chat !== undefined) bindChatIdentity(p.chat);
        const text = await prime(p.task_description, p.mode ?? "summary", pageBudget());
        const chat = currentChatIdentity();
        return { content: [{ type: "text" as const, text }], ...(chat ? { _meta: { chat_identity: chat } } : {}) };
      }

      case "mai_topics": {
        const text = await formatCatalogMarkdown();
        return { content: [{ type: "text" as const, text }] };
      }

      case "mai_plan": {
        const { planText } = await import("./plans.js");
        const { mcpBudget } = await import("./read-budget.js");
        // Raw params through: planText is the single selector validator.
        let draft: MaiShadowDraft | undefined;
        const text = await planText(params, mcpBudget(), (value) => { draft = value; });
        const result: CallToolResult = { content: [{ type: "text", text }] };
        if (draft) maiShadowDrafts.set(result, draft);
        return result;
      }
      case "mai_review_post": {
        const { reviewPost } = await import("./plans.js");
        const r = await reviewPost({
          plan: String(params.plan),
          plan_sha: params.plan_sha === undefined ? undefined : String(params.plan_sha),
          kind: params.kind as ReviewKind,
          verdict: params.verdict as ReviewVerdict,
          synthesis: String(params.synthesis), // required — validateRequiredParams guarantees presence
          findings: params.findings as FindingInput[],
          finding_count: Number(params.finding_count),
        });
        const ids = r.findings.map((f) => `  ${f.ref ?? "-"} → ${f.id}`).join("\n");
        const warn = r.warnings.length > 0 ? `\n⚠ ${r.warnings.join("\n⚠ ")}` : "";
        const text = `review ${r.review_id} pass ${r.pass} posted (${r.findings.length} finding(s))\n${ids}${warn}`;
        return { content: [{ type: "text" as const, text }] };
      }
      case "mai_findings": {
        const { findingsQuery } = await import("./plans.js");
        const { mcpBudget } = await import("./read-budget.js");
        // findingsQuery remains the single boundary: the selector is NOT
        // validated here, only forwarded.
        let draft: MaiShadowDraft | undefined;
        const text = await findingsQuery({
          plan: params.plan === undefined ? undefined : String(params.plan),
          status: params.status as FindingStatus | undefined,
          severity: params.severity as FindingSeverity | undefined,
          similar_to: params.similar_to === undefined ? undefined : String(params.similar_to),
          finding: params.finding === undefined ? undefined : String(params.finding),
          limit: params.limit === undefined ? undefined : Number(params.limit),
          budget: mcpBudget(),
          shadow: (value) => { draft = value; },
        });
        const result: CallToolResult = { content: [{ type: "text", text }] };
        if (draft) maiShadowDrafts.set(result, draft);
        return result;
      }
      case "mai_finding_update": {
        const { findingUpdate } = await import("./plans.js");
        const text = await findingUpdate({
          finding_id: String(params.finding_id),
          status: params.status as FindingStatus | undefined,
          note: params.note === undefined ? undefined : String(params.note),
          location: params.location === undefined ? undefined : String(params.location),
        });
        return { content: [{ type: "text" as const, text }] };
      }

      case "mai_get_context": {
        const p = params as { topic: string };
        const text = await getContext(p.topic, mcpBudget());
        return { content: [{ type: "text" as const, text }] };
      }

      case "mai_note": {
        const p = params as { type: string; content: string; evidence: NoteTriggerEvidence };
        const paths = await appendNote(p.type, p.content, p.evidence);
        return {
          content: [{ type: "text" as const, text: `Note appended to:\n${paths.map((x) => `- ${x}`).join("\n")}` }],
        };
      }

      case "mai_progress": {
        const p = params as { milestone: string; evidence: NoteTriggerEvidence };
        const paths = await appendProgress(p.milestone, p.evidence);
        return {
          content: [{ type: "text" as const, text: `Note appended to:\n${paths.map((x) => `- ${x}`).join("\n")}` }],
        };
      }

      case "mai_idea": {
        const p = params as { title: string; detail?: string; priority?: IdeaPriority; scope?: 'project' | 'global' };
        const row = await ideaAdd({ title: p.title, detail: p.detail, priority: p.priority, scope: p.scope });
        return { content: [{ type: "text" as const, text: `Idea parked (id=${row.id.slice(0, 8)}, ${row.project_id === null ? 'global' : 'project'} board, priority=${row.priority}).` }] };
      }

      case "mai_ideas": {
        const p = params as { idea_id?: string; scope?: 'project' | 'global' | 'both'; include_closed?: boolean };
        const { mcpBudget } = await import('./read-budget.js');
        const text = await ideasReadMarkdown({
          idea: p.idea_id,
          scope: p.scope,
          includeClosed: p.include_closed,
          budget: mcpBudget(),
        });
        return { content: [{ type: "text" as const, text }] };
      }

      case "mai_idea_move": {
        const p = params as { idea_id: string; to: 'building' | 'shipped'; evidence: string };
        const row = await ideaAgentMove({ ideaId: p.idea_id, to: p.to, evidence: p.evidence });
        return { content: [{ type: "text" as const, text: `Moved '${row.title}' → ${row.status}.` }] };
      }

      case "mai_fact_add": {
        const p = params as { category: FactCategory; fact: string; detail?: string; evidence: string };
        const row = await factAdd(p);
        return { content: [{ type: "text" as const, text: `Fact proposed (id=${row.id.slice(0, 8)}, ${row.category}) — awaiting user review.` }] };
      }

      case "mai_graph_find": {
        const semanticArgs = semanticObject(params, ['query','kind','limit','mode']);
        if (semanticArgs.mode !== undefined && semanticArgs.mode !== 'lexical' && semanticArgs.mode !== 'semantic') throw new SemanticError('Invalid graph search mode');
        if (semanticArgs.mode === 'semantic') {
          const { mode, ...input } = semanticArgs;
          return await semanticSearchResult(input, pageBudget());
        }
        const p = params as { query: string; kind?: string; limit?: number };
        const text = await graphFind({ query: p.query, kind: p.kind, limit: p.limit });
        return { content: [{ type: "text" as const, text }] };
      }

      case "mai_graph_neighbors": {
        if(params.view==='lessons'){
          const input=semanticObject(params,['node_id','view','limit','offset']);
          return {content:[{type:'text' as const,text:await graphLessonsText({node_id:input.node_id,limit:input.limit,offset:input.offset},pageBudget())}]};
        }
        if(params.view!==undefined&&params.view!=='graph')throw new Error('Invalid graph view');
        if(params.limit!==undefined||params.offset!==undefined)throw new Error('Limit and offset are lessons-only');
        const p = params as { node_id: string; depth?: number; relation?: string };
        const text = await graphNeighbors({ nodeId: p.node_id, depth: p.depth, relation: p.relation });
        return { content: [{ type: "text" as const, text }] };
      }

      case "mai_graph_trace": {
        const p = params as { from_node: string; to_node: string };
        const text = await graphTrace({ fromId: p.from_node, toId: p.to_node });
        return { content: [{ type: "text" as const, text }] };
      }

      case "mai_graph_impact": {
        const p = params as { node_id: string; depth?: number };
        const text = await graphImpact({ nodeId: p.node_id, depth: p.depth });
        return { content: [{ type: "text" as const, text }] };
      }

      case "mai_graph_stale": {
        const text = await graphStale({});
        return { content: [{ type: "text" as const, text }] };
      }

      case "mai_shared": {
        const { sharedQuery } = await import("./shares.js");
        const text = await sharedQuery({
          id: params.id === undefined ? undefined : String(params.id),
          limit: params.limit === undefined ? undefined : Number(params.limit),
          part: params.part === undefined ? undefined : Number(params.part),
        }, mcpBudget());
        return { content: [{ type: "text" as const, text }] };
      }

      default: {
        const coordResult = await coordination.handleTool(name, params);
        if (coordResult) return { content: coordResult.content };
        throw new Error(`Unknown tool: ${name}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint = dbErrorHint(err);
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `mai-mcp error: ${message}${hint ? `\n${hint}` : ""}`,
        },
      ],
    };
  }
};

// Import-safe (plan 23 Task 5): the wire test imports this module to reach the
// REAL registered handler, so stdio only starts when run as the entrypoint.
// Plan 15 Task 1: direct build/index.js and no-verb build/entry.js share this
// one exported runner, so the server can never be constructed twice.
export function runStdioServer(): void {
  serveStdio(() => buildServer());
  console.error(`mai-mcp serving project '${PINNED}' on stdio`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStdioServer();
}
