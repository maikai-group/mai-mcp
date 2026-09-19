#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "$0")" && pwd)"
DEFAULT_SCHEMA="$SCRIPT_DIR/../references/headless-review.schema.json"

die() {
  echo "review-headless: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
usage:
  review-headless.sh doctor [codex|claude|all]
  review-headless.sh run --harness codex|claude --scratch-root PATH \
    --workdir PATH --prompt-file PATH --output PATH [--model MODEL] [--schema PATH]

Optional absolute binary overrides:
  MAI_CODEX_BIN=/absolute/path/to/codex
  MAI_CLAUDE_BIN=/absolute/path/to/claude
EOF
}

absolute_executable() {
  local candidate="$1"
  case "$candidate" in
    /*) ;;
    *) return 1 ;;
  esac
  [ -f "$candidate" ] && [ -x "$candidate" ] && [ ! -d "$candidate" ]
}

resolve_binary() {
  local harness="$1" name override candidate package_prefix
  case "$harness" in
    codex) name='codex'; override="${MAI_CODEX_BIN:-}" ;;
    claude) name='claude'; override="${MAI_CLAUDE_BIN:-}" ;;
    *) die "unsupported harness: $harness" ;;
  esac

  if [ -n "$override" ]; then
    absolute_executable "$override" || die "${harness} override is not an executable absolute path: $override"
    printf '%s\n' "$override"
    return 0
  fi

  candidate="$(command -v "$name" 2>/dev/null || true)"
  if [ -n "$candidate" ] && absolute_executable "$candidate"; then
    printf '%s\n' "$candidate"
    return 0
  fi

  for candidate in \
    "${HOME}/.local/bin/$name" \
    "${HOME}/.claude/local/$name" \
    "/opt/homebrew/bin/$name" \
    "/usr/local/bin/$name"
  do
    if absolute_executable "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  if [ "$harness" = codex ]; then
    for candidate in \
      "${HOME}/Applications/ChatGPT.app/Contents/Resources/codex" \
      "/Applications/ChatGPT.app/Contents/Resources/codex"
    do
      if absolute_executable "$candidate"; then
        printf '%s\n' "$candidate"
        return 0
      fi
    done
  fi

  # npm-under-nvm installs live at ~/.nvm/versions/node/<v>/bin and are only on
  # PATH after the user's shell profile runs nvm — a sandboxed harness shell
  # never does, so an installed CLI reads as missing (live 2026-08-25: a Codex
  # session reported claude "not installed" on a machine where it runs daily).
  # Scan newest node version first; no PATH required.
  while IFS= read -r candidate; do
    if absolute_executable "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done < <(ls -1d "${HOME}/.nvm/versions/node"/*/bin/"$name" 2>/dev/null | sort -Vr)

  if command -v npm >/dev/null 2>&1; then
    package_prefix="$(npm prefix --global 2>/dev/null || true)"
    candidate="$package_prefix/bin/$name"
    if [ -n "$package_prefix" ] && absolute_executable "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi

  return 1
}

require_capabilities() {
  local harness="$1" binary="$2" help_text required
  case "$harness" in
    codex)
      help_text="$("$binary" exec --help 2>&1)" || die "could not inspect Codex non-interactive flags"
      for required in '--ephemeral' '--output-schema' '--output-last-message' '--sandbox'; do
        case "$help_text" in *"$required"*) ;; *) die "Codex CLI lacks required flag $required; upgrade the CLI" ;; esac
      done
      ;;
    claude)
      help_text="$("$binary" --help 2>&1)" || die "could not inspect Claude Code non-interactive flags"
      for required in '--print' '--output-format' '--json-schema' '--no-session-persistence' '--safe-mode' '--no-chrome'; do
        case "$help_text" in *"$required"*) ;; *) die "Claude Code CLI lacks required flag $required; upgrade the CLI" ;; esac
      done
      ;;
  esac
}

require_auth() {
  # An auth-status failure has two distinct causes and the remediation differs:
  # genuinely unauthenticated (fix: log in), or an execution sandbox that blocks
  # credential access — on macOS the Claude CLI reads its OAuth token from the
  # Keychain, which e.g. Codex's sandbox denies. Surface the CLI's own output so
  # the runner can tell which world it is in; never just assert "not
  # authenticated" (a live 2026-08-25 test sent that message for a fully
  # authenticated CLI running under a Codex sandbox).
  local harness="$1" binary="$2" auth_out
  case "$harness" in
    codex)
      if ! auth_out="$("$binary" login status 2>&1)"; then
        die "Codex CLI auth check failed. Either it is not authenticated (run codex login in an interactive terminal) or this process's sandbox blocks credential access — if running under a sandboxed harness, re-run this doctor with approval to execute outside the sandbox. CLI said: ${auth_out}"
      fi
      ;;
    claude)
      if ! auth_out="$("$binary" auth status 2>&1)"; then
        die "Claude Code CLI auth check failed. Either it is not authenticated (run claude auth login in an interactive terminal) or this process's sandbox blocks credential access (macOS Keychain) — if running under a sandboxed harness, re-run this doctor with approval to execute outside the sandbox. CLI said: ${auth_out}"
      fi
      ;;
  esac
}

doctor_one() {
  local harness="$1" binary version
  binary="$(resolve_binary "$harness")" || {
    case "$harness" in
      codex) die 'Codex CLI executable not found; this is not the ChatGPT app. Install Codex CLI or set MAI_CODEX_BIN to its absolute path' ;;
      claude) die 'Claude Code CLI executable not found; this is not Claude Desktop. Install Claude Code or set MAI_CLAUDE_BIN to its absolute path' ;;
    esac
  }
  require_capabilities "$harness" "$binary"
  require_auth "$harness" "$binary"
  version="$("$binary" --version 2>/dev/null | head -n 1)"
  printf '%s: READY path=%s version=%s\n' "$harness" "$binary" "${version:-unknown}"
}

canonical_dir() {
  [ -d "$1" ] || die "directory does not exist: $1"
  (cd -P "$1" && pwd)
}

canonical_file() {
  [ -f "$1" ] || die "file does not exist: $1"
  local parent
  parent="$(canonical_dir "$(dirname "$1")")"
  printf '%s/%s\n' "$parent" "$(basename "$1")"
}

require_inside_root() {
  local candidate="$1" root="$2" label="$3"
  case "$candidate" in
    "$root"|"$root"/*) ;;
    *) die "$label must be beneath the managed scratch root: $candidate" ;;
  esac
}

cmd_doctor() {
  local target="${1:-all}"
  [ "$#" -le 1 ] || die 'doctor accepts at most one target'
  case "$target" in
    codex|claude) doctor_one "$target" ;;
    all) doctor_one codex; doctor_one claude ;;
    *) die "doctor target must be codex, claude or all: $target" ;;
  esac
}

cmd_run() {
  local harness='' scratch_root='' workdir='' prompt_file='' output='' model='' schema="$DEFAULT_SCHEMA"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --harness) [ "$#" -ge 2 ] || die '--harness needs a value'; harness="$2"; shift 2 ;;
      --scratch-root) [ "$#" -ge 2 ] || die '--scratch-root needs a value'; scratch_root="$2"; shift 2 ;;
      --workdir) [ "$#" -ge 2 ] || die '--workdir needs a value'; workdir="$2"; shift 2 ;;
      --prompt-file) [ "$#" -ge 2 ] || die '--prompt-file needs a value'; prompt_file="$2"; shift 2 ;;
      --output) [ "$#" -ge 2 ] || die '--output needs a value'; output="$2"; shift 2 ;;
      --model) [ "$#" -ge 2 ] || die '--model needs a value'; model="$2"; shift 2 ;;
      --schema) [ "$#" -ge 2 ] || die '--schema needs a value'; schema="$2"; shift 2 ;;
      *) die "unknown run option: $1" ;;
    esac
  done

  case "$harness" in codex|claude) ;; *) die '--harness must be codex or claude' ;; esac
  [ -n "$scratch_root" ] || die '--scratch-root is required'
  [ -n "$workdir" ] || die '--workdir is required'
  [ -n "$prompt_file" ] || die '--prompt-file is required'
  [ -n "$output" ] || die '--output is required'

  scratch_root="$(canonical_dir "$scratch_root")"
  [ -f "$scratch_root/.mai-review-scratch-v1" ] || die "scratch root is not managed by review-scratch.sh: $scratch_root"
  workdir="$(canonical_dir "$workdir")"
  prompt_file="$(canonical_file "$prompt_file")"
  schema="$(canonical_file "$schema")"
  require_inside_root "$workdir" "$scratch_root" 'workdir'
  require_inside_root "$prompt_file" "$scratch_root" 'prompt file'

  mkdir -p "$(dirname "$output")"
  local output_parent binary stderr_log activity_log envelope schema_json node_binary
  output_parent="$(canonical_dir "$(dirname "$output")")"
  output="$output_parent/$(basename "$output")"
  require_inside_root "$output" "$scratch_root" 'output'
  [ ! -e "$output" ] || die "refusing to overwrite output: $output"

  binary="$(resolve_binary "$harness")" || die "$harness CLI executable not found; run review-headless.sh doctor $harness"
  require_capabilities "$harness" "$binary"
  require_auth "$harness" "$binary"

  export TMPDIR="$scratch_root/tmp"
  export TMP="$scratch_root/tmp"
  export TEMP="$scratch_root/tmp"
  export npm_config_cache="$scratch_root/npm-cache"
  stderr_log="$output.stderr.log"
  activity_log="$output.activity.log"

  if [ "$harness" = codex ]; then
    local codex_args=(exec --cd "$workdir" --sandbox workspace-write --skip-git-repo-check --ephemeral --output-schema "$schema" --output-last-message "$output")
    [ -z "$model" ] || codex_args+=(--model "$model")
    codex_args+=(-)
    if ! "$binary" "${codex_args[@]}" < "$prompt_file" > "$activity_log" 2> "$stderr_log"; then
      die "Codex headless review failed; inspect $stderr_log and $activity_log"
    fi
  else
    envelope="$output.envelope.json"
    schema_json="$(tr -d '\n' < "$schema")"
    local claude_args=(--print --output-format json --json-schema "$schema_json" --permission-mode dontAsk --no-session-persistence --safe-mode --no-chrome --tools 'Read,Bash,Grep,Glob')
    [ -z "$model" ] || claude_args+=(--model "$model")
    if ! (cd "$workdir" && "$binary" "${claude_args[@]}" < "$prompt_file") > "$envelope" 2> "$stderr_log"; then
      die "Claude headless review failed; inspect $stderr_log and $envelope"
    fi
    node_binary="$(command -v node 2>/dev/null || true)"
    [ -n "$node_binary" ] || die 'Node.js is required to normalize Claude structured output'
    "$node_binary" -e '
      const fs = require("node:fs");
      const envelope = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      let value = envelope.structured_output ?? envelope.structuredOutput;
      if (value === undefined && typeof envelope.result === "string") {
        try { value = JSON.parse(envelope.result); } catch { /* handled below */ }
      }
      if (value === undefined) throw new Error("Claude JSON envelope has no structured output");
      fs.writeFileSync(process.argv[2], `${JSON.stringify(value, null, 2)}\n`);
    ' "$envelope" "$output" > "$activity_log" 2>> "$stderr_log" || die "could not normalize Claude output; inspect $stderr_log and $envelope"
  fi

  [ -s "$output" ] || die "$harness produced no normalized review result"
  printf 'review-headless: OK harness=%s binary=%s output=%s\n' "$harness" "$binary" "$output"
}

case "${1:-}" in
  doctor) shift; cmd_doctor "$@" ;;
  run) shift; cmd_run "$@" ;;
  -h|--help|'') usage ;;
  *) die "unknown command: $1" ;;
esac
