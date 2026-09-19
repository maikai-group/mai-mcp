// SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
// Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely.
//
// vitest setup file (see vitest.config.ts). Windows CI runners — and some user
// profiles — hand out TEMP as an 8.3 short name (a RUNNER~1 segment under the
// profile) while USERPROFILE stays long-form. The product canonicalises through
// realpath.native, so a fixture rooted at the raw os.tmpdir() disagrees with
// every canonical path the product reports and with the user-profile
// containment gate. Pointing TEMP/TMP at the canonical form once, before any
// test runs, makes os.tmpdir() canonical for the whole process tree.
// POSIX is left untouched on purpose: macOS /var → /private/var aliasing is
// already handled where tests compare realpaths, and the VC1 evidence stays
// byte-identical.
import fs from 'node:fs';
import os from 'node:os';

if (process.platform === 'win32') {
  const canonical = fs.realpathSync.native(os.tmpdir());
  process.env.TEMP = canonical;
  process.env.TMP = canonical;
}
