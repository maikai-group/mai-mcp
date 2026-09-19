#!/usr/bin/env bash
# POSIX compatibility delegate for already-installed callers. The one contract
# is review-scratch.mjs beside this file; both review skills invoke it directly.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/review-scratch.mjs" "$@"
