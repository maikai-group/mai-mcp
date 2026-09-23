import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { finalizeToolResult, headlineField } from './read-budget.js';
import type { BudgetableResult, ReadSection } from './read-budget.js';

export type MaiShadowSkip = 'ineligible' | 'missing-field' | 'too-large' | 'not-shorter' | 'finalize-error';
export type MaiShadowDraft = { kind: 'candidate'; text: string } | { kind: 'skip'; reason: MaiShadowSkip };
export const MAI_SHADOW_CHAR_CAP = 3000;
export const MAI_SHADOW_POLICY_VERSION = 1;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const LOG_NAME = 'mai-read.jsonl';
const LOCK_NAME = 'mai-read.lock';
const FINDING_POINTER = 'finding:"UUID[:part]"';

export interface FindingShadowIdentity { id: string; status: string; severity: string; title: string; location: string }
export interface PlanShadowReview { pass: number; verdict: string; reviewer: string; planSha: string | null; synthesis: string | null }
export interface MaiShadowRecord {
  schemaVersion: 1; at: string; tool: 'mai_findings' | 'mai_plan'; policyVersion: 1;
  kind: 'candidate' | 'skip'; baselineChars: number; candidateChars: number | null;
  reason?: MaiShadowSkip;
}
export interface MaiShadowTotals { attempts: number; candidates: number; skips: number; baselineChars: number; candidateChars: number }
export interface MaiShadowReport {
  schemaVersion: 1; evidence: 'proxy'; hypothetical: true; status: 'observed' | 'unavailable';
  byTool: { mai_findings: MaiShadowTotals; mai_plan: MaiShadowTotals }; ignoredRows: number;
}

const skip = (reason: MaiShadowSkip): MaiShadowDraft => ({ kind: 'skip', reason });
const present = (value: string): boolean => value.trim().length > 0;

export function findingCandidate(
  sections: readonly ReadSection[], identities: readonly FindingShadowIdentity[],
  baseline: string, candidateText: string,
): MaiShadowDraft {
  const headlines = sections.flatMap((section) => section.headlineRows);
  if (identities.length === 0 || identities.length !== headlines.length
    || sections.some((section) => section.fullRows.length !== section.headlineRows.length)) return skip('missing-field');
  for (let index = 0; index < identities.length; index++) {
    const identity = identities[index];
    const headline = headlines[index];
    if (![identity.id, identity.status, identity.severity, identity.title, identity.location].every(present)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(identity.id)
      || !headline.includes(`\`${identity.id}\``)
      || !headline.includes(`${identity.severity}/${identity.status}`)
      || !headline.includes(`**${headlineField(identity.title)}**`)
      || !headline.includes(headlineField(identity.location, 320))) return skip('missing-field');
  }
  if (!candidateText || !candidateText.includes(FINDING_POINTER)) return skip('missing-field');
  if (candidateText.length > MAI_SHADOW_CHAR_CAP) return skip('too-large');
  if (candidateText.length >= baseline.length) return skip('not-shorter');
  for (const headline of headlines) {
    if (candidateText.split(headline).length !== 2) return skip('missing-field');
  }
  return { kind: 'candidate', text: candidateText };
}

export function planCandidate(
  header: string, reviews: readonly PlanShadowReview[], baseline: string,
  earlierPointer = '',
): MaiShadowDraft {
  if (!/^plan `[^`]+` \[[^\]]+\] [^\n]+\n  path: \S[^\n]*\n  sha: [0-9a-f]{64}\n  findings: \d+ open blocker\(s\), \d+ open warning\(s\), \d+ total$/u.test(header)) {
    return skip('missing-field');
  }
  const seen = new Set<number>();
  const lines: string[] = [];
  for (const review of reviews) {
    if (!Number.isSafeInteger(review.pass) || review.pass < 1 || seen.has(review.pass)
      || !present(review.verdict) || !present(review.reviewer)
      || !review.planSha || !/^[0-9a-f]{64}$/iu.test(review.planSha)) return skip('missing-field');
    seen.add(review.pass);
    lines.push(`    pass ${review.pass} [${review.verdict}] by ${review.reviewer} @ ${review.planSha}`
      + `${review.synthesis ? ` — call mai_plan with pass:"${review.pass}" for complete synthesis` : ''}`);
  }
  if (earlierPointer && !/^\n  \([1-9]\d* earlier pass\(es\) — call with pass:"N" for one complete review, or passes:"all"\)$/u.test(earlierPointer)) {
    return skip('missing-field');
  }
  const candidateText = header + (lines.length ? `\n  reviews:\n${lines.join('\n')}` : '') + earlierPointer;
  if (candidateText.length > MAI_SHADOW_CHAR_CAP) return skip('too-large');
  if (candidateText.length >= baseline.length) return skip('not-shorter');
  return { kind: 'candidate', text: candidateText };
}

function ownerOnly(stat: { uid: number; mode: number }): boolean {
  return typeof process.getuid !== 'function' || (stat.uid === process.getuid() && (stat.mode & 0o077) === 0);
}

async function privateRoot(root: string, create: boolean): Promise<boolean> {
  try {
    if (create) await mkdir(root, { recursive: true, mode: 0o700 });
    const stat = await lstat(root);
    return stat.isDirectory() && !stat.isSymbolicLink() && ownerOnly(stat);
  } catch (error) {
    if (!create && error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSkipReason(value: unknown): value is MaiShadowSkip {
  return value === 'ineligible' || value === 'missing-field' || value === 'too-large'
    || value === 'not-shorter' || value === 'finalize-error';
}

function parseRow(value: unknown): MaiShadowRecord | null {
  if (!isRecord(value)) return null;
  const row = value;
  const keys = Object.keys(row).sort();
  const required = ['at', 'baselineChars', 'candidateChars', 'kind', 'policyVersion', 'schemaVersion', 'tool'];
  if (row.reason !== undefined) required.push('reason');
  if (JSON.stringify(keys) !== JSON.stringify(required.sort())
    || row.schemaVersion !== 1 || row.policyVersion !== 1
    || typeof row.at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(row.at)
    || (row.tool !== 'mai_findings' && row.tool !== 'mai_plan')
    || (row.kind !== 'candidate' && row.kind !== 'skip')
    || !isCount(row.baselineChars)
    || (row.candidateChars !== null && !isCount(row.candidateChars))) return null;
  if (row.kind === 'candidate') {
    if (row.candidateChars === null || row.reason !== undefined) return null;
    return { schemaVersion: 1, at: row.at, tool: row.tool, policyVersion: 1,
      kind: 'candidate', baselineChars: row.baselineChars, candidateChars: row.candidateChars };
  }
  if (row.candidateChars !== null || !isSkipReason(row.reason)) return null;
  return { schemaVersion: 1, at: row.at, tool: row.tool, policyVersion: 1,
    kind: 'skip', baselineChars: row.baselineChars, candidateChars: null, reason: row.reason };
}

/** A writer releases only the pathname that still names its acquired lock. */
export async function releaseMaiShadowLockIfOwned(
  lockPath: string, expected: { dev: number; ino: number },
): Promise<void> {
  let current: Awaited<ReturnType<typeof lstat>>;
  try { current = await lstat(lockPath); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  if (current.isFile() && !current.isSymbolicLink()
    && current.dev === expected.dev && current.ino === expected.ino) await unlink(lockPath);
}

export async function appendMaiShadowRecord(root: string, row: MaiShadowRecord): Promise<void> {
  if (!parseRow(row)) throw new Error('invalid MAI shadow row');
  if (!await privateRoot(root, true)) throw new Error('unsafe MAI shadow directory');
  const line = Buffer.from(`${JSON.stringify(row)}\n`, 'utf8');
  if (line.byteLength > MAX_LOG_BYTES) throw new Error('MAI shadow row exceeds log bound');
  const lockPath = join(root, LOCK_NAME);
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 8; attempt++) {
    try { lock = await open(lockPath, 'wx', 0o600); break; }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      if (attempt < 7) await delay(25);
    }
  }
  if (!lock) throw new Error('MAI shadow log busy');
  let ownedLock: { dev: number; ino: number } | undefined;
  try {
    const lockStat = await lock.stat();
    ownedLock = { dev: lockStat.dev, ino: lockStat.ino };
    if (!lockStat.isFile() || !ownerOnly(lockStat)) throw new Error('unsafe MAI shadow lock');
    const file = await open(join(root, LOG_NAME), constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      const stat = await file.stat();
      const pathStat = await lstat(join(root, LOG_NAME));
      if (!stat.isFile() || !ownerOnly(stat) || pathStat.isSymbolicLink()
        || pathStat.ino !== stat.ino || pathStat.dev !== stat.dev) throw new Error('unsafe MAI shadow log');
      if (stat.size + line.byteLength > MAX_LOG_BYTES) return;
      await file.writeFile(line);
    } finally { await file.close(); }
  } finally {
    await lock.close();
    if (ownedLock) await releaseMaiShadowLockIfOwned(lockPath, ownedLock);
  }
}

const emptyTotals = (): MaiShadowTotals => ({ attempts: 0, candidates: 0, skips: 0, baselineChars: 0, candidateChars: 0 });
function emptyReport(status: 'observed' | 'unavailable'): MaiShadowReport {
  return { schemaVersion: 1, evidence: 'proxy', hypothetical: true, status,
    byTool: { mai_findings: emptyTotals(), mai_plan: emptyTotals() }, ignoredRows: 0 };
}

async function readMaiShadowReportUnsafe(root: string): Promise<MaiShadowReport> {
  if (!await privateRoot(root, false)) return emptyReport('unavailable');
  let file: Awaited<ReturnType<typeof open>>;
  try { file = await open(join(root, LOG_NAME), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return emptyReport('unavailable');
    throw error;
  }
  try {
    const stat = await file.stat();
    const pathStat = await lstat(join(root, LOG_NAME));
    if (!stat.isFile() || !ownerOnly(stat) || pathStat.isSymbolicLink()
      || pathStat.ino !== stat.ino || pathStat.dev !== stat.dev || stat.size > MAX_LOG_BYTES) return emptyReport('unavailable');
    const report = emptyReport('observed');
    const raw = await file.readFile({ encoding: 'utf8' });
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { report.ignoredRows++; continue; }
      const row = parseRow(value);
      if (!row) { report.ignoredRows++; continue; }
      const totals = report.byTool[row.tool];
      totals.attempts++;
      totals.baselineChars += row.baselineChars;
      if (row.kind === 'candidate') {
        totals.candidates++;
        totals.candidateChars += row.candidateChars ?? 0;
      } else totals.skips++;
    }
    return report;
  } finally { await file.close(); }
}

export async function readMaiShadowReport(root: string): Promise<MaiShadowReport> {
  try { return await readMaiShadowReportUnsafe(root); }
  catch { return emptyReport('unavailable'); }
}

export function renderMaiShadowReport(report: MaiShadowReport): string {
  if (report.status === 'unavailable') return 'MAI read shadow log unavailable. No character proxy observed.';
  const lines = ['MAI read shadow: hypothetical character proxy; no measured token or cost savings.'];
  const tools: readonly ('mai_findings' | 'mai_plan')[] = ['mai_findings', 'mai_plan'];
  for (const tool of tools) {
    const totals = report.byTool[tool];
    lines.push(`${tool}: ${totals.attempts} attempts, ${totals.candidates} candidates, ${totals.skips} skips; baseline ${totals.baselineChars} chars, candidates ${totals.candidateChars} chars`);
  }
  lines.push(`${report.ignoredRows} malformed row(s) ignored.`);
  return lines.join('\n');
}

export async function measureAndRecordMaiShadow(
  root: string, tool: 'mai_findings' | 'mai_plan', delivered: BudgetableResult,
  draft: MaiShadowDraft, nudge: string,
): Promise<void> {
  if (delivered.isError || delivered.structuredContent !== undefined
    || delivered.content.length !== 1 || typeof delivered.content[0].text !== 'string') return;
  const baselineChars = delivered.content[0].text.length;
  let result: MaiShadowDraft = draft;
  let candidateChars: number | null = null;
  if (draft.kind === 'candidate') {
    try {
      const copy: BudgetableResult = { content: [{ type: 'text', text: draft.text }] };
      finalizeToolResult(tool, copy, nudge);
      const text = copy.content[0]?.text;
      if (typeof text !== 'string') result = skip('finalize-error');
      else if (text.length >= baselineChars) result = skip('not-shorter');
      else candidateChars = text.length;
    } catch { result = skip('finalize-error'); }
  }
  await appendMaiShadowRecord(root, {
    schemaVersion: 1, at: new Date().toISOString(), tool, policyVersion: MAI_SHADOW_POLICY_VERSION,
    kind: result.kind, baselineChars, candidateChars,
    ...(result.kind === 'skip' ? { reason: result.reason } : {}),
  });
}
