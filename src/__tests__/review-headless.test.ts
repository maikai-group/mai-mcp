import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const HEADLESS = path.resolve('skills/plan-review-cycle/scripts/review-headless.sh');
const SCRATCH = path.resolve('skills/plan-review-cycle/scripts/review-scratch.sh');
const roots: string[] = [];

function tempRoot(): string {
  const value = mkdtempSync(path.join(os.tmpdir(), 'mai-review-headless-test-'));
  roots.push(value);
  return value;
}

function executable(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(file, 0o700);
  return file;
}

function managedRoot(parent: string): string {
  return execFileSync('bash', [SCRATCH, 'create'], {
    encoding: 'utf8',
    env: { ...process.env, MAI_REVIEW_TMP_ROOT: parent },
  }).trim();
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe('opposite-harness headless launcher', () => {
  it('diagnoses the real CLI executables and authentication without opening an app', () => {
    const dir = tempRoot();
    const codex = executable(dir, 'codex', `
if [ "\${1:-}" = exec ] && [ "\${2:-}" = --help ]; then
  echo '--ephemeral --output-schema --output-last-message --sandbox'
elif [ "\${1:-}" = login ] && [ "\${2:-}" = status ]; then
  exit 0
elif [ "\${1:-}" = --version ]; then
  echo 'codex-test 1.0'
else
  exit 91
fi`);
    const claude = executable(dir, 'claude', `
if [ "\${1:-}" = --help ]; then
  echo '--print --output-format --json-schema --no-session-persistence --safe-mode --no-chrome'
elif [ "\${1:-}" = auth ] && [ "\${2:-}" = status ]; then
  exit 0
elif [ "\${1:-}" = --version ]; then
  echo 'claude-test 1.0'
else
  exit 92
fi`);

    const output = execFileSync('bash', [HEADLESS, 'doctor', 'all'], {
      encoding: 'utf8',
      env: { ...process.env, MAI_CODEX_BIN: codex, MAI_CLAUDE_BIN: claude },
    });
    expect(output).toContain(`codex: READY path=${codex}`);
    expect(output).toContain(`claude: READY path=${claude}`);
  });

  it('resolves an npm-under-nvm claude with no PATH help', () => {
    // A sandboxed harness shell never runs the user's nvm profile, so the CLI
    // is absent from PATH; the resolver must find it by scanning
    // ~/.nvm/versions/node/<v>/bin directly (newest first).
    const home = tempRoot();
    const binDir = path.join(home, '.nvm', 'versions', 'node', 'v9.9.9', 'bin');
    mkdirSync(binDir, { recursive: true });
    executable(binDir, 'claude', `
if [ "\${1:-}" = --help ]; then
  echo '--print --output-format --json-schema --no-session-persistence --safe-mode --no-chrome'
elif [ "\${1:-}" = auth ] && [ "\${2:-}" = status ]; then
  exit 0
elif [ "\${1:-}" = --version ]; then
  echo 'claude-nvm-test 1.0'
else
  exit 94
fi`);
    const output = execFileSync('bash', [HEADLESS, 'doctor', 'claude'], {
      encoding: 'utf8',
      env: { HOME: home, PATH: '/usr/bin:/bin' },
    });
    expect(output).toContain(`claude: READY path=${path.join(binDir, 'claude')}`);
  });

  it('uses codex exec and Claude print mode, then normalizes both results', () => {
    const parent = tempRoot();
    const binDir = tempRoot();
    const scratch = managedRoot(parent);
    const repo = path.join(scratch, 'repo');
    const prompt = path.join(scratch, 'review-prompt.txt');
    const codexOutput = path.join(scratch, 'codex-result.json');
    const claudeOutput = path.join(scratch, 'claude-result.json');
    const codexLog = path.join(scratch, 'codex-args.log');
    const claudeLog = path.join(scratch, 'claude-args.log');
    const result = {
      plan_id: 'plan-1',
      plan_sha: 'abcdef1234567',
      breadth: 'delta',
      verdict: 'approved',
      summary: 'clean',
      findings: [],
    };
    mkdirSync(repo);
    writeFileSync(prompt, 'Review the frozen plan.');

    const codex = executable(binDir, 'codex', `
if [ "\${1:-}" = exec ] && [ "\${2:-}" = --help ]; then
  echo '--ephemeral --output-schema --output-last-message --sandbox'
elif [ "\${1:-}" = login ] && [ "\${2:-}" = status ]; then
  exit 0
elif [ "\${1:-}" = exec ]; then
  printf '%s\\n' "$@" > "$FAKE_ARGS_LOG"
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --output-last-message ]; then
      printf '%s\\n' "$FAKE_RESULT" > "$2"
      break
    fi
    shift
  done
else
  exit 93
fi`);
    const claude = executable(binDir, 'claude', `
if [ "\${1:-}" = --help ]; then
  echo '--print --output-format --json-schema --no-session-persistence --safe-mode --no-chrome'
elif [ "\${1:-}" = auth ] && [ "\${2:-}" = status ]; then
  exit 0
else
  printf '%s\\n' "$@" > "$FAKE_ARGS_LOG"
  printf '{"structured_output":%s}\\n' "$FAKE_RESULT"
fi`);

    const common = ['--scratch-root', scratch, '--workdir', repo, '--prompt-file', prompt];
    execFileSync('bash', [HEADLESS, 'run', '--harness', 'codex', ...common, '--output', codexOutput, '--model', 'codex-test'], {
      env: { ...process.env, MAI_CODEX_BIN: codex, FAKE_ARGS_LOG: codexLog, FAKE_RESULT: JSON.stringify(result) },
    });
    execFileSync('bash', [HEADLESS, 'run', '--harness', 'claude', ...common, '--output', claudeOutput, '--model', 'claude-test'], {
      env: { ...process.env, MAI_CLAUDE_BIN: claude, FAKE_ARGS_LOG: claudeLog, FAKE_RESULT: JSON.stringify(result) },
    });

    expect(JSON.parse(readFileSync(codexOutput, 'utf8'))).toEqual(result);
    expect(JSON.parse(readFileSync(claudeOutput, 'utf8'))).toEqual(result);
    const codexArgs = readFileSync(codexLog, 'utf8');
    expect(codexArgs).toContain('exec\n');
    expect(codexArgs).toContain('--ephemeral\n');
    expect(codexArgs).not.toContain('\napp\n');
    expect(codexArgs).not.toContain('\ncloud\n');
    const claudeArgs = readFileSync(claudeLog, 'utf8');
    expect(claudeArgs).toContain('--print\n');
    expect(claudeArgs).toContain('--no-session-persistence\n');
    expect(claudeArgs).toContain('--safe-mode\n');
    expect(claudeArgs).toContain('--no-chrome\n');
    expect(claudeArgs).not.toContain('--cloud\n');
    expect(claudeArgs).not.toContain('--chrome\n');
  });
});
