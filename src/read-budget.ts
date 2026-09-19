/**
 * The cast-free leaf for bounded MCP reads (plan 23). Owns the char/row budget
 * constants, the pure render helpers, the complete 40-tool read/non-read
 * partition, and the single final wire cap applied at `tools/call`.
 *
 * Nothing here touches the database, the pool, or any app module — that is what
 * keeps it importable from every renderer AND from the static AST gate.
 */
export const FULL_ROWS = 3;
export const READ_CHAR_BUDGET = 6000;
export const PAGE_NUDGE_RESERVE = 512;
export interface ReadBudget { fullRows: number; charBudget: number }
export const mcpBudget = (): ReadBudget => ({ fullRows: FULL_ROWS, charBudget: READ_CHAR_BUDGET });
export const pageBudget = (): ReadBudget => ({
  fullRows: FULL_ROWS, charBudget: READ_CHAR_BUDGET - PAGE_NUDGE_RESERVE,
});
export const MCP_READ_TOOLS = [
  'mai_search', 'mai_recall', 'mai_timeline', 'mai_edges', 'mai_git_context',
  'mai_git_show', 'mai_git_trace_decision', 'mai_report', 'mai_review',
  'mai_violations', 'mai_prime', 'mai_topics', 'mai_get_context',
  'mai_graph_find', 'mai_graph_neighbors', 'mai_graph_trace', 'mai_graph_impact',
  'mai_graph_stale', 'mai_ideas', 'mai_plan', 'mai_findings', 'mai_board_read',
  'mai_claims', 'mai_shared', 'mai_graph_query', 'mai_graph_dead_code',
  'mai_user_tasks', 'mai_receipts',
] as const;
export const MCP_NON_READ_TOOLS = [
  'mai_remember', 'mai_lesson_add', 'mai_link', 'mai_retract', 'mai_unretract',
  'mai_promote', 'mai_globalize', 'mai_note', 'mai_progress', 'mai_idea',
  'mai_idea_move', 'mai_fact_add', 'mai_review_post', 'mai_finding_update',
  'mai_board_post', 'mai_claim',
  'mai_user_tasks_post', 'mai_receipt_add', 'mai_artifact_put',
] as const;
export type McpReadTool = (typeof MCP_READ_TOOLS)[number];
export const MCP_READ_NARROWING: Record<McpReadTool, string> = {
  // Five task-prime routes name their literal MCP tool as well as the CLI
  // spelling: a shortened prime section must say the exact call that recovers
  // it (plan 38 R6), not only how to narrow the read that produced it.
  mai_search: 'lower limit/use one kind, call mai_search, or run mai search in the CLI',
  mai_recall: 'run mai recall --project <slug> for the complete dump',
  mai_timeline: 'lower days/limit, call mai_timeline, or run mai timeline in the CLI',
  mai_edges: 'run mai edges <kind> <id> in the CLI',
  mai_git_context: 'pass fewer paths or lower limit',
  mai_git_show: 'set patch:false/pass fewer paths or run git show locally',
  mai_git_trace_decision: 'inspect the named commits with git show locally',
  mai_report: 'run mai report --days <N> --project <slug>',
  mai_review: 'lower limit or run mai review in the CLI',
  mai_violations: 'filter/lower limit or run mai violations in the CLI',
  mai_prime: 'call the named component read for the omitted section',
  mai_topics: 'run mai topics in the CLI',
  mai_get_context: 'call mai_get_context, or run MAI_PROJECT_SLUG=<slug> mai context <topic>',
  mai_graph_find: 'narrow query/kind/limit, call mai_graph_find, or run mai graph find in the CLI',
  mai_graph_neighbors: 'lower depth/filter relation, use view:lessons with limit/offset, or run mai graph lessons show in the CLI',
  mai_graph_trace: 'run mai graph trace in the CLI',
  mai_graph_impact: 'lower depth or run mai graph impact in the CLI',
  mai_graph_stale: 'run mai graph stale in the CLI',
  mai_ideas: 'pass idea_id:"UUID-or-prefix[:part]" for one complete card, filter scope/include_closed, or use the dashboard',
  mai_plan: 'use pass:"N[:part]" for one complete review',
  mai_findings: 'use finding:"UUID[:part]" for one complete finding',
  mai_board_read: 'pass one message id as thread_id; add limit:1 for a root message',
  mai_claims: 'request active only or run mai claims in the CLI',
  mai_shared: 'call mai_shared with id:"<uuid-prefix>" and part:N for detail pages, or lower limit',
  mai_graph_query: 'use smaller steps/filters/limit, call mai_graph_query, or run mai graph query in the CLI',
  mai_graph_dead_code: 'narrow kinds/path-prefix/limit, call mai_graph_dead_code, or run mai graph dead-code in the CLI',
  mai_user_tasks: 'pass one plan_path, history:false, or detail:"summary"',
  mai_receipts: 'use build/read-call.js receipts for the uncapped cursor-paged JSON ledger',
};

export function shouldRenderFull(budget: ReadBudget | undefined, rows: number, exactChars: number): boolean {
  return budget === undefined || (rows <= budget.fullRows && exactChars <= budget.charBudget);
}

function fitWithPointer(budget: ReadBudget, text: string, pointer: string): string {
  const safePointer = pointer.length <= budget.charBudget
    ? pointer : pointer.slice(0, Math.max(0, budget.charBudget - 1)) + '…';
  const separator = '\n\n';
  const allowance = Math.max(0, budget.charBudget - safePointer.length - separator.length);
  const raw = text.slice(0, allowance);
  const newline = raw.lastIndexOf('\n');
  const body = newline > 0 ? raw.slice(0, newline) : raw;
  return body ? body + separator + safePointer : safePointer;
}

export function budgetText(budget: ReadBudget | undefined, text: string, narrowing: string): string {
  if (budget === undefined || text.length <= budget.charBudget) return text;
  return fitWithPointer(budget, text,
    `_Truncated: ${text.length} chars exceeded ${budget.charBudget}. To see the rest, ${narrowing}._`);
}

export function headlineField(value: string, max = 240): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, Math.max(0, max - 1)) + '…';
}

/**
 * `minimumFallback` is the caller's own truthful structural minimum. It is used
 * ONLY when the zero-row pointer itself would exceed the cap, which makes every
 * integer budget from that minimum upward defined for prepared prime sources
 * (plan 38). Callers that omit it keep the fail-closed throw, and the fallback
 * is returned byte-for-byte — never sliced.
 */
export function budgetRows<T>(
  budget: ReadBudget | undefined, rows: readonly T[], full: (x: readonly T[]) => string,
  headline: (x: T) => string, heading: string, noun: string, narrowing: string,
  minimumFallback?: string,
): string {
  const complete = full(rows);
  if (shouldRenderFull(budget, rows.length, complete.length)) return complete;
  if (budget === undefined) return complete;
  const lines = rows.map(headline);
  const pointer = (shown: number) =>
    `_${shown}/${rows.length} ${noun} headline${rows.length === 1 ? '' : 's'} shown; complete render ${complete.length} chars. To read omitted headlines or bodies, ${narrowing}._`;
  let shown = 0;
  for (let n = 1; n <= lines.length; n++) {
    const candidate = [heading, ...lines.slice(0, n)].filter(Boolean).join('\n');
    if (`${candidate}\n\n${pointer(n)}`.length > budget.charBudget) break;
    shown = n;
  }
  const body = [heading, ...lines.slice(0, shown)].filter(Boolean).join('\n');
  const out = body ? `${body}\n\n${pointer(shown)}` : pointer(0);
  if (out.length > budget.charBudget) {
    if (minimumFallback !== undefined && minimumFallback.length <= budget.charBudget) {
      return minimumFallback;
    }
    throw new Error('read-budget pointer exceeds cap');
  }
  return out;
}

export interface ReadSection {
  heading: string;
  fullRows: readonly string[];
  headlineRows: readonly string[];
}

export function budgetSections(
  budget: ReadBudget | undefined, sections: readonly ReadSection[], noun: string, narrowing: string,
  minimumFallback?: string,
): string {
  const rows = sections.flatMap((section) => {
    if (section.fullRows.length !== section.headlineRows.length) {
      throw new Error(`read section ${section.heading} has mismatched row shapes`);
    }
    return section.fullRows.map((full, index) => ({
      full, headline: section.headlineRows[index],
      rawHeading: section.heading,
      headlineHeading: headlineField(section.heading, 320),
      first: index === 0,
    }));
  });
  // An EMPTY heading contributes nothing, exactly as budgetRows already treats
  // its own heading via `.filter(Boolean)` — otherwise a headingless section
  // would gain a stray leading newline and break direct/CLI byte parity.
  const renderFull = (items: readonly (typeof rows)[number][]) =>
    items.map((row) => `${row.first && row.rawHeading ? `${row.rawHeading}\n` : ''}${row.full}`).join('\n');
  return budgetRows(
    budget, rows, renderFull,
    (row) => `${row.first && row.headlineHeading ? `${row.headlineHeading}\n` : ''}${row.headline}`,
    '', noun, narrowing, minimumFallback,
  );
}

export interface BudgetPage {
  text: string; bodyPart: string; part: number; totalParts: number;
}
export type PageBodyKind = 'synthesis' | 'finding' | 'share' | 'idea';

function pageLabel(kind: PageBodyKind): string {
  return kind === 'synthesis' ? 'Review synthesis'
    : kind === 'finding' ? 'Finding'
      : kind === 'share' ? 'Shared detail' : 'Idea';
}

function pageFrame(kind: PageBodyKind, chars: number): string {
  return `-- ${kind}-body chars=${String(chars).padStart(10, '0')} --\n`;
}

export function budgetPage(
  budget: ReadBudget, prefix: string, body: string, requestedPart: number,
  kind: PageBodyKind, nextPointer: (part: number) => string,
): BudgetPage {
  const label = pageLabel(kind);
  if (budget.charBudget < 256) throw new Error('read budget too small for paging');
  if (!Number.isInteger(requestedPart) || requestedPart < 1) throw new Error(`${label} part must be a positive integer`);
  const metadataMarker = '… [metadata shortened]';
  const prefixLimit = Math.min(1000, Math.floor(budget.charBudget / 4));
  const oneLinePrefix = prefix.replace(/\s+/g, ' ').trim();
  const safePrefix = oneLinePrefix.length <= prefixLimit ? oneLinePrefix
    : oneLinePrefix.slice(0, Math.max(0, prefixLimit - metadataMarker.length)) + metadataMarker;
  const separator = '\n\n';
  const framePrefixLength = pageFrame(kind, 0).length;
  const frameSuffix = `\n-- end ${kind}-body --`;
  let totalParts = 1;
  let chunkSize = 0;
  for (let i = 0; i < 32; i++) {
    const worstPointer = `_${label} part ${totalParts}/${totalParts}; next: ${nextPointer(totalParts)}._`;
    const candidateSize = budget.charBudget - safePrefix.length - separator.length * 2
      - framePrefixLength - frameSuffix.length - worstPointer.length;
    if (candidateSize <= 0) throw new Error('review pointer exceeds read budget');
    const candidateTotal = Math.max(1, Math.ceil(body.length / candidateSize));
    if (candidateTotal === totalParts) { chunkSize = candidateSize; break; }
    totalParts = candidateTotal;
  }
  if (chunkSize <= 0) throw new Error('review paging did not converge');
  if (requestedPart > totalParts) throw new Error(`${label} part ${requestedPart} exceeds ${totalParts}`);
  const start = (requestedPart - 1) * chunkSize;
  const bodyPart = body.slice(start, start + chunkSize);
  const pointer = requestedPart < totalParts
    ? `_${label} part ${requestedPart}/${totalParts}; next: ${nextPointer(requestedPart + 1)}._`
    : `_${label} part ${requestedPart}/${totalParts}; complete._`;
  const framePrefix = pageFrame(kind, bodyPart.length);
  const text = `${safePrefix}${separator}${framePrefix}${bodyPart}${frameSuffix}${separator}${pointer}`;
  if (text.length > budget.charBudget) throw new Error('review page exceeds read budget');
  return { text, bodyPart, part: requestedPart, totalParts };
}

const MCP_READ_TOOL_SET = new Set<string>(MCP_READ_TOOLS);
export function isMcpReadTool(tool: string): tool is McpReadTool {
  return MCP_READ_TOOL_SET.has(tool);
}

export interface BudgetableBlock { type: string; text?: string }
export interface BudgetableResult { content: BudgetableBlock[]; isError?: boolean; structuredContent?: unknown }

export function parseBudgetPage(text: string): { kind: PageBodyKind; body: string } | null {
  const head = /^([^\n]*)\n\n-- (synthesis|finding|share|idea)-body chars=(\d{10}) --\n/.exec(text);
  if (!head) return null;
  const kind: PageBodyKind = head[2] === 'synthesis' ? 'synthesis'
    : head[2] === 'finding' ? 'finding'
      : head[2] === 'share' ? 'share' : 'idea';
  const bodyStart = head[0].length;
  const bodyEnd = bodyStart + Number(head[3]);
  const body = text.slice(bodyStart, bodyEnd);
  const footer = `\n-- end ${kind}-body --\n\n`;
  if (text.slice(bodyEnd, bodyEnd + footer.length) !== footer) return null;
  const tail = text.slice(bodyEnd + footer.length);
  const [pointer, nudge, extra] = tail.split('\n\n');
  if (extra !== undefined || (nudge !== undefined && nudge.includes('\n'))) return null;
  const label = pageLabel(kind);
  if (!new RegExp(`^_${label} part [1-9]\\d*/[1-9]\\d*; (?:next: [^\\n]+|complete)\\._$`).test(pointer)) return null;
  return { kind, body };
}

export function isAtomicSelectorPage(tool: string, text: string): boolean {
  const framed = parseBudgetPage(text);
  if (!framed || text.length > pageBudget().charBudget) return false;
  return (tool === 'mai_plan' && framed.kind === 'synthesis')
    || (tool === 'mai_findings' && framed.kind === 'finding')
    || (tool === 'mai_shared' && framed.kind === 'share')
    || (tool === 'mai_ideas' && framed.kind === 'idea');
}

export function compactNudge(nudge: string): string {
  const oneLine = nudge.replace(/\s+/g, ' ').trim();
  const limit = PAGE_NUDGE_RESERVE - 2;
  const marker = '… [nudge shortened; read mai_board_read and mai_claims]';
  return oneLine.length <= limit ? oneLine
    : oneLine.slice(0, Math.max(0, limit - marker.length)) + marker;
}

export function finalizeToolResult<T extends BudgetableResult>(tool: string, result: T, nudge = ''): T {
  const textBlocks = result.content.filter(
    (block): block is BudgetableBlock & { text: string } => typeof block.text === 'string',
  );
  if (textBlocks.length === 0) return result;
  if (!isMcpReadTool(tool)) {
    if (nudge) textBlocks[textBlocks.length - 1].text += `\n\n${nudge}`;
    return result;
  }
  if (result.structuredContent !== undefined) {
    // Structured reads reserve the same page budget. JSON is the atomic unit;
    // a malformed/oversized producer fails closed instead of slicing its data.
    const body = result.structuredContent;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('structured read requires an object');
    const raw = JSON.stringify(body);
    if (result.content.length !== 1 || textBlocks.length !== 1
      || textBlocks[0].text !== raw || raw.length > pageBudget().charBudget) {
      const error = { error: 'structured_read_budget_contract', recovery: 'Retry with a narrower query; inspect server logs if it persists.' };
      result.structuredContent = error;
      result.content = [{ type: 'text', text: JSON.stringify(error) }];
      result.isError = true;
      return result;
    }
    const fullNudge = nudge ? compactNudge(nudge) : '';
    const marker = '… [nudge shortened; read mai_board_read and mai_claims]';
    let safeNudge = fullNudge;
    const envelope = () => safeNudge ? { ...body, coordination_nudge: safeNudge } : body;
    let output = envelope(), text = JSON.stringify(output), keep = fullNudge.length;
    // Count actual JSON escaping and field overhead, not just nudge characters.
    while (text.length > READ_CHAR_BUDGET && keep > 0) {
      safeNudge = fullNudge.slice(0, --keep) + marker;
      output = envelope(); text = JSON.stringify(output);
    }
    if (text.length > READ_CHAR_BUDGET) throw new Error('structured nudge reserve too small');
    result.structuredContent = output;
    textBlocks[0].text = text;
    return result;
  }
  const complete = textBlocks.map((block) => block.text).join('\n\n');
  if (isAtomicSelectorPage(tool, complete)) {
    // A framed recovery page is atomic. Paging reserves 512 chars; retain a
    // complete one-line advisory nudge without ever truncating the frame.
    const safeNudge = nudge ? compactNudge(nudge) : '';
    if (safeNudge && `${complete}\n\n${safeNudge}`.length <= READ_CHAR_BUDGET) {
      textBlocks[textBlocks.length - 1].text += `\n\n${safeNudge}`;
    }
    return result;
  }
  // Plan 39: an ordinary read compacts its nudge to at most
  // PAGE_NUDGE_RESERVE - 2 before appending — the same rule atomic selector
  // pages already use — so a pageBudget() producer plus separator plus nudge
  // stays at or below READ_CHAR_BUDGET and never enters fitWithPointer.
  const safeNudge = nudge ? compactNudge(nudge) : '';
  if (safeNudge) textBlocks[textBlocks.length - 1].text += `\n\n${safeNudge}`;
  const completed = textBlocks.map((block) => block.text).join('\n\n');
  const baseNarrowing = result.isError
    ? `retry ${tool} with shorter valid parameters; inspect server logs if it persists`
    : MCP_READ_NARROWING[tool];
  const narrowing = safeNudge
    ? `${baseNarrowing}; read mai_board_read and mai_claims for coordination nudges`
    : baseNarrowing;
  const capped = budgetText(mcpBudget(), completed, narrowing);
  if (capped === completed) return result;
  textBlocks[0].text = capped;
  for (const block of textBlocks.slice(1)) block.text = '';
  return result;
}
