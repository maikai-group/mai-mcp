#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -eq 0 ]; then
  ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
  exec node "$ROOT/build/entry.js" dashboard start
elif [ "$#" -eq 1 ] && [ "$1" = "--foreground" ]; then
  ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
  exec node "$ROOT/build/entry.js" dashboard run
else
  echo "usage: bash scripts/mai-brain-web-start.sh [--foreground]" >&2
  exit 2
fi
