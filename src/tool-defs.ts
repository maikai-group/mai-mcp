// Side-effect-free tool definitions — extracted from index.ts so tests can
// import the tool surface without triggering index.ts's import-time
// requirePinnedSlug()/server construction. index.ts imports TOOLS from here.

import type { Tool, JSONObject } from "@modelcontextprotocol/server";

/** Shared citation schema for Cat A writes (mai_remember, mai_lesson_add). */
const CITATION_SCHEMA: JSONObject = {
  type: "object" as const,
  description: "Required. One of supersedes/extends/novel.",
  oneOf: [
    {
      type: "object" as const,
      properties: {
        kind: { type: "string", const: "supersedes" },
        supersedes_id: { type: "string" },
        reason: { type: "string" },
      },
      required: ["kind", "supersedes_id", "reason"],
    },
    {
      type: "object" as const,
      properties: {
        kind: { type: "string", const: "extends" },
        extends_id: { type: "string" },
        how: { type: "string" },
      },
      required: ["kind", "extends_id", "how"],
    },
    {
      type: "object" as const,
      properties: {
        kind: { type: "string", const: "novel" },
        justification: { type: "string", minLength: 50 },
      },
      required: ["kind", "justification"],
    },
  ],
};

export const TOOLS: Tool[] = [
  {
    name: 'mai_navigate',
    description: 'Optional Jev-assisted navigation of this project: layout, impact, decisions, or defect families. Returns bounded evidence and gaps, not approval. Requires configured opt-in; disabled users can use ordinary graph/search tools.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        question: { type: 'string', minLength: 1, maxLength: 1000 },
        intent: { type: 'string', enum: ['layout', 'impact', 'decisions', 'family'] },
        seed_nodes: { type: 'array', maxItems: 4, uniqueItems: true,
          items: { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' } },
        terms: { type: 'array', maxItems: 4, uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 100 } },
        context: { type: 'array', maxItems: 12, items: {
          type: 'object', additionalProperties: false, required: ['label', 'text'],
          properties: { label: { type: 'string', minLength: 1, maxLength: 160 },
            text: { type: 'string', minLength: 1, maxLength: 1600 } },
        } },
        mechanism: { type: 'string', minLength: 1, maxLength: 1000,
          description: 'Required only for family intent: the causal failure to look for.' },
      },
      required: ['question', 'intent'],
    },
  },
  {
    name: "mai_search",
    description:
      "Search decisions, lessons and plan/spec path:line pointers BEFORE proposing/writing; mints write-gate tokens.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "What you're looking for." },
        keywords: {
          type: "array",
          items: { type: "string" },
          description: "Exact keyword filter on decisions (lowercase, kebab-case).",
        },
        kind: {
          type: "string",
          enum: ["decisions", "lessons", "all"],
          description: "Layer to search (default all).",
        },
        limit: { type: "number", description: "Max results per section (default 15)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "mai_recall",
    description:
      "Session-start context: recent sessions, valid decisions and commits.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "mai_timeline",
    description:
      "Sessions, decisions and commits over N days, chronologically.",
    inputSchema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Days to look back (default 30)." },
        limit: { type: "number", description: "Max events (default 40)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mai_edges",
    description:
      "Links in either direction, with linked record kind and ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        kind: {
          type: "string",
          enum: ["decision", "lesson", "session", "topic", "commit"],
          description: "Record kind.",
        },
        id: { type: "string", description: "UUID of the record." },
      },
      required: ["kind", "id"],
      additionalProperties: false,
    },
  },
  {
    name: "mai_git_context",
    description:
      "Branches/worktrees, recent commits, file stats and decisions; filter paths/keywords.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task: { type: "string", description: "Keywords filter commit subjects/bodies." },
        paths: { type: "array", items: { type: "string" }, description: "Path prefixes to filter commits by touched files." },
        limit: { type: "number", description: "Max commits (default 10, cap 30)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mai_git_show",
    description:
      "Commit metadata/file stats (hash ≥7 chars); patch:true adds a bounded live diff, never stored.",
    inputSchema: {
      type: "object" as const,
      properties: {
        hash: { type: "string", description: "Commit hash or ≥7-char prefix." },
        patch: { type: "boolean", description: "Live-hydrated, size-bounded patch." },
        paths: { type: "array", items: { type: "string" }, description: "Restrict the patch to these paths." },
      },
      required: ["hash"],
      additionalProperties: false,
    },
  },
  {
    name: "mai_git_trace_decision",
    description:
      "Trace a recalled decision ID through session, commits, files and graph nodes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        decision_id: { type: "string", description: "UUID of the decision to trace." },
      },
      required: ["decision_id"],
      additionalProperties: false,
    },
  },
  {
    name: "mai_remember",
    description:
      "Log a decision headline; requires this session's mai_search/mai_recall and structured citation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        citation: CITATION_SCHEMA,
        decision_type: {
          type: "string",
          description:
            "e.g. architecture, pattern, security, performance, api, data-model, testing, tooling, workflow.",
        },
        reasoning: { type: "string", description: "The rationale; detail lives here, not in description." },
        alternatives_considered: {
          type: "array",
          items: { type: "string" },
          description: "Alternatives rejected.",
        },
        files_affected: {
          type: "array",
          items: { type: "string" },
          description: "Files this decision impacts.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Free-form tags.",
        },
        keywords: {
          type: "array",
          items: { type: "string" },
          description:
            "Domain-specific lowercase kebab-case search terms.",
        },
        confidence: { type: "number", description: "0-1 confidence (default 0.8)." },
        source: {
          type: "string",
          enum: ["user-approved", "agent-inferred", "user-selected"],
          description:
            "user-approved=explicitly told to log; user-selected=dialog choice (chosen→description, others→alternatives); agent-inferred=proposal for review (default).",
        },
        description: { type: "string", description: "One-sentence headline; details in reasoning, status in mai_progress. Provide LAST (harness bug)." },
      },
      required: ["citation", "decision_type", "description"],
      additionalProperties: false,
    },
  },
  {
    name: "mai_lesson_add",
    description:
      "Add/reinforce a durable lesson; requires this session's mai_search and structured citation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        citation: CITATION_SCHEMA,
        context: { type: "string", description: "When/where this applies. (~750 chars)." },
        why: { type: "string", description: "Why it's true. (~750 chars)." },
        how_to_apply: { type: "string", description: "Concrete application. (~750 chars)." },
        expected_outcome: { type: "string", description: "Expected result (~750 chars)." },
        actual_outcome: { type: "string", description: "What happened (~750 chars)." },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Free-form tags.",
        },
        initial_confidence: {
          type: "number",
          description: "0-1 starting confidence (default 0.50).",
        },
        rule: { type: "string", description: "One-line takeaway. Put why/where/how in why/context/how_to_apply. Provide LAST (harness drops following field)." },
      },
      required: ["rule", "citation"],
      additionalProperties: false,
    },
  },
  {
  name: 'mai_link',
  description: 'Link memories; lesson→graph_node/applies_to needs note and exact extends citation.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      from_kind: { type: 'string', enum: ['decision','lesson','session','topic','commit'] },
      from_id: { type: 'string' },
      to_kind: { type: 'string', enum: ['decision','lesson','session','topic','commit','graph_node'] },
      to_id: { type: 'string' },
      relation: { type: 'string', enum: ['relates_to','caused_by','fixed_by','same_flaw_as','implemented_by','reverted_by','applies_to'] },
      note: { type: 'string' },
      action: { type: 'string', enum: ['attach','detach'] },
      citation: {
        type: 'object', additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['extends'] },
          extends_id: { type: 'string' },
          how: { type: 'string', minLength: 1, maxLength: 1000 },
        }, required: ['kind','extends_id','how'],
      },
    }, required: ['from_kind','from_id','to_kind','to_id','relation'],
  },
},

  {
    // The old description asked for approval in PROSE; prose is a request, not
    // a guarantee (decision aebc6583). The agent-facing arm is now mechanically
    // propose-only, so the ask is REPLACED rather than added to — which is why
    // this rewrite costs only +27 serialized chars (measured).
    name: "mai_retract",
    description:
      "Agents must pass propose:true: queues operator review, retracts nothing. Direct retraction is operator-only (dashboard/CLI).",
    inputSchema: {
      type: "object" as const,
      properties: {
        decision_id: { type: "string", description: "UUID of the code_decisions row." },
        reason: {
          type: "string",
          description:
            "Required reason: superseded, incorrect or no longer applicable.",
        },
        propose: {
          type: "boolean",
          description: "Required for agents: file a proposal instead of retracting.",
        },
      },
      required: ["decision_id", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "mai_unretract",
    description: "Restore still_valid=true; clear retracted_at and retraction reason.",
    inputSchema: {
      type: "object" as const,
      properties: {
        decision_id: { type: "string", description: "UUID of the decision to un-retract." },
      },
      required: ["decision_id"],
      additionalProperties: false,
    },
  },
  {
    name: "mai_promote",
    description:
      "After user confirmation, promote a queued agent-inferred decision to user-approved; raises confidence.",
    inputSchema: {
      type: "object" as const,
      properties: {
        decision_id: { type: "string", description: "UUID of the decision to promote." },
        confidence: { type: "number", description: "explicit confidence (else GREATEST(current, 0.85))." },
      },
      required: ["decision_id"],
      additionalProperties: false,
    },
  },
  {
    name: "mai_globalize",
    description:
      "Requires explicit user approval: propose, wait for yes, then move a lesson to global visibility across ALL projects.",
    inputSchema: {
      type: "object" as const,
      properties: {
        lesson_id: { type: "string", description: "UUID of the lesson to globalize." },
        reason: { type: "string", description: "Why this lesson should apply to all projects. (~750 chars)." },
      },
      required: ["lesson_id", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "mai_report",
    description:
      "Daily additions by source, retractions, review queue, and old/low-confidence entries.",
    inputSchema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Days to look back (default 1)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mai_review",
    description:
      "Queue of agent-inferred/low-confidence decisions and curation candidates. Promote: mai_promote. Retire: operator dashboard/CLI.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Max items (default 30)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mai_violations",
    description:
      "Write-gate rejections and recovery status; blocked-write diagnostics.",
    inputSchema: {
      type: "object" as const,
      properties: {
        hours: { type: "number", description: "Look-back window in hours (default 24)." },
        tool_name: { type: "string", description: "Filter by the tool that was rejected." },
        kind: { type: "string", description: "Filter by violation_kind." },
        limit: { type: "number", description: "Max entries (default 50)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mai_prime",
    description:
      "Start every task here. Returns state and mints write tokens. First call: pass native chat identity if available; never invent one.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task_description: {
          type: "string",
          description: "One or two sentences on the task you're about to work on.",
        },
        chat: {
          type: "object",
          description: "Bind a native chat ID once; omit if unavailable. Optional name is a harness label only.",
          properties: {
            provider: { type: "string", enum: ["codex", "claude"] },
            id: { type: "string", minLength: 1, maxLength: 128 },
            client: { type: "string", enum: ["codex-cli", "codex-desktop", "claude-code", "claude-desktop", "unknown-client"] },
            name: { type: "string", maxLength: 24 },
          },
          required: ["provider", "id"],
          additionalProperties: false,
        },
        mode: {
          type: "string",
          enum: ["summary", "full"],
          description: "'summary' (default) = H1 + TL;DR per topic; 'full' = full bodies.",
        },
      },
      required: ["task_description"],
      additionalProperties: false,
    },
  },
  {
    name: "mai_topics",
    description:
      "Project context-topic catalog; call to find the right topic.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "mai_get_context",
    description:
      "Load a full project topic named by mai_topics/mai_prime.",
    inputSchema: {
      type: "object" as const,
      properties: {
        topic: {
          type: "string",
          description: "Topic name from the catalog (e.g. 'overview').",
        },
      },
      required: ["topic"],
      additionalProperties: false,
    },
  },
  {
    name: "mai_note",
    description:
      "Append today's structured session note: decisions/progress/todos/questions. Per-type evidence required; errors explain format.",
    inputSchema: {
      type: "object" as const,
      properties: {
        type: {
          type: "string",
          enum: ["decision", "progress", "todo", "question"],
          description: "Category of the note.",
        },
        content: {
          type: "string",
          description: "One-line, durable — the permanent record (~750 chars).",
        },
        evidence: {
          type: "object",
          description:
            "Required. Per-type evidence proving a real entry, not chat content.",
          oneOf: [
            {
              type: "object",
              properties: {
                type: { type: "string", const: "decision" },
                user_quote: { type: "string", minLength: 20 },
              },
              required: ["type", "user_quote"],
            },
            {
              type: "object",
              properties: {
                type: { type: "string", const: "decision_selection" },
                question: { type: "string", minLength: 10 },
                options_presented: { type: "array", items: { type: "string" }, minItems: 2 },
                option_selected: { type: "string", minLength: 1 },
              },
              required: ["type", "question", "options_presented", "option_selected"],
            },
            {
              type: "object",
              properties: {
                type: { type: "string", const: "progress" },
                tool_call_id: { type: "string" },
                file_path: { type: "string" },
              },
              required: ["type"],
            },
            {
              type: "object",
              properties: {
                type: { type: "string", const: "todo" },
                reason: { type: "string", minLength: 50 },
              },
              required: ["type", "reason"],
            },
            {
              type: "object",
              properties: {
                type: { type: "string", const: "question" },
                question: { type: "string", minLength: 10 },
              },
              required: ["type", "question"],
            },
          ],
        },
      },
      required: ["type", "content", "evidence"],
      additionalProperties: false,
    },
  },
  {
    name: "mai_progress",
    description:
      "Record a verified milestone; cite tool_call_id or file_path.",
    inputSchema: {
      type: "object" as const,
      properties: {
        milestone: {
          type: "string",
          description: "One-line milestone. (~750 chars).",
        },
        evidence: {
          type: "object",
          description: "Required evidence: tool_call_id or file_path.",
          oneOf: [
            {
              type: "object",
              properties: {
                type: { type: "string", const: "progress" },
                tool_call_id: { type: "string" },
              },
              required: ["type"],
            },
            {
              type: "object",
              properties: {
                type: { type: "string", const: "progress" },
                file_path: { type: "string" },
              },
              required: ["type"],
            },
          ],
        },
      },
      required: ["milestone", "evidence"],
      additionalProperties: false,
    },
  },
  {
  name: 'mai_graph_find',
  description: 'Find graph nodes by name or mode:semantic meaning, with labelled text fallback. Tables: kind:table.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      kind: { type: 'string' },
      limit: { type: 'number', description: 'Default/cap: lexical 20/50; semantic 10/30.' },
      mode: { type: 'string', enum: ['lexical','semantic'] },
    },
    required: ['query'], additionalProperties: false,
  },
},

  {
  name: 'mai_graph_neighbors',
  description: 'Connections or view:lessons. Graph depth 1-3 (default 1), max 100 edges.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      node_id: { type: 'string' },
      depth: { type: 'number' },
      relation: { type: 'string' },
      view: { type: 'string', enum: ['graph','lessons'] },
      limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Lessons only; default 10.' },
      offset: { type: 'integer', minimum: 0, maximum: 100000, description: 'Lessons only; default 0.' },
    }, required: ['node_id'],
  },
},

  {
    name: "mai_graph_trace",
    description:
      "Read-only shortest path A→B, ≤10 hops. Obtain node IDs via mai_graph_find.",
    inputSchema: {
      type: "object" as const,
      properties: {
        from_node: { type: "string", description: "UUID of the start node." },
        to_node: { type: "string", description: "UUID of the end node." },
      },
      required: ["from_node", "to_node"],
      additionalProperties: false,
    },
  },
  {
    name: "mai_graph_impact",
    description:
      "Read-only reverse deps (depth 1–3), FK-dependent tables, and related decision/lesson rationale.",
    inputSchema: {
      type: "object" as const,
      properties: {
        node_id: { type: "string", description: "UUID of the node (from mai_graph_find)." },
        depth: { type: "number", description: "Reverse hops, 1-3 (default 2)." },
      },
      required: ["node_id"],
      additionalProperties: false,
    },
  },
  {
    name: "mai_graph_query",
    description:
      "Read-only traversal: node/text seed, 0–3 filtered steps; caps 20 seeds/100 edges/50 nodes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        seed: {
          type: "object",
          description: "Exactly one of node_id or query.",
          properties: {
            node_id: { type: "string", description: "UUID from mai_graph_find." },
            query: { type: "string", description: "Literal substring, 1-200 chars (no wildcards)." },
            kinds: { type: "array", maxItems: 8, items: { type: "string" }, description: "Registered node kinds; text seeds only." },
            path_prefix: { type: "string", description: "Literal file-path prefix; text seeds only." },
          },
          oneOf: [{ required: ["node_id"] }, { required: ["query"] }],
          additionalProperties: false,
        },
        steps: {
          type: "array",
          maxItems: 3,
          description: "Ordered traversal steps.",
          items: {
            type: "object",
            properties: {
              direction: { type: "string", enum: ["outgoing", "incoming", "both"] },
              relations: { type: "array", maxItems: 8, items: { type: "string" }, description: "Registered relations." },
              target_kinds: { type: "array", maxItems: 8, items: { type: "string" }, description: "Registered kinds." },
            },
            required: ["direction"],
            additionalProperties: false,
          },
        },
        limit: { type: "number", description: "Returned nodes, 1-50 (default 20)." },
      },
      required: ["seed"],
      additionalProperties: false,
    },
  },
  {
    name: "mai_graph_dead_code",
    description:
      "Dead-code candidates, never proof: supported symbols without use/export/root/reasoning evidence. Read-only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        kinds: { type: "array", maxItems: 3, items: { type: "string", enum: ["function", "class", "component"] } },
        path_prefix: { type: "string", description: "Literal file-path prefix." },
        limit: { type: "number", description: "Rows, 1-50 (default 20)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mai_graph_stale",
    description:
      "Graph currency on two independent axes: code vs repo HEADs and DB-schema vs last introspection. Refresh: mai graph update. Read-only.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "mai_idea",
    description:
      "Park an idea for user curation. scope:global only for fleet-wide/business ideas.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "ONE line, ≤200 chars." },
        detail: { type: "string", description: "Optional context." },
        priority: { type: "string", enum: ["now", "next", "later", "someday"], description: "Default someday." },
        scope: { type: "string", enum: ["project", "global"], description: "Default project (pinned)." },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "mai_ideas",
    description: "Read the roadmap board, or one complete card by idea_id.",
    inputSchema: {
      type: "object" as const,
      properties: {
        idea_id: { type: "string", description: "UUID or 8-char prefix[:part]; exclusive with filters." },
        scope: { type: "string", enum: ["project", "global", "both"], description: "Default both." },
        include_closed: { type: "boolean", description: "Include shipped/dropped." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mai_idea_move",
    description:
      "Evidence-backed planned→building at plan start; building→shipped at completion. Other moves are operator-owned.",
    inputSchema: {
      type: "object" as const,
      properties: {
        idea_id: { type: "string", description: "UUID from mai_ideas." },
        to: { type: "string", enum: ["building", "shipped"] },
        evidence: { type: "string", description: "The plan/commit/decision. PROVIDE LAST." },
      },
      required: ["idea_id", "to", "evidence"],
      additionalProperties: false,
    },
  },
  {
    name: "mai_fact_add",
    description:
      "Propose a user fact for review; approved facts prime globally. Project facts belong in decisions/lessons.",
    inputSchema: {
      type: "object" as const,
      properties: {
        category: { type: "string", enum: ["identity", "preference", "workflow", "tooling"] },
        fact: { type: "string", description: "ONE sentence, ≤300 chars." },
        detail: { type: "string", description: "Optional context." },
        evidence: { type: "string", description: "Where/how learned. PROVIDE LAST." },
      },
      required: ["category", "fact", "evidence"],
      additionalProperties: false,
    },
  },
  {
    name: "mai_plan",
    description: 'Register/fetch plan; move status or select reviews.',
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Repo-relative path to the plan .md." },
        slug: { type: "string", description: "Stable identity; defaults to filename without date/extension. Same slug=same record." },
        title: { type: "string", description: "Human title; defaults to the slug." },
        status: {
          type: "string",
          enum: ["draft", "reviewing", "approved", "executing", "executed", "abandoned"],
          description: "Move the plan's lifecycle state.",
        },
        passes: { type: "string", enum: ["latest", "all"], description: "Default latest." },
        pass: { type: "string", description: "One review pass as N or bounded part N:part; exclusive with passes." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "mai_user_tasks_post",
    description: "Pinned project. mode=sync-plan requires plan_path; mode=assign requires tasks and permits plan_path. Resolution is operator-owned; receipt is counts/link only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        mode: { type: "string", enum: ["sync-plan", "assign"] },
        plan_path: { type: "string", minLength: 1, maxLength: 1000 },
        tasks: {
          type: "array", minItems: 1, maxItems: 50,
          items: {
            type: "object",
            properties: {
              key: { type: "string", pattern: "^[A-Z][A-Z0-9_-]{0,63}$" },
              kind: { type: "string", enum: ["blocking", "follow-up"] },
              title: { type: "string", minLength: 1, maxLength: 300 },
              instructions: { type: "string", minLength: 1, maxLength: 4000 },
            },
            required: ["key", "kind", "title", "instructions"],
            additionalProperties: false,
          },
        },
      },
      required: ["mode"],
      additionalProperties: false,
    },
  },
  {
    name: "mai_user_tasks",
    description: "Read pinned-project operator tasks; status changes are operator-owned in My Tasks.",
    inputSchema: {
      type: "object" as const,
      properties: {
        plan_path: { type: "string", minLength: 1, maxLength: 1000 },
        history: { type: "boolean" },
        detail: { type: "string", enum: ["summary", "full"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mai_receipt_add",
    description: "Append immutable receipt; receiptKey is idempotent. Different bytes for an existing key return JSON conflict.",
    inputSchema: {
      type: "object" as const,
      properties: {
        receipt: {
          type: "object",
          properties: {
            receiptKey: { type: "string", minLength: 1, maxLength: 256 },
            kind: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
            cycleId: { type: "string", minLength: 1, maxLength: 128 },
            schemaVersion: { type: "string", minLength: 1, maxLength: 64 },
            planId: { type: "string", minLength: 1, maxLength: 128 },
            pass: { type: ["integer", "null"], minimum: 1 },
          },
          required: ["receiptKey", "kind", "cycleId", "schemaVersion"],
          additionalProperties: true,
        },
      },
      required: ["receipt"],
      additionalProperties: false,
    },
  },
  {
    name: "mai_receipts",
    description: "Read plan/cycle receipts oldest-first, budget-capped. Uncapped machine reads: build/read-call.js receipts.",
    inputSchema: {
      type: "object" as const,
      properties: {
        plan_id: { type: "string", minLength: 1, maxLength: 128 },
        cycle_id: { type: "string", minLength: 1, maxLength: 128 },
        cursor: { type: "string", minLength: 1, maxLength: 256 },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mai_artifact_put",
    description: "Store immutable, permanent UTF-8 artifact (≤4 MiB), ID=SHA256(bytes). Idempotent; no delete/release.",
    inputSchema: {
      type: "object" as const,
      properties: {
        kind: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
        content: { type: "string", minLength: 1 },
      },
      required: ["kind", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "mai_review_post",
    description: "Atomically post one review pass; pass number is server-assigned.",
    inputSchema: {
      type: "object" as const,
      properties: {
        plan: { type: "string", description: "Plan UUID or repo-relative path." },
        plan_sha: {
          type: "string",
          description: "Review-start SHA; detects plan drift.",
        },
        kind: { type: "string", enum: ["author", "blind"], description: "Author self-review or independent blind pass." },
        verdict: { type: "string", enum: ["approved", "blocked"] },
        synthesis: {
          type: "string",
          description: "Required analytical synthesis.",
        },
        findings: {
          type: "array",
          description: "Every finding; empty is valid for a clean approval.",
          items: {
            type: "object",
            properties: {
              ref: { type: "string", description: "Label within THIS review, e.g. 'B1'. Not an identifier." },
              severity: { type: "string", enum: ["blocker", "warning", "note"] },
              title: { type: "string", description: "One line." },
              location: { type: "string", description: "file:line, or 'Task N'." },
              issue: { type: "string", description: "What is wrong." },
              evidence: { type: "string", description: "REQUIRED. Quote plus what the codebase shows." },
              fix: { type: "string", description: "REQUIRED. Exactly what must change." },
              recurrence_of: { type: "string", description: "UUID of an earlier finding this repeats." },
            },
            required: ["severity", "title", "location", "issue", "evidence", "fix"],
            additionalProperties: false,
          },
        },
        finding_count: {
          type: "integer",
          description: "Intended findings length; mismatch aborts before writing.",
        },
      },
      required: ["plan", "kind", "verdict", "synthesis", "findings", "finding_count"],
      additionalProperties: false,
    },
  },
  {
    name: "mai_findings",
    description: 'Read plan or code findings; search past ones.',
    inputSchema: {
      type: "object" as const,
      properties: {
        plan: { type: "string", description: "Plan UUID or repo-relative path." },
        status: { type: "string", enum: ["open", "fixed", "disputed", "accepted-risk"] },
        severity: { type: "string", enum: ["blocker", "warning", "note"] },
        similar_to: { type: "string", description: "Project-wide text." },
        finding: { type: "string", description: "Finding UUID or bounded part UUID:part." },
        limit: { type: "number", description: "Default 15." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "mai_finding_update",
    description:
      "Executor: finding status/location; closing warns on plan/review drift.",
    inputSchema: {
      type: "object" as const,
      properties: {
        finding_id: { type: "string", description: "Finding UUID from mai_review_post or mai_findings." },
        status: { type: "string", enum: ["open", "fixed", "disputed", "accepted-risk"], description: "Omit for a location-only repair." },
        note: { type: "string", description: "Required when closing: what was done, or why disputed/accepted." },
        location: { type: "string", description: "Corrected file:line citation (R-location repair)." },
      },
      required: ["finding_id"],
      additionalProperties: false,
    },
  },
  {
    name: "mai_shared",
    description:
      "Read-only shared references: no args=list, id=detail, part=next page. Foreign IDs are not citable.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "uuid or ≥4-char prefix." },
        limit: { type: "number", description: "default 20, max 50." },
        part: { type: "number", description: "detail page; default 1." },
      },
      additionalProperties: false,
    },
  },
];
