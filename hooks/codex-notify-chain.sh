#!/usr/bin/env bash
set -euo pipefail
exec node "$(cd "$(dirname "$0")/.." && pwd)/build/scripts/hook-runner.js" codex-notify-chain "$@"
