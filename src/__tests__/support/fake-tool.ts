// SPDX-License-Identifier: MIT — Copyright © 2026 Maikai Group Inc.
// Part of mai-mcp (MIT — the whole project; see LICENSE). Copy freely.
//
// One way for a test to install a fake executable (git, npm, claude, codex,
// launchctl, schtasks, lsof …) that the product will find through PATH or an
// explicit path and spawn without a shell, on every platform:
//   POSIX   → an executable script (bash body under an ABSOLUTE #!/bin/bash —
//             products spawn fakes with a stripped PATH, so `env` cannot be
//             relied on — or a node body behind a sh exec wrapper).
//   Windows → a copy of the compiled fake-tool shim (fake-tool-shim.cs,
//             compiled once per process by Windows PowerShell's Add-Type) beside
//             a `.runner` sidecar naming the interpreter and the script.
// Bodies keep their argv exactly (the shim quotes with the C runtime rules),
// inherit stdio, and die with the shim, so a product that kills its child
// sees the same thing on both platforms. Only pid-based assertions differ:
// on Windows a bash body's `$$` is Git Bash's MSYS pid, never the Windows pid
// the product spawned — gate those assertions, never the whole suite.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type FakeToolKind = 'bash' | 'node';

export interface FakeToolOptions {
  /** `bash` (default): the body is a shell script. `node`: the body is a CommonJS script. */
  kind?: FakeToolKind;
  /** POSIX file mode for the executable (default 0o755). */
  mode?: number;
}

const WINDOWS = process.platform === 'win32';
const SHIM_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-tool-shim.cs');

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

let shimCache: string | null = null;
let shimDir: string | null = null;

function removeShimDir(): void {
  if (!shimDir) return;
  const dir = shimDir;
  shimDir = null;
  shimCache = null;
  // Windows refuses to delete a freshly written .exe while Defender or the
  // indexer still holds it — the same transient backup.ts already retries when
  // landing a dump. This runs inside a process 'exit' listener, where a throw
  // turns a fully green run's exit 0 into 1 with no named test: precisely the
  // flake shape these repairs exist to remove. A swept directory is worth less
  // than a legible exit code, so retry, then leave it and say nothing.
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // One directory under %TEMP% outlives the run. Never a failed run.
  }
}

/**
 * Path of the compiled shim, compiling it on first use (Windows only).
 *
 * The executable is compiled into a directory THIS process creates with
 * mkdtempSync and removes on a clean exit — never a cross-run cache at a
 * derivable path. An aborted run (Ctrl-C, SIGTERM, a killed worker) leaves its
 * directory behind, one per process that installed a fake tool; that is the
 * accepted price of never trusting one. The old
 * `<tmp>/mai-fake-tool-shim/shim-<source-digest>.exe` named the SOURCE but was
 * trusted as the ARTIFACT: whatever already sat at
 * that path was copied over every fake tool and executed, with nothing
 * checking it was the compiled output of the source that named it (finding
 * 125dcebd). A per-run random directory cannot be PRE-created, so no artifact
 * is ever inherited from a previous run or from anyone else. That is the whole
 * claim, and it is not tamper-proofing: on Windows the directory inherits
 * %TEMP%'s ACL instead of a private 0700 mode, so a %TEMP% redirected to a
 * location carrying inheritable write ACEs (some CI images do this) still lets
 * someone already there swap the file after it is compiled. The default
 * C:\Windows\Temp is NOT such a location — its CREATOR OWNER inheritance
 * grants the creator, SYSTEM and Administrators, and other standard users
 * nothing. The cost is one Add-Type per process that
 * installs a fake tool.
 */
export function fakeToolShim(): string {
  if (!WINDOWS) throw new Error('fakeToolShim is Windows-only');
  if (shimCache) return shimCache;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mai-fake-tool-shim-'));
  const exe = path.join(dir, 'shim.exe');
  const command = `Add-Type -Path ${quotePowerShell(SHIM_SOURCE)} -OutputAssembly ${quotePowerShell(exe)} -OutputType ConsoleApplication`;
  const compiled = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
  if (compiled.status !== 0 || !fs.existsSync(exe)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Never let the cleanup's error replace the compile's.
    }
    throw new Error(`fake tool shim did not compile (exit ${compiled.status}):\n${compiled.stdout}${compiled.stderr}`);
  }
  shimDir = dir;
  process.on('exit', removeShimDir);
  shimCache = exe;
  return exe;
}

let bashCache: string | null = null;

/** Git for Windows bash — the only bash a native Windows host is required to have. */
export function windowsBash(): string {
  if (bashCache) return bashCache;
  const candidates: string[] = [];
  if (process.env.MAI_TEST_BASH) candidates.push(process.env.MAI_TEST_BASH);
  const where = spawnSync('where.exe', ['git'], { encoding: 'utf8' });
  const gitExe = where.status === 0 ? where.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean) : undefined;
  if (gitExe) {
    const gitRoot = path.dirname(path.dirname(gitExe));
    candidates.push(path.join(gitRoot, 'bin', 'bash.exe'), path.join(gitRoot, 'usr', 'bin', 'bash.exe'));
  }
  for (const programFiles of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432]) {
    if (programFiles) candidates.push(path.join(programFiles, 'Git', 'bin', 'bash.exe'));
  }
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new Error(`Git for Windows bash.exe not found (tried: ${candidates.join('; ')}); set MAI_TEST_BASH`);
  bashCache = found;
  return found;
}

/**
 * Install a fake tool named `name` in `dir` and return the path the product
 * should spawn (or put `dir` on PATH and let it resolve `name`). On Windows the
 * returned path ends in `.exe` whatever `name` says; on POSIX it is `dir/name`.
 */
export function installFakeTool(dir: string, name: string, rawBody: string, options: FakeToolOptions = {}): string {
  const kind = options.kind ?? 'bash';
  const mode = options.mode ?? 0o755;
  // The helper owns the interpreter line; a body written with its own shebang
  // (the suites' original hand-written fakes) keeps working unchanged.
  const body = kind === 'bash' ? rawBody.replace(/^#![^\n]*\n?/, '') : rawBody;
  if (!WINDOWS) {
    const target = path.join(dir, name);
    if (kind === 'bash') {
      fs.writeFileSync(target, `#!/bin/bash\n${body}\n`, { mode });
    } else {
      const script = `${target}.cjs`;
      fs.writeFileSync(script, body, { mode: 0o644 });
      fs.writeFileSync(target, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, { mode });
    }
    fs.chmodSync(target, mode);
    return target;
  }
  const base = name.replace(/\.exe$/i, '');
  const exe = path.join(dir, `${base}.exe`);
  const script = kind === 'bash' ? `${exe}.sh` : `${exe}.cjs`;
  const interpreter = kind === 'bash' ? windowsBash() : process.execPath;
  fs.writeFileSync(script, kind === 'bash' ? `${body}\n` : body);
  fs.writeFileSync(`${exe}.runner`, `${interpreter}\n${script}\n`);
  fs.copyFileSync(fakeToolShim(), exe);
  return exe;
}

/** Install a fake tool from an existing script file (the committed fixtures under fixtures/). */
export function installFakeToolFromFile(dir: string, name: string, sourceFile: string, options: Omit<FakeToolOptions, 'kind'> = {}): string {
  return installFakeTool(dir, name, fs.readFileSync(sourceFile, 'utf8'), { ...options, kind: 'bash' });
}
