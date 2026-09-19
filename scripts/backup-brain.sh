#!/bin/bash
# Backup the mai-mcp brain DB to db/backups/<YYYY-MM-DD>.sql.
# Backups are local-only and must never be added to Git or pushed to a remote.
#
# POSIX compatibility delegate: the controller is `mai backup`
# (src/scripts/backup.ts, invoked through build/entry.js). Legacy LaunchAgents
# may still pass --commit or --push; the controller warns and ignores both and
# fails closed on any other option.
#
# Restore:
#   psql "postgresql://postgres:postgres@127.0.0.1:54334/mai_brain" \
#     -f db/backups/<YYYY-MM-DD>.sql
#
# Schedule: launchd (scripts/com.mai.brain-backup.plist), daily 04:30.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/../build/entry.js" backup "$@"
