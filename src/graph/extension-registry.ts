// Single source of truth for "which file extensions are claimed by which
// extraction tier" (plan 36, spec D6). Two DISTINCT concerns live here and
// must not be conflated (pass-1 finding):
//   - DEEP_EXTENSIONS: every extension a deep extractor CLAIMS — the
//     collision-truth set the disjointness assertion runs against. Includes
//     every non-splice language: php (full-rerun on update) and kotlin/swift
//     (full-BUILD-only per plan 35's amendment A6 — splice: 'refuse', absent
//     from the update path entirely).
//   - SPLICE_WALK_EXTENSIONS: only SPLICE-participating extractors' extensions
//     — what update.ts's changed/deleted filtering walks. Non-splice languages
//     stay OUT deliberately: php and tier-2 re-extract wholesale every update;
//     kotlin/swift extract only on a full build (A6's locked semantics; adding
//     .kt/.swift here would silently reverse it).
//
// The DISJOINTNESS ASSERTION is a LOAD-TIME module throw — reached the first
// time anything imports this module (the graph build/update paths and the
// registry test; npm test always runs it — read-only graph commands do NOT
// load this module, spec amendment A4), and proven by Task 2 Step 3's
// planted-overlap control. It is NOT a tsc-time error (the compiler cannot
// see runtime Set contents); what it guarantees is that no test run and no
// graph build/update can proceed with an overlapping claim. Overlap matters because the engine's node upsert takes
// ownership on qname conflict (engine.ts:151-162) and full-run splices delete
// by extracted_by (engine.ts:123-126) — ownership ping-pong and cascading
// edge loss. When a future deep extractor claims a tier-2 language, this
// throw turns the migration into a failing-everything event until the tier-2
// config releases the extension — impossible to forget.
import { CPP_EXT } from './extractors/cpp.js';
import { PY_EXT } from './extractors/python.js';
import { SHELL_EXT } from './extractors/shell.js';
import { SOURCE_EXT } from './extractors/ts.js';
import { PHP_EXT } from './extractors/php.js';
import { KT_EXT } from './extractors/kotlin.js';
import { SWIFT_EXT } from './extractors/swift.js';

/** Every extension a DEEP extractor claims (splice or full-rerun alike). */
export const DEEP_EXTENSIONS: ReadonlySet<string> = new Set([
  ...SOURCE_EXT, ...PY_EXT, ...SHELL_EXT, ...CPP_EXT, ...PHP_EXT, ...KT_EXT, ...SWIFT_EXT,
]);

/** Tier-2 claims. Literal so the assertion below reads in a diff. */
export const TIER2_EXTENSIONS: ReadonlySet<string> = new Set(['.go', '.rs', '.java', '.cs']);

for (const ext of TIER2_EXTENSIONS) {
  if (DEEP_EXTENSIONS.has(ext)) {
    throw new Error(
      `extension-registry: '${ext}' is claimed by BOTH a deep extractor and tier-2 — ` +
      `release it from the tier-2 config and delete its tier2 rows (see spec D6 migration rule)`
    );
  }
}

/** The update walk set: SPLICE participants ONLY. Deliberately absent:
 * php + all tier-2 languages (full-rerun on update — plan 36 A3) and
 * kotlin/swift (full-BUILD-only — plan 35 A6): none participates in splice
 * bookkeeping. */
export const SPLICE_WALK_EXTENSIONS: ReadonlySet<string> = new Set([
  ...SOURCE_EXT, ...PY_EXT, ...SHELL_EXT, ...CPP_EXT,
]);
