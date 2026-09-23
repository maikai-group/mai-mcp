#!/usr/bin/env node
import { createLessonGetHandlers, createLessonPostHandlers } from './graph/lessons/http.js';
import { createSemanticGetHandlers, createSemanticPostHandlers } from './graph/semantic/http.js';
import { SemanticError } from './graph/semantic/validation.js';
// Origin: forked from the Mai Group's predecessor memory server (private).
// mai-brain-web — Node http server exposing the mai-brain over JSON + a static PWA.
// Multi-project: every data route resolves ?project=<slug> (no pinned fallback —
// the dashboard always knows its selected project). The MCP pinning guarantee is
// unaffected; this surface is operator-facing only.

import "./env.js";
import { createProviderHandler, withProviderRoutes } from './providers/http.js';
import { ProviderStore } from './providers/store.js';
import { credentialConfigured, credentialRevision, resolveCredential, resolveJevConfig, routingSnapshot } from './providers/runtime.js';
import { maiStateRoot } from './platform/paths.js';
import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  dailyReport,
  reviewQueue,
  reviewQueueRows,
  activityRows,
  unifiedSearch,
  decisionsQuery,
  decisionsSimilar,
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
import { resolveProjectId, listProjects, closePool } from "./db.js";
import { armExitWatchdog } from "./exit.js";
import { makeShutdown } from "./web-shutdown.js";
import {
  ideasBoard,
  ideaAddForProject,
  ideaOperatorMove,
  ideaOperatorReorder,
  ideaOperatorUpdate,
  IDEA_PRIORITIES,
  IDEA_SCOPES,
  IDEA_STATUSES,
  type IdeaPriority,
  type IdeaScope,
  type IdeaStatus,
} from "./ideas.js";
import { settingsGetAll, settingsSet, settingsValidate } from "./settings.js";
import { factsList } from "./facts.js";
import { createReviewPostHandlers, ReviewClientError } from './web-review-handlers.js';
import { createShareGetHandlers, createSharePostHandlers, ShareClientError } from './web-share-handlers.js';
import {
  createUserTaskGetHandlers, createUserTaskPostHandlers, UserTaskClientError,
} from './web-user-task-handlers.js';
import { graphFindRows, graphNeighborsMermaid, graphNeighborsRows, graphTrace, graphImpact, graphStale } from "./graph/query.js";
import { graphOverview } from "./graph/overview.js";
import { graphFull } from "./graph/full.js";

// ---------- Config ----------

const DEFAULT_PORT = 6601;
const DEFAULT_BIND = "127.0.0.1";

const port = Number(process.env.MAI_BRAIN_WEB_PORT ?? DEFAULT_PORT);
const bind = process.env.MAI_BRAIN_WEB_BIND ?? DEFAULT_BIND;
const token = process.env.MAI_BRAIN_WEB_TOKEN ?? "";
const launchId = process.env.MAI_BRAIN_WEB_LAUNCH_ID ?? "";
const requireToken = bind !== "127.0.0.1";

const here = path.dirname(fileURLToPath(import.meta.url));
// build/web-server.js → mai-mcp → mai-mcp/frontend/dist (the built Vite app)
const WEB_DIR = path.join(here, "..", "frontend", "dist");
const NOT_BUILT_MESSAGE = "dashboard not built — run: npm run build:web\n";

// ---------- Startup validation ----------

if (requireToken && !token) {
  process.stderr.write(
    `error: MAI_BRAIN_WEB_BIND is '${bind}' (non-localhost) but MAI_BRAIN_WEB_TOKEN is empty.\n` +
      `       Set MAI_BRAIN_WEB_TOKEN to a strong secret (openssl rand -hex 32) before exposing the server.\n`
  );
  // pre-flight: no pool, no pipeline — bare exit is safe
  process.exit(1);
}

// ---------- Response helpers ----------

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function sendText(res: http.ServerResponse, status: number, text: string): void {
  const data = Buffer.from(text, "utf8");
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": data.length,
  });
  res.end(data);
}

// ---------- Error classes ----------

class ClientError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---------- Query-param parsers ----------

function str(url: URL, name: string): string | undefined {
  const v = url.searchParams.get(name);
  return v === null || v === "" ? undefined : v;
}

function num(url: URL, name: string): number | undefined {
  const v = url.searchParams.get(name);
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function bool(url: URL, name: string): boolean {
  const v = url.searchParams.get(name);
  return v === "1" || v === "true";
}

function csv(url: URL, name: string): string[] | undefined {
  const v = url.searchParams.get(name);
  if (!v) return undefined;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve the request's project id from ?project=<slug>. REQUIRED — the
 * dashboard always sends its selection; there is no pinned fallback here.
 */
async function project(url: URL): Promise<string> {
  const slug = str(url, "project");
  if (!slug) throw new ClientError("missing required query param: project");
  try {
    return await resolveProjectId(slug);
  } catch {
    throw new ClientError(`unknown project: ${slug}`, 404);
  }
}

// ---------- GET handlers ----------

type GetPayload = Record<string, unknown>;
type GetHandler = (url: URL) => Promise<GetPayload>;

const GET_HANDLERS: Record<string, GetHandler> = {
  ...createSemanticGetHandlers(),
  ...createLessonGetHandlers(),
  ...createShareGetHandlers(project),
  ...createUserTaskGetHandlers(project),
  "/api/launcher-health": async () => ({ pid: process.pid, launch_id: launchId }),
  "/api/projects": async () => ({ projects: await listProjects() }),

  "/api/report": async (url) => ({
    markdown: await dailyReport(num(url, "days") ?? 1, await project(url)),
  }),

  "/api/review": async (url) => {
    const projectId = await project(url);
    const limit = num(url, "limit") ?? 30;
    if (str(url, "format") === "json") {
      return { rows: await reviewQueueRows(limit, projectId) };
    }
    return { markdown: await reviewQueue(limit, projectId) };
  },

  "/api/activity": async (url) => ({
    rows: await activityRows(num(url, "days") ?? 7, num(url, "limit") ?? 30, await project(url)),
  }),

  "/api/search": async (url) => {
    const q = str(url, "q");
    if (!q) throw new ClientError("missing required query param: q");
    const kind = str(url, "kind") as "decisions" | "lessons" | "all" | undefined;
    return {
      markdown: await unifiedSearch({ query: q, kind, limit: num(url, "limit"), projectId: await project(url) }),
    };
  },

  "/api/decisions": async (url) => ({
    markdown: await decisionsQuery({
      type: str(url, "type"),
      tags: csv(url, "tags"),
      verbose: bool(url, "verbose"),
      limit: num(url, "limit"),
      projectId: await project(url),
    }),
  }),

  "/api/similar": async (url) => {
    const q = str(url, "q");
    if (!q) throw new ClientError("missing required query param: q");
    return {
      markdown: await decisionsSimilar({
        query: q,
        limit: num(url, "limit"),
        minScore: num(url, "min_score"),
        projectId: await project(url),
      }),
    };
  },

  "/api/timeline": async (url) => ({
    markdown: await timeline(num(url, "days") ?? 30, num(url, "limit") ?? 40, await project(url)),
  }),

  "/api/sessions": async (url) => ({
    markdown: await recentSessions(num(url, "limit") ?? 10, await project(url)),
  }),

  "/api/recall": async (url) => ({
    markdown: await projectRecall(await project(url)),
  }),

  "/api/edges": async (url) => {
    const kind = str(url, "kind") as EdgeKind | undefined;
    const id = str(url, "id");
    if (!kind || !id) throw new ClientError("missing required query params: kind, id");
    return { markdown: await edgesOf({ kind, id, projectId: await project(url) }) };
  },

  "/api/violations": async (url) => ({
    markdown: await violationsRecent({
      hours: num(url, "hours"),
      toolName: str(url, "tool"),
      kind: str(url, "kind"),
      limit: num(url, "limit"),
      projectId: await project(url),
    }),
  }),

  // Topics are per-pinned-slug filesystem paths (contextDir reads MAI_PROJECT_SLUG
  // at import). The web server shows topics for the slug it was started with (if any).
  "/api/topics": async () => ({ markdown: await formatCatalogMarkdown() }),

  "/api/context": async (url) => {
    const t = str(url, "t");
    if (!t) throw new ClientError("missing required query param: t");
    return { markdown: await getContext(t) };
  },

  "/api/graph/find": async (url) => {
    const q = str(url, "q");
    if (!q) throw new ClientError("missing required query param: q");
    const nodes = await graphFindRows({ query: q, kind: str(url, "kind"), limit: num(url, "limit"), projectId: await project(url) });
    return { nodes };
  },

  "/api/graph/neighbors": async (url) => {
    const id = str(url, "id");
    if (!id) throw new ClientError("missing required query param: id");
    const projectId = await project(url);
    if (str(url, "format") === "json") {
      const neighbors = await graphNeighborsRows({
        nodeId: id,
        depth: num(url, "depth"),
        relation: str(url, "relation"),
        projectId,
      });
      if (!neighbors) throw new ClientError(`graph node not found: ${id}`, 404);
      return { neighbors };
    }
    return {
      markdown: await graphNeighborsMermaid({
        nodeId: id,
        depth: num(url, "depth"),
        relation: str(url, "relation"),
        projectId,
      }),
    };
  },

  "/api/graph/overview": async (url) => ({
    overview: await graphOverview(await project(url)),
  }),
  "/api/graph/full": async (url) => ({
    full: await graphFull(await project(url)),
  }),

  "/api/graph/trace": async (url) => {
    const from = str(url, "from");
    const to = str(url, "to");
    if (!from || !to) throw new ClientError("missing required query params: from, to");
    return { markdown: await graphTrace({ fromId: from, toId: to, projectId: await project(url) }) };
  },

  "/api/graph/impact": async (url) => {
    const id = str(url, "id");
    if (!id) throw new ClientError("missing required query param: id");
    return { markdown: await graphImpact({ nodeId: id, depth: num(url, "depth"), projectId: await project(url) }) };
  },

  "/api/graph/stale": async (url) => ({ markdown: await graphStale({ projectId: await project(url) }) }),

  "/api/ideas": async (url) => ({
    rows: await ideasBoard({
      scope: (str(url, "scope") as "project" | "global" | "both" | undefined) ?? "both",
      includeClosed: str(url, "closed") === "1",
      projectIdOverride: await project(url),
    }),
  }),

  // Facts are global by construction — no ?project= here.
  "/api/facts": async (url) => ({
    rows: await factsList({ includeRetracted: str(url, "retracted") === "1" }),
  }),

  // Operator settings are global by construction too — no ?project= here.
  "/api/settings": async () => ({ settings: await settingsGetAll() }),
};

// ---------- JSON body parsing ----------

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return reject(new ClientError("request body must be a JSON object"));
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new ClientError("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function bodyString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new ClientError(`missing required field: ${key}`);
  }
  return v;
}

function bodyStringOpt(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") {
    throw new ClientError(`field '${key}' must be a string`);
  }
  return v;
}

function bodyNumberOpt(body: Record<string, unknown>, key: string): number | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ClientError(`field '${key}' must be a number`);
  }
  return v;
}

function bodyStringArray(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ClientError(`field '${key}' must be an array of strings`);
  }
  return value;
}

function bodyBoolean(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (typeof value !== 'boolean') throw new ClientError(`field '${key}' must be a boolean`);
  return value;
}

function bodyIdeaStatus(body: Record<string, unknown>, key: string): IdeaStatus {
  const value = bodyString(body, key);
  const status = IDEA_STATUSES.find((candidate) => candidate === value);
  if (!status) throw new ClientError(`field '${key}' must be a valid idea status`);
  return status;
}

function bodyIdeaScope(body: Record<string, unknown>, key: string): IdeaScope {
  const value = bodyString(body, key);
  const scope = IDEA_SCOPES.find((candidate) => candidate === value);
  if (!scope) throw new ClientError(`field '${key}' must be project, global, or both`);
  return scope;
}

/** Optional string; '' means "clear" and maps to null. Used for idea detail. */
function bodyStringOrNull(body: Record<string, unknown>, key: string): string | null | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") throw new ClientError(`field '${key}' must be a string`);
  return v === "" ? null : v;
}

function bodyIdeaPriorityOpt(body: Record<string, unknown>, key: string): IdeaPriority | undefined {
  const v = bodyStringOpt(body, key);
  if (v === undefined) return undefined;
  const priority = IDEA_PRIORITIES.find((candidate) => candidate === v);
  if (!priority) throw new ClientError(`field '${key}' must be a valid idea priority`);
  return priority;
}

/** Writable scopes only — 'both' is a read filter, never a stored scope. */
function bodyIdeaWriteScopeOpt(body: Record<string, unknown>, key: string): "project" | "global" | undefined {
  const v = bodyStringOpt(body, key);
  if (v === undefined) return undefined;
  if (v !== "project" && v !== "global") throw new ClientError(`field '${key}' must be project or global`);
  return v;
}

// ---------- POST handlers ----------

type PostHandler = (body: Record<string, unknown>, url: URL) => Promise<GetPayload>;

const POST_HANDLERS: Record<string, PostHandler> = {
  ...createSemanticPostHandlers(),
  ...createLessonPostHandlers(),
  ...createReviewPostHandlers(project),
  ...createSharePostHandlers(project),
  ...createUserTaskPostHandlers(project),

  "/api/ideas": async (body, url) => ({
    // Web adds are the operator's — source 'user'. Project comes from ?project=.
    idea: await ideaAddForProject(
      {
        title: bodyString(body, "title"),
        detail: bodyStringOpt(body, "detail"),
        priority: bodyStringOpt(body, "priority") as IdeaPriority | undefined,
        scope: bodyStringOpt(body, "scope") as "project" | "global" | undefined,
        source: "user",
      },
      await project(url)
    ),
  }),

  "/api/ideas/move": async (body) => ({
    idea: await ideaOperatorMove({
      ideaId: bodyString(body, "idea_id"),
      status: bodyStringOpt(body, "status") as IdeaStatus | undefined,
      priority: bodyStringOpt(body, "priority") as IdeaPriority | undefined,
      sortOrder: bodyNumberOpt(body, "sort_order"),
    }),
  }),

  "/api/ideas/reorder": async (body, url) => ({
    idea: await ideaOperatorReorder({
      ideaId: bodyString(body, "idea_id"),
      status: bodyIdeaStatus(body, "status"),
      scope: bodyIdeaScope(body, "scope"),
      includeClosed: bodyBoolean(body, "include_closed"),
      expectedIds: bodyStringArray(body, "expected_ids"),
      orderedIds: bodyStringArray(body, "ordered_ids"),
      projectId: await project(url),
    }),
  }),

  "/api/ideas/update": async (body, url) => ({
    idea: await ideaOperatorUpdate({
      ideaId: bodyString(body, "idea_id"),
      title: bodyStringOpt(body, "title"),
      detail: bodyStringOrNull(body, "detail"),
      priority: bodyIdeaPriorityOpt(body, "priority"),
      scope: bodyIdeaWriteScopeOpt(body, "scope"),
      projectId: await project(url),
    }),
  }),

  // Settings writes are registry-validated at the route so bad input is a 400,
  // not a 500; settingsSet validates again (defense in depth).
  "/api/settings": async (body) => {
    const key = bodyString(body, "key");
    const error = settingsValidate(key, body.value);
    if (error) throw new ClientError(error);
    await settingsSet(key, body.value);
    return { settings: await settingsGetAll() };
  },

  "/api/globalize": async (body, url) => ({
    message: await lessonGlobalize(bodyString(body, "lesson_id"), bodyString(body, "reason"), await project(url)),
  }),

  // note is pinned-only (writes to the server's MAI_PROJECT_SLUG tracking dir).
  "/api/note": async (body) => {
    const type = bodyString(body, "type");
    const content = bodyString(body, "content");
    const evidence: NoteTriggerEvidence =
      type === "decision"
        ? { type: "decision", user_quote: `mai-web direct entry: ${content}`.slice(0, 1000) }
        : type === "progress"
          ? { type: "progress", tool_call_id: "mai-web" }
          : type === "todo"
            ? {
                type: "todo",
                reason: `mai-web direct entry — deferred work captured for later attention: ${content}`.slice(0, 1000),
              }
            : type === "question"
              ? { type: "question", question: content.slice(0, 1000) }
              : { type: "agent_observation", what_happened: `mai-web direct entry: ${content}`.slice(0, 1000) };
    const paths = await appendNote(type, content, evidence);
    return { message: `Note appended to:\n${paths.map((p) => `- ${p}`).join("\n")}` };
  },
};

// ---------- Request dispatch ----------

async function handleGenericRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  // Token check — skipped when binding to 127.0.0.1
  if (requireToken && req.headers["x-mai-brain-token"] !== token) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? bind}`);

  if (url.pathname.startsWith("/api/")) {
    if (req.method === "GET") {
      const handler = GET_HANDLERS[url.pathname];
      if (!handler) {
        sendJson(res, 404, { ok: false, error: `unknown endpoint: ${url.pathname}` });
        return;
      }
      try {
        const payload = await handler(url);
        sendJson(res, 200, { ok: true, ...payload });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = err instanceof ClientError || err instanceof ReviewClientError
          || err instanceof ShareClientError || err instanceof SemanticError || err instanceof UserTaskClientError ? err.status : 500;
        if (status >= 500) {
          process.stderr.write(`[mai-brain-web] 500 on ${url.pathname}: ${msg}\n`);
        }
        sendJson(res, status, { ok: false, error: msg });
      }
      return;
    }
    if (req.method === "POST") {
      const handler = POST_HANDLERS[url.pathname];
      if (!handler) {
        sendJson(res, 404, { ok: false, error: `unknown endpoint: ${url.pathname}` });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const payload = await handler(body, url);
        sendJson(res, 200, { ok: true, ...payload });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = err instanceof ClientError || err instanceof ReviewClientError
          || err instanceof ShareClientError || err instanceof SemanticError || err instanceof UserTaskClientError ? err.status : 500;
        if (status >= 500) {
          process.stderr.write(`[mai-brain-web] 500 on ${url.pathname}: ${msg}\n`);
        }
        sendJson(res, status, { ok: false, error: msg });
      }
      return;
    }

    sendJson(res, 405, { ok: false, error: "method not allowed" });
    return;
  }

  await serveStatic(url.pathname, res);
}

// ---------- Static file serving ----------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function serveStatic(pathname: string, res: http.ServerResponse): Promise<void> {
  const relPath = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.resolve(WEB_DIR, "." + relPath);

  // Path-traversal guard: resolved must stay inside WEB_DIR.
  if (!resolved.startsWith(WEB_DIR + path.sep) && resolved !== WEB_DIR) {
    sendText(res, 403, "forbidden");
    return;
  }

  const ext = path.extname(resolved);
  const mime = MIME[ext] ?? "application/octet-stream";
  const cache = ext === ".html" ? "no-cache" : "public, max-age=3600";

  try {
    const data = await readFile(resolved);
    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": data.length,
      "Cache-Control": cache,
    });
    res.end(data);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") {
      // A missing index.html means the frontend hasn't been built yet — guide
      // the operator instead of a bare 404.
      if (relPath === "/index.html") {
        sendText(res, 503, NOT_BUILT_MESSAGE);
        return;
      }
      sendText(res, 404, "not found");
      return;
    }
    throw err;
  }
}

// ---------- Server ----------

const providerRoot = maiStateRoot();
const providerStore = new ProviderStore(providerRoot);
const providerRuntime = {credentialConfigured,credentialRevision,resolveCredential,resolveJevConfig,routingSnapshot};
const handleRequest = withProviderRoutes(createProviderHandler({store:providerStore,runtime:providerRuntime,
  resolveProject:resolveProjectId,bind,port:()=>port,token:()=>token}),handleGenericRequest);

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[mai-brain-web] handler error: ${message}\n`);
    try {
      sendJson(res, 500, { ok: false, error: message });
    } catch {
      // ignore — response may already be committed
    }
  });
});

server.listen(port, bind, () => {
  const lines = [
    `mai-brain-web listening on http://${bind}:${port}`,
    `  projects:  all (select per request via ?project=<slug>)`,
    `  db:        ${process.env.MAI_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54334/mai_brain"}`,
    `  auth:      ${requireToken ? "token required (x-mai-brain-token header)" : "none (localhost only)"}`,
  ];
  if (requireToken) {
    lines.push(
      `  WARNING:   non-localhost bind — accessible to anything on network. Ensure firewall/tunnel is configured.`
    );
  }
  process.stdout.write(lines.join("\n") + "\n");
});

// ---------- Shutdown ----------

const shutdown = makeShutdown({
  server,
  arm: armExitWatchdog,
  closePool,
  log: (message) => process.stdout.write(message),
});

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
