import { decisionPromote, decisionRetract, decisionUnretract } from './decisions.js';
import { factPromote, factRetract, factUnretract } from './facts.js';
import {
  curationKeep, curationRetire, curationUnretire, curationApply, curationDismiss,
  curationPromote, curationReject,
  type CandidateBasis, type CuratedKind,
} from './curation.js';

export class ReviewClientError extends Error {
  readonly status = 400;
}
export type ReviewPostHandler = (
  body: Record<string, unknown>, url: URL
) => Promise<Record<string, unknown>>;
export type ReviewProjectResolver = (url: URL) => Promise<string>;

function bodyString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ReviewClientError(`field '${key}' must be a non-empty string`);
  }
  return v;
}
function bodyStringOpt(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new ReviewClientError(`field '${key}' must be a string`);
  return v;
}
function bodyNumberOpt(body: Record<string, unknown>, key: string): number | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ReviewClientError(`field '${key}' must be a number`);
  }
  return v;
}
function bodyKind(body: Record<string, unknown>): 'decision' | 'fact' {
  const v = bodyStringOpt(body, 'kind') ?? 'decision';
  if (v !== 'decision' && v !== 'fact') {
    throw new ReviewClientError(`field 'kind' must be 'decision' or 'fact'`);
  }
  return v;
}
function bodyTargetKind(body: Record<string, unknown>): CuratedKind {
  const v = bodyString(body, 'target_kind');
  if (v !== 'decision' && v !== 'lesson') {
    throw new ReviewClientError(`field 'target_kind' must be 'decision' or 'lesson'`);
  }
  return v;
}
function bodyBasis(body: Record<string, unknown>): CandidateBasis {
  const v = bodyString(body, 'basis');
  if (v !== 'never-surfaced' && v !== 'never-cited' && v !== 'agent-evidence') {
    throw new ReviewClientError(
      `field 'basis' must be 'never-surfaced', 'never-cited', or 'agent-evidence'`
    );
  }
  return v;
}

export function createReviewPostHandlers(
  project: ReviewProjectResolver
): Record<string, ReviewPostHandler> {
  return {
    '/api/retract': async (body, url) => {
      const id = bodyString(body, 'decision_id');
      const reason = bodyString(body, 'reason');
      if (bodyKind(body) === 'fact') {
        const f = await factRetract(id, reason);
        return { message: `Fact retracted: ${f.fact}` };
      }
      return { message: await decisionRetract({ decisionId: id, reason, projectId: await project(url) }) };
    },
    '/api/unretract': async (body, url) => {
      const id = bodyString(body, 'decision_id');
      if (bodyKind(body) === 'fact') {
        const f = await factUnretract(id);
        return { message: `Fact restored: ${f.fact}` };
      }
      return { message: await decisionUnretract(id, await project(url)) };
    },
    '/api/promote': async (body, url) => {
      const id = bodyString(body, 'decision_id');
      if (bodyKind(body) === 'fact') {
        const f = await factPromote(id);
        return { message: `Fact approved: ${f.fact}` };
      }
      return { message: await decisionPromote(id, bodyNumberOpt(body, 'confidence'), await project(url)) };
    },
    '/api/curation/keep': async (body, url) => ({ message: await curationKeep({
      targetKind: bodyTargetKind(body), targetId: bodyString(body, 'target_id'),
      basis: bodyBasis(body), note: bodyStringOpt(body, 'note'), projectId: await project(url),
    }) }),
    '/api/curation/retire': async (body, url) => ({ message: await curationRetire({
      targetKind: bodyTargetKind(body), targetId: bodyString(body, 'target_id'),
      reason: bodyString(body, 'reason'), projectId: await project(url),
    }) }),
    '/api/curation/unretire': async (body, url) => ({ message: await curationUnretire({
      targetKind: bodyTargetKind(body), targetId: bodyString(body, 'target_id'),
      projectId: await project(url),
    }) }),
    '/api/curation/apply': async (body, url) => ({ message: await curationApply({
      citationId: bodyString(body, 'citation_id'), note: bodyStringOpt(body, 'note'),
      projectId: await project(url),
    }) }),
    '/api/curation/dismiss': async (body, url) => ({ message: await curationDismiss({
      citationId: bodyString(body, 'citation_id'), note: bodyStringOpt(body, 'note'),
      projectId: await project(url),
    }) }),
    '/api/curation/promote': async (body, url) => ({ message: await curationPromote({
      lessonId: bodyString(body, 'target_id'), note: bodyStringOpt(body, 'note'),
      projectId: await project(url),
    }) }),
    '/api/curation/reject': async (body, url) => ({ message: await curationReject({
      lessonId: bodyString(body, 'target_id'), note: bodyStringOpt(body, 'note'),
      projectId: await project(url),
    }) }),
  };
}
