#!/usr/bin/env node
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const VALUES = {
  lastBreadth: new Set(['none', 'broad', 'delta', 'clearance']),
  lastVerdict: new Set(['none', 'blocked', 'approved']),
  repairScope: new Set(['none', 'editorial', 'bounded', 'architecture']),
  risk: new Set(['standard', 'high-risk']),
  finalClearance: new Set(['none', 'exhaustive']),
};

const parse = (argv) => {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith('--') || argv[i + 1] === undefined) throw new Error('expected --key value pairs');
    if (values.has(key)) throw new Error(`duplicate option: ${key}`);
    values.set(key, argv[i + 1]);
  }
  const required = ['architecture-epoch', 'broad-reviewed-epoch', 'last-breadth',
    'last-verdict', 'repair-scope', 'risk', 'findings-dispositioned', 'blocked-streak'];
  const optional = ['scope-escape-epoch', 'final-clearance', 'clearance-covered', 'operator-continue'];
  for (const key of required) if (!values.has('--' + key)) throw new Error(`missing option: --${key}`);
  for (const key of values.keys()) {
    if (![...required, ...optional].includes(key.slice(2))) throw new Error(`unknown option: ${key}`);
  }
  const bool = (key) => {
    const value = values.get('--' + key) ?? 'false';
    if (!['true', 'false'].includes(value)) throw new Error(`${key} must be true or false`);
    return value === 'true';
  };
  const state = {
    architectureEpoch: values.get('--architecture-epoch'),
    broadReviewedEpoch: values.get('--broad-reviewed-epoch'),
    lastBreadth: values.get('--last-breadth'),
    lastVerdict: values.get('--last-verdict'),
    repairScope: values.get('--repair-scope'),
    risk: values.get('--risk'),
    finalClearance: values.get('--final-clearance') ?? 'none',
    clearanceCovered: bool('clearance-covered'),
    findingsDispositioned: bool('findings-dispositioned'),
    operatorContinue: bool('operator-continue'),
    blockedStreak: values.get('--blocked-streak'),
    scopeEscapeEpoch: values.get('--scope-escape-epoch'),
  };
  if (!state.architectureEpoch || state.architectureEpoch === 'none') throw new Error('architecture epoch must be a non-empty label');
  if (!state.broadReviewedEpoch) throw new Error('broad-reviewed epoch must be a non-empty label or none');
  for (const [key, allowed] of Object.entries(VALUES)) {
    if (!allowed.has(state[key])) throw new Error(`invalid ${key}: ${state[key]}`);
  }
  if (!/^(0|[1-9][0-9]*)$/.test(state.blockedStreak)) throw new Error('blocked-streak must be a non-negative integer');
  state.blockedStreak = Number(state.blockedStreak);
  if (!Number.isSafeInteger(state.blockedStreak)) throw new Error('blocked-streak exceeds safe integer range');
  if (state.scopeEscapeEpoch !== undefined && (!state.scopeEscapeEpoch || state.scopeEscapeEpoch === 'none')) {
    throw new Error('scope-escape epoch must be a non-empty label');
  }
  return state;
};

export const applyScopeEscape = (state) => {
  if (state.scopeEscapeEpoch === undefined) return state;
  if (state.broadReviewedEpoch !== state.architectureEpoch) throw new Error('scope escape requires a broad-reviewed current architecture epoch');
  if (state.repairScope !== 'bounded' || state.lastVerdict !== 'blocked') {
    throw new Error('scope escape requires a bounded repair after a blocked accepted pass');
  }
  if (state.scopeEscapeEpoch === state.architectureEpoch) throw new Error('scope escape must advance the architecture epoch');
  return { ...state, architectureEpoch: state.scopeEscapeEpoch, repairScope: 'architecture',
    clearanceCovered: false, scopeEscapeEpoch: undefined };
};

export const routeReview = (state) => {
  if ((state.lastBreadth === 'none') !== (state.lastVerdict === 'none')) {
    throw new Error('last breadth and verdict must both be none or both describe an accepted pass');
  }
  if (!state.findingsDispositioned) throw new Error('blocking findings must be dispositioned before routing');
  if (state.lastVerdict === 'blocked'
    ? state.repairScope !== 'editorial' && state.blockedStreak < 1
    : state.blockedStreak !== 0) {
    throw new Error('blocked-streak must agree with the accepted verdict');
  }
  if (state.blockedStreak >= 2 && !state.operatorContinue) {
    throw new Error('automatic review budget exhausted; review-stalled: diagnose before another pass');
  }
  const result = (nextBreadth, strength, reason) => ({ nextBreadth, strength, reason });
  if (state.broadReviewedEpoch !== state.architectureEpoch) {
    if (state.lastBreadth === 'none' ? state.repairScope !== 'none' : state.repairScope !== 'architecture') {
      throw new Error('new architecture requires architecture repair scope; initial review requires none');
    }
    if (state.clearanceCovered) throw new Error('clearance coverage cannot cross architecture revisions');
    return result('broad', state.risk === 'high-risk' ? 'clearance' : 'broad', 'architecture has no completed broad coverage');
  }
  if (state.lastVerdict === 'none') throw new Error('broad coverage requires a prior accepted review');
  if (state.repairScope === 'architecture') throw new Error('architecture repair scope requires advancing the architecture epoch');
  if (state.repairScope === 'editorial') {
    return result('editorial-check', 'none', 'check equivalence and record the new pin without a review pass');
  }
  if (state.repairScope === 'bounded') {
    return result('delta', state.risk === 'high-risk' ? 'clearance' : 'delta', 'independently review substantive changes');
  }
  if (state.lastVerdict === 'blocked') throw new Error('a blocked pass requires a repair scope');
  if (state.finalClearance === 'exhaustive' && !state.clearanceCovered && state.lastBreadth !== 'clearance') {
    return result('clearance', 'clearance', 'explicit exhaustive clearance requested');
  }
  return result('terminate', 'none', 'clean revision covered by broad review and any necessary deltas');
};

export function main(argv = process.argv.slice(2)) {
  try {
    console.log(JSON.stringify(routeReview(applyScopeEscape(parse(argv)))));
    return 0;
  } catch (error) {
    console.error(`review-route: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main();
