// Shared CLI plumbing — argv-derived types and helpers used by cli.ts AND the
// coordination facade's cliClaims. Extracted so the facade can consume the same
// ParsedArgs shape the CLI registry passes (a string[] signature cannot carry
// cmdClaims's positional/flag logic). Imports nothing from cli.ts or the facade.
import { resolveProjectId } from "./db.js";

export interface ParsedArgs {
  verb: string;
  positional: string[];
  flags: Record<string, string | true>;
  /** The exact argv this parse consumed (Plan 15 Task 3): repeated-flag
   * collectors read THIS, never the module-global process.argv. */
  argv?: string[];
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  return typeof v === "string" ? v : undefined;
}

export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const v = flagString(args, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === "1";
}

export function requirePositional(args: ParsedArgs, index: number, name: string): string {
  const v = args.positional[index];
  if (!v) throw new Error(`missing required argument: <${name}>`);
  return v;
}

export function requireFlag(args: ParsedArgs, name: string): string {
  const v = flagString(args, name);
  if (!v) throw new Error(`missing required flag: --${name}`);
  return v;
}

// ---------- color helper ----------

export function color(code: string, s: string): string {
  return process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s;
}

export const dim = (s: string): string => color("90", s);
export const green = (s: string): string => color("32", s);

/**
 * Resolve the project for a read/curation command:
 *   --project <slug>  → that project's id (any project)
 *   else, MAI_PROJECT_SLUG set → undefined (the pinned default)
 *   else → a clear "select a project" error.
 */
export async function pid(args: ParsedArgs): Promise<string | undefined> {
  const slug = flagString(args, "project");
  if (slug) return resolveProjectId(slug);
  if (!process.env.MAI_PROJECT_SLUG) {
    throw new Error(
      "no project selected — pass --project <slug> (or set MAI_PROJECT_SLUG). Run `mai projects` to list."
    );
  }
  return undefined; // pinned default (functions fall back to getProjectId())
}
