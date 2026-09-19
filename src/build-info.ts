/** Validated runtime reader for build/build-info.json (Plan 15 Task 1).
 * Cast-free: everything parses as unknown and narrows through isRecord.
 * BOOT_BUILD_INFO is the identity of the running process's build, captured
 * once at module evaluation; buildRestartBanner compares it to the stamp on
 * disk so a stale running MCP server becomes observable through prime. */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { MAI_ROOT } from './paths.js';

const execFileAsync = promisify(execFile);

export interface BuildInfo {
  version: string;
  sha: string;
  dirty: boolean;
  builtAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DEFAULT_FILE = path.join(MAI_ROOT, 'build', 'build-info.json');

/** Exactly the four fields, exact types, parseable ISO timestamp — anything
 * else (extra keys included) is null, never a guess. */
function parseBuildInfo(text: string): BuildInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (Object.keys(parsed).sort().join(',') !== 'builtAt,dirty,sha,version') return null;
  const { version, sha, dirty, builtAt } = parsed;
  if (typeof version !== 'string' || version.length === 0) return null;
  if (typeof sha !== 'string' || sha.length === 0) return null;
  if (typeof dirty !== 'boolean') return null;
  if (typeof builtAt !== 'string' || !Number.isFinite(Date.parse(builtAt))) return null;
  return { version, sha, dirty, builtAt };
}

export async function readBuildInfo(
  file: string = DEFAULT_FILE
): Promise<BuildInfo | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  return parseBuildInfo(text);
}

function readBuildInfoSync(file: string): BuildInfo | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  return parseBuildInfo(text);
}

export const BOOT_BUILD_INFO: BuildInfo | null = readBuildInfoSync(DEFAULT_FILE);

export function formatBuildFingerprint(info: BuildInfo): string {
  return `${info.version} ${info.sha}${info.dirty ? '+dirty' : ''} @ ${info.builtAt}`;
}

/** The exact maximum of the BUDGETED banner: two 12-character displayed SHAs
 * and two ordinary 24-character canonical timestamps. ONE authority — the
 * composer and every fixture read it from here. */
export const RESTART_BANNER_MAX = 173;

/**
 * Bounded display identity for a build timestamp. Ordinary ISO values (24
 * chars) render byte-complete; JavaScript's accepted expanded-year form (27
 * chars) renders as the exact signed epoch-millisecond integer instead, which
 * is at most 19 characters because every valid Date lies within ±8.64e15 ms.
 * This is a DISPLAY identity, not a claim that arbitrary input survives.
 */
export function boundedBuildTime(value: string): string {
  const date = new Date(value);
  const iso = date.toISOString();
  return iso.length === 24 ? iso : `${date.getTime()}ms`;
}

/** Byte-complete through 12 characters; longer identities keep their first 6
 * and last 5 around one ellipsis, so a changed build stays visible. */
export function boundedBuildSha(sha: string): string {
  return sha.length <= 12 ? sha : `${sha.slice(0, 6)}…${sha.slice(-5)}`;
}

/** Pure banner text. The RAW sha/builtAt equality decides whether a banner
 * exists at all, so compaction can never hide a changed build. */
export function renderRestartBanner(boot: BuildInfo, disk: BuildInfo, budgeted = false): string | null {
  if (boot.sha === disk.sha && boot.builtAt === disk.builtAt) return null;
  const sha = (info: BuildInfo): string => (budgeted ? boundedBuildSha(info.sha) : info.sha);
  const at = (info: BuildInfo): string => (budgeted ? boundedBuildTime(info.builtAt) : info.builtAt);
  return (
    `⚠ mai-mcp: serving build ${sha(boot)}@${at(boot)}; on disk is ` +
    `${sha(disk)}@${at(disk)} — restart Claude Code/Codex to activate the new MCP surface.`
  );
}

export async function buildRestartBanner(
  boot: BuildInfo | null = BOOT_BUILD_INFO,
  diskFile: string = DEFAULT_FILE,
  budgeted = false
): Promise<string | null> {
  if (boot === null) return null;
  const disk = await readBuildInfo(diskFile);
  if (disk === null) return null;
  return renderRestartBanner(boot, disk, budgeted);
}

export async function sourceBuildStatus(
  info: BuildInfo | null = BOOT_BUILD_INFO,
  cwd: string = MAI_ROOT
): Promise<{ fingerprint: string; stale: boolean; detail?: string }> {
  if (info === null) {
    return {
      fingerprint: 'unknown',
      stale: false,
      detail: 'missing or malformed build-info — run npm run build',
    };
  }
  const fingerprint = formatBuildFingerprint(info);
  if (info.sha === 'unknown') {
    // A release build outside git reports its identity and is never stale.
    return { fingerprint, stale: false };
  }
  let headSha: string;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    headSha = stdout.trim();
  } catch {
    return { fingerprint, stale: false };
  }
  if (headSha === info.sha) return { fingerprint, stale: false };
  return { fingerprint, stale: true, detail: 'build is behind source — run npm run build' };
}
