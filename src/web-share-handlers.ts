// Share routes for mai-brain-web (plan 31). Operator surface: the dashboard
// selects the project per request (?project=<slug>) exactly like every other
// route — the MCP pinning guarantee is unaffected. Grant/revoke here record
// created_via='dashboard' in the audit trail.
import {
  shareCreate, shareRevoke, sharesOperatorView, shareEventsForProject,
  shareCandidates, linkedProjectsForSlug, shareLinkStates, SHARE_KINDS, type ShareKind,
} from './shares.js';
import { projectSlugById } from './db.js';

export class ShareClientError extends Error {
  readonly status = 400;
}
export type ShareGetHandler = (url: URL) => Promise<Record<string, unknown>>;
export type SharePostHandler = (body: Record<string, unknown>, url: URL) => Promise<Record<string, unknown>>;
export type ShareProjectResolver = (url: URL) => Promise<string>;

// Cast-free narrowing: scripts/check-no-casts.mjs is a whole-tree per-file
// ratchet and a new file's baseline is zero — `SHARE_KINDS as readonly
// string[]` would fail the gate.
function isShareKind(v: string): v is ShareKind {
  return SHARE_KINDS.some((k) => k === v);
}
function qs(url: URL, name: string): string | undefined {
  const v = url.searchParams.get(name);
  return v === null || v === '' ? undefined : v;
}
function bodyStr(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || v.trim() === '') throw new ShareClientError(`missing required field: ${key}`);
  return v;
}
function bodyStrOpt(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new ShareClientError(`field '${key}' must be a string`);
  return v;
}

export function createShareGetHandlers(project: ShareProjectResolver): Record<string, ShareGetHandler> {
  return {
    '/api/shares': async (url) => {
      const projectId = await project(url);
      const d = qs(url, 'direction') ?? 'both';
      if (d !== 'in' && d !== 'out' && d !== 'both') throw new ShareClientError("direction must be in|out|both");
      const slug = await projectSlugById(projectId);
      return {
        rows: await sharesOperatorView(projectId, d),
        declared_links: await linkedProjectsForSlug(slug),
        link_states: await shareLinkStates(projectId),
      };
    },
    '/api/share-events': async (url) => {
      try {
        const page = await shareEventsForProject(await project(url), { cursor: qs(url, 'cursor') });
        return { rows: page.rows, next_cursor: page.next_cursor };
      } catch (err) {
        if (err instanceof Error && err.message === 'invalid audit cursor') {
          throw new ShareClientError(err.message);
        }
        throw err;
      }
    },
    '/api/share-candidates': async (url) => {
      const kind = qs(url, 'kind');
      const q = qs(url, 'q') ?? '';
      if (kind === undefined || !isShareKind(kind)) throw new ShareClientError('kind must be decision|doc|handoff|idea');
      return { rows: await shareCandidates(await project(url), kind, q) };
    },
  };
}

export function createSharePostHandlers(project: ShareProjectResolver): Record<string, SharePostHandler> {
  return {
    '/api/shares': async (body, url) => {
      const kind = bodyStr(body, 'kind');
      if (!isShareKind(kind)) throw new ShareClientError('kind must be decision|doc|handoff|idea');
      return {
        message: await shareCreate({
          sourceProjectId: await project(url),
          targetSlug: bodyStr(body, 'target_slug'),
          kind,
          artifactId: bodyStrOpt(body, 'artifact_id'),
          docPath: bodyStrOpt(body, 'doc_path'),
          docRepoRoot: bodyStrOpt(body, 'doc_repo_root'),
          docHeading: bodyStrOpt(body, 'doc_heading'),
          note: bodyStrOpt(body, 'note'),
          createdVia: 'dashboard',
        }),
      };
    },
    '/api/shares/revoke': async (body, url) => ({
      message: await shareRevoke({
        shareId: bodyStr(body, 'share_id'),
        reason: bodyStr(body, 'reason'),
        via: 'dashboard',
        projectId: await project(url),
      }),
    }),
  };
}
