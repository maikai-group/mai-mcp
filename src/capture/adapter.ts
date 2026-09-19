// Capture-adapter layer — makes automatic capture pluggable per harness.
// Mirrors src/llm/provider.ts: the factory imports the concrete adapter class;
// the class type-imports the interface back (no runtime cycle).
//
// The write-gates and MCP tool surface are NOT here — they are server-side
// (src/write-gate.ts + tool handlers) and already work in any MCP client. This
// layer is only the capture/automation half (install wiring + transcript parse).
import type { ParsedSession } from '../ingest.js';
import type { TranscriptEntry, SegmentationOpts } from './segment.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { CodexAdapter } from './codex.js';
import { GenericAdapter } from './generic.js';

/** One file rewrite an upgrade wants to make. `newContent` is the FULL new
 * file body — the runner only prints diffs and writes; adapters do the thinking. */
export interface PlannedChange {
  file: string;       // absolute path
  label: string;      // e.g. "CLAUDE.md brain block legacy → v2"
  legacy: boolean;    // legacy-block migration (heuristic extent — needs eyes)
  before: string;     // the replaced region (or pretty JSON excerpt)
  after: string;
  newContent: string;
  /** Exact whole-file bytes used to derive newContent. Required by consumers
   * that apply a previously reviewed whole-file projection (mai link/upgrade).
   * null = the file did not exist when the change was planned. */
  preimage: string | null;
}

/** Per-file status from wiring a harness into a repo. */
export interface InstallResult {
  harness: string;
  lines: string[]; // e.g. [".mcp.json created", "hooks unchanged", "CLAUDE.md updated"]
}

export interface UpgradeOpts {
  agentId?: string;
  /** Plan 27: the project's graduated-rules block, rendered ONCE by the
   * upgrade runner. undefined (a caller that did not render) = do not plan
   * graduated-block changes — a defaulted empty render here would plan
   * ERASING live rules. */
  graduatedRulesBlock?: string;
  /** Plan 31: the project's declared cross-project links
   * (projects.metadata.linked_projects), rendered into MAI_LINKED_PROJECTS.
   * undefined = caller has no DB context — adapters preserve the value already
   * in the file; [] = explicitly none. */
  linkedProjects?: readonly string[];
}

/** Whether a harness is present / already mai-wired in a repo. */
export interface AdapterStatus {
  harness: string;
  present: boolean;   // harness config detected in this repo
  installed: boolean; // mai wiring already present
  detail?: string;
}

export interface CaptureAdapter {
  readonly harness: string;
  /** Wire this harness for capture in a repo (idempotent). */
  install(repoPath: string, slug: string): Promise<InstallResult>;
  /** Detect whether this harness is present / already installed in a repo. */
  detect(repoPath: string): Promise<AdapterStatus>;
  /** Plan the refresh of already-installed wiring to current templates.
   * Never creates wiring (init's job); returns [] when everything is current. */
  planUpgrade(repoPath: string, slug: string, opts?: UpgradeOpts): Promise<PlannedChange[]>;
  /** Parse one of this harness's session transcripts into the neutral shape. */
  parseTranscript(transcriptPath: string): Promise<ParsedSession>;
  /** Stream a transcript as neutral entries, in file order, from a byte offset. */
  readEntries(transcriptPath: string, fromOffset?: number): AsyncIterable<TranscriptEntry>;
  /** Build a ParsedSession from one contiguous run of entries. */
  parseEntries(entries: TranscriptEntry[]): ParsedSession;
  /** Per-harness threshold overrides; shared defaults apply when omitted. */
  readonly segmentation?: Partial<SegmentationOpts>;
}

/** Options threaded to adapters that take configuration (generic: rules file). */
export interface AdapterOpts {
  rulesFile?: string;
}

// Single source of truth: the registry drives the list, the factory, and the
// error message (B1 review note — a switch + hand-maintained list can drift).
const REGISTRY: Record<string, (opts?: AdapterOpts) => CaptureAdapter> = {
  'claude-code': () => new ClaudeCodeAdapter(),
  codex: () => new CodexAdapter(),
  generic: (opts) => new GenericAdapter(opts?.rulesFile),
};

/** Harnesses with a capture adapter. */
export function listCaptureAdapters(): string[] {
  return Object.keys(REGISTRY);
}

/** Resolve a capture adapter by harness id; throws on unknown. */
export function getCaptureAdapter(harness: string, opts?: AdapterOpts): CaptureAdapter {
  const make = REGISTRY[harness];
  if (!make) {
    throw new Error(
      `Unknown harness '${harness}'. Supported: ${listCaptureAdapters().join(', ')}.`
    );
  }
  return make(opts);
}
