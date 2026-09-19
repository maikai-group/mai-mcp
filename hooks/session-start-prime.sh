#!/usr/bin/env bash
set -euo pipefail
args=(session-start)
if [[ -n "${MAI_PROJECT_SLUG:-}" ]]; then args+=(--project "$MAI_PROJECT_SLUG"); fi
exec node "$(cd "$(dirname "$0")/.." && pwd)/build/scripts/hook-runner.js" "${args[@]}" "$@"
