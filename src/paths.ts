import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PROJECT_SLUG } from './env.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * BRAIN_ROOT — the mai-mcp repo itself. Owns ALL brain state (Architecture C):
 *   docs/context/<slug>/*.md   — topic content per project
 *   docs/tracking/<slug>/*.md  — session tracking (mai_note / mai_progress)
 *   pg-data/                   — Docker volume (convention only)
 * Resolved one dir up from build/paths.js. Override via MAI_BRAIN_ROOT (tests).
 */
export const BRAIN_ROOT = process.env.MAI_BRAIN_ROOT ?? path.resolve(here, '..');

/** Topic markdown for the pinned project. */
export function contextDir(): string {
  return path.join(BRAIN_ROOT, 'docs', 'context', PROJECT_SLUG);
}

/** Tracking logs for the pinned project. */
export function trackingDir(): string {
  return path.join(BRAIN_ROOT, 'docs', 'tracking', PROJECT_SLUG);
}

/**
 * MAI_ROOT — the mai-mcp repo checkout itself (hook scripts, templates,
 * build/index.js). Unlike BRAIN_ROOT it is NEVER overridden by env: consumer
 * configs must always point at the real checkout, even when tests relocate
 * the brain dirs. Computed from this module's location (src/ or build/ — both
 * are one level below the repo root).
 */
export const MAI_ROOT = path.resolve(here, '..');
