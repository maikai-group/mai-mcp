import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { record, normalizeInput } from '../navigation/input.js';
import { captureNavigation } from '../navigation/pilot.js';
import type { Input } from '../navigation/types.js';
import type { BuildInfo } from '../build-info.js';

export type PilotGitRead = (args: string[], cwd: string) => Promise<string>;
const execFileAsync = promisify(execFile);
const readPilotGit: PilotGitRead = async (args, cwd) => {
  const { stdout } = await execFileAsync('git', args, {
    cwd, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout;
};

export interface PilotSourceIdentity { head: string; buildCommit: string; clean: true }
export async function verifyPilotSource(
  build: BuildInfo | null, expected: string, cwd: string, readGit: PilotGitRead = readPilotGit,
): Promise<PilotSourceIdentity> {
  try {
    if (!build || build.dirty || !/^[0-9a-f]{4,40}$/.test(build.sha)
      || !/^[0-9a-f]{40}$/.test(expected)) throw Error('unverified source');
    const head = (await readGit(['rev-parse', '--verify', 'HEAD^{commit}'], cwd)).trim();
    if (!/^[0-9a-f]{40}$/.test(head) || head !== expected) throw Error('unverified source');
    // Resolve even abbreviated stamps through Git: a shared prefix is not identity.
    const buildCommit = (await readGit([
      'rev-parse', '--verify', '--end-of-options', `${build.sha}^{commit}`,
    ], cwd)).trim();
    if (buildCommit !== head) throw Error('unverified source');
    const status = await readGit([
      'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none',
    ], cwd);
    if (status !== '') throw Error('unverified source');
    return { head, buildCommit, clean: true };
  } catch {
    // Missing Git/repository, ambiguous commits and command failures all reject.
    throw Error('unverified source');
  }
}

export interface PilotCase { caseId: string; sourceRevision: string; input: Input }
export function parsePilotCase(raw: unknown): PilotCase {
  const item = record(raw, ['caseId', 'sourceRevision', 'input']);
  if (typeof item.caseId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(item.caseId)
    || typeof item.sourceRevision !== 'string' || !/^[0-9a-f]{40}$/.test(item.sourceRevision)) {
    throw Error('invalid pilot identity');
  }
  return { caseId: item.caseId, sourceRevision: item.sourceRevision,
    input: normalizeInput(item.input) };
}

export function reserveReceipt(directory: string): number {
  fs.mkdirSync(directory, { mode: 0o700 });
  try {
    return fs.openSync(path.join(directory, 'receipt.json'), 'wx', 0o600);
  } catch (error) {
    // Only remove the new directory if still empty; never recurse.
    try { fs.rmdirSync(directory); } catch { /* Preserve unexpected contents. */ }
    throw error;
  }
}

export async function main(
  args = process.argv.slice(2), readGit: PilotGitRead = readPilotGit,
): Promise<number> {
  const [mode, caseFile, out, consent, ...extra] = args;
  if ((mode !== 'prepare' && mode !== 'live') || !caseFile || !out || extra.length
    || (mode === 'live' ? consent !== '--allow-live' : consent !== undefined)) {
    console.error('usage: navigation-pilot prepare CASE NEW_DIR | live CASE NEW_DIR --allow-live');
    return 2;
  }
  let fd: number | undefined;
  let close: (() => Promise<void>) | undefined;
  try {
    if (fs.statSync(caseFile).size > 32 * 1024) throw Error('oversize case');
    const raw: unknown = JSON.parse(fs.readFileSync(caseFile, 'utf8'));
    const sample = parsePilotCase(raw);
    // Resolve dependencies only after strict arguments/case validation.
    const { readBuildInfo } = await import('../build-info.js');
    const { MAI_ROOT } = await import('../paths.js');
    const build = await readBuildInfo();
    const sourceIdentity = await verifyPilotSource(build, sample.sourceRevision, MAI_ROOT, readGit);
    const db = await import('../db.js'); close = db.closePool;
    const projectId = await db.getProjectId();
    const { createPorts } = await import('../navigation/retrieval.js');
    const { evaluate } = await import('../navigation/provider.js');
    const { resolveJevConfig } = await import('../providers/runtime.js');
    const abort = new AbortController();
    const config = mode === 'live' ? await resolveJevConfig(projectId, abort.signal) : null;
    if (mode === 'live' && config?.state !== 'ready') {
      console.error(`pilot unavailable: ${config?.state ?? 'unavailable'}`);
      return 2;
    }
    if (config?.state === 'ready' && config.config.model !== 'jev-1.13.0') {
      console.error('pilot requires the pinned jev-1.13.0 configuration'); return 2;
    }
    fd = reserveReceipt(out);
    const cancel = () => abort.abort();
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    try {
      const resolved = config?.state === 'ready' ? config.config : { key: '', model: 'jev-1.13.0' };
      const capture = await captureNavigation(mode, sample.input, resolved,
        { ports: createPorts(projectId), evaluate, now: Date.now }, abort.signal);
      fs.writeFileSync(fd, JSON.stringify({ caseId: sample.caseId,
        sourceRevision: sample.sourceRevision, sourceIdentity, build, projectId, capture }, null, 2) + '\n');
      console.log(`pilot receipt saved; mode=${mode}; status=${capture.report.status}`);
      return capture.report.status === 'cancelled' ? 2 : 0;
    } finally {
      process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
    }
  } catch {
    console.error('pilot failed; check case, clean build, project configuration and new output path');
    return 2;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (close) await close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
