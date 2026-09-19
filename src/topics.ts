import fs from 'node:fs/promises';
import path from 'node:path';
import { contextDir } from './paths.js';
import { demandCapPrimeMinimum } from './prime-budget.js';
import { budgetRows, budgetText, MCP_READ_NARROWING, type ReadBudget } from './read-budget.js';

/**
 * Data-driven topic catalog. Topics are markdown files in docs/context/<slug>/
 * with YAML frontmatter: title, when, keywords (comma-separated), always (bool).
 * Files without frontmatter still appear (filename as title, no keywords).
 * Files/dirs starting with '_' are skipped (e.g. _drafts/ from mai init, Plan 3).
 */
export interface TopicEntry {
  topic: string;
  title: string;
  whenToLoad: string;
  keywords: string[];
  always: boolean;
}

interface ParsedTopicFile {
  entry: TopicEntry;
  body: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

function parseFrontmatter(topic: string, raw: string): ParsedTopicFile {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) {
    return {
      entry: { topic, title: topic, whenToLoad: '', keywords: [], always: false },
      body: raw,
    };
  }
  const fields = new Map<string, string>();
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) fields.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
  }
  return {
    entry: {
      topic,
      title: fields.get('title') ?? topic,
      whenToLoad: fields.get('when') ?? '',
      keywords: (fields.get('keywords') ?? '')
        .split(',')
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean),
      always: fields.get('always') === 'true',
    },
    body: raw.slice(m[0].length),
  };
}

async function readTopicFile(topic: string): Promise<ParsedTopicFile | null> {
  try {
    const raw = await fs.readFile(path.join(contextDir(), `${topic}.md`), 'utf8');
    return parseFrontmatter(topic, raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * The catalog read, returning the ALREADY-PARSED files. Task-scoped prime
 * selects from these objects and renders their carried bodies, so preparation
 * reads each topic file exactly once (plan 38 R5).
 */
async function readCatalog(): Promise<ParsedTopicFile[]> {
  let files: string[];
  try {
    files = await fs.readdir(contextDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const topics = files
    .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    .map((f) => f.slice(0, -3))
    .sort();
  const parsed = await Promise.all(topics.map(readTopicFile));
  return parsed.filter((p): p is ParsedTopicFile => p !== null);
}

export async function listTopics(): Promise<TopicEntry[]> {
  return (await readCatalog()).map((p) => p.entry);
}

export async function formatCatalogMarkdown(): Promise<string> {
  const catalog = await listTopics();
  if (catalog.length === 0) {
    return `# mai-mcp — context topics\n\nNo topics authored yet for this project. Add markdown files under docs/context/<slug>/ in the mai-mcp repo (YAML frontmatter: title, when, keywords, always).`;
  }
  const rows = catalog
    .map((t) => `| \`${t.topic}\` | ${t.title} | ${t.whenToLoad} |`)
    .join('\n');
  return [
    '# mai-mcp — context topic catalog',
    '',
    'Call `mai_get_context(topic)` to load one topic, or `mai_prime(task_description)` to auto-select.',
    '',
    '| Topic | What it covers | Load when |',
    '|---|---|---|',
    rows,
  ].join('\n');
}

export async function getContext(topic: string, budget?: ReadBudget): Promise<string> {
  const parsed = await readTopicFile(topic);
  if (!parsed) {
    const catalog = await listTopics();
    const available = catalog.map((t) => t.topic).join(', ') || '(none authored yet)';
    throw new Error(`Unknown topic "${topic}". Available: ${available}.`);
  }
  const body = parsed.body.trim();
  // ONE body, so there are no rows to pack: the shortened shape is the H1 plus
  // the first non-empty non-heading paragraph, derived from the body already
  // read — never a second read of the file (plan 23, Task 4).
  if (budget === undefined || body.length <= budget.charBudget) return body;
  const blocks = body.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const h1 = blocks.find((b) => b.startsWith('# '));
  const para = blocks.find((b) => !b.startsWith('#'));
  const headline = [h1, para].filter(Boolean).join('\n\n') || body;
  // R9: an omitted body ALWAYS says what was withheld and how to fetch it —
  // the shortened text is usually small, so this pointer cannot be left to
  // budgetText's truncation branch.
  const pointer = `_Context shortened: ${body.length} chars exceeded ${budget.charBudget}. ` +
    `To read the whole topic, ${MCP_READ_NARROWING.mai_get_context}._`;
  return budgetText(budget, `${headline}\n\n${pointer}`, MCP_READ_NARROWING.mai_get_context);
}

/** The always/keyword selection — ONE pure rule, shared by both prime paths. */
export function selectPrimeTopics(
  catalog: readonly TopicEntry[], taskDescription: string,
): TopicEntry[] {
  const lower = taskDescription.toLowerCase();
  const base = catalog.filter((t) => t.always);
  const scored = catalog
    .filter((t) => !t.always)
    .map((entry) => {
      const hits = entry.keywords.filter((k) => {
        const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${escaped}\\b`, 'i').test(lower);
      }).length;
      return { entry, hits };
    })
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .map((s) => s.entry);
  return [...base, ...scored].slice(0, 4); // cap at 4 to stay lean
}

export async function primeTopics(taskDescription: string): Promise<TopicEntry[]> {
  return selectPrimeTopics(await listTopics(), taskDescription);
}

/** Pull `## TL;DR` section from a body; null when absent. */
export function extractTldr(body: string): string | null {
  const match = body.match(/(^|\n)## TL;DR\s*\n([\s\S]*?)(?=\n## |\n# |$)/);
  if (!match) return null;
  return `## TL;DR\n${match[2].trim()}`;
}

export async function getPrimedContext(
  topics: TopicEntry[],
  mode: 'summary' | 'full'
): Promise<string> {
  const sections = await Promise.all(
    topics.map(async (t) => {
      const body = await getContext(t.topic);
      if (mode === 'full') return `## Topic: ${t.topic} — ${t.title}\n\n${body}`;
      const h1Match = body.match(/^# .+/m);
      const h1 = h1Match ? h1Match[0] : `# ${t.title}`;
      const tldr = extractTldr(body);
      return `## Topic: ${t.topic} — ${t.title}\n\n${h1}\n\n${tldr ?? body}`;
    })
  );
  return sections.join('\n\n---\n\n');
}

// ---------- Task-scoped prime preparation (plan 38) ----------

const TOPIC_SECTION_SEPARATOR = '\n\n---\n\n';
const TOPIC_RECOVERY_MINIMUM = '_mai_get_context for the complete matched topics._';

export interface PreparedPrimeTopics {
  topics: readonly TopicEntry[];
  minimum: string;
  full: string;
  render(charBudget?: number): string;
}

interface PreparedTopicRow { full: string; headline: string }

/** The complete section for one topic — byte-identical to `getPrimedContext`. */
function primeTopicSection(entry: TopicEntry, body: string, mode: 'summary' | 'full'): string {
  const label = `## Topic: ${entry.topic} — ${entry.title}`;
  if (mode === 'full') return `${label}\n\n${body}`;
  const h1Match = body.match(/^# .+/m);
  const h1 = h1Match ? h1Match[0] : `# ${entry.title}`;
  const tldr = extractTldr(body);
  return `${label}\n\n${h1}\n\n${tldr ?? body}`;
}

/** The shortened row: label, H1, then the TL;DR or the first prose paragraph. */
function primeTopicHeadline(entry: TopicEntry, body: string): string {
  const label = `## Topic: ${entry.topic} — ${entry.title}`;
  const blocks = body.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const h1Match = body.match(/^# .+/m);
  const h1 = h1Match ? h1Match[0] : `# ${entry.title}`;
  const tldr = extractTldr(body);
  const summary = tldr ?? blocks.find((b) => !b.startsWith('#'));
  return [label, h1, summary].filter(Boolean).join('\n\n');
}

/**
 * Select and render task-prime topics from ONE parsed catalog read: no second
 * `readTopicFile`, `getContext`, or `primeTopics` call on this path. An empty
 * selection is a genuinely empty source — zero demand, zero share, no shell —
 * so its floor returns to the priority allocation (plan 38 R3).
 */
export async function preparePrimeTopics(
  taskDescription: string,
  mode: 'summary' | 'full',
): Promise<PreparedPrimeTopics> {
  const catalog = await readCatalog();
  const bodies = new Map(catalog.map((p) => [p.entry.topic, p.body.trim()]));
  const topics = selectPrimeTopics(catalog.map((p) => p.entry), taskDescription);
  if (topics.length === 0) return { topics: [], minimum: '', full: '', render: () => '' };

  const rows: PreparedTopicRow[] = topics.map((entry) => {
    const body = bodies.get(entry.topic) ?? '';
    return {
      full: primeTopicSection(entry, body, mode),
      headline: primeTopicHeadline(entry, body),
    };
  });
  const renderFull = (items: readonly PreparedTopicRow[]): string =>
    items.map((row) => row.full).join(TOPIC_SECTION_SEPARATOR);
  const full = renderFull(rows);
  const minimum = demandCapPrimeMinimum(full, TOPIC_RECOVERY_MINIMUM);
  return {
    topics,
    minimum,
    full,
    render(charBudget?: number): string {
      return budgetRows(
        charBudget === undefined ? undefined : { fullRows: rows.length, charBudget },
        rows, renderFull, (row) => row.headline, '', 'topic',
        MCP_READ_NARROWING.mai_get_context, minimum,
      );
    },
  };
}
