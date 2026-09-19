#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ADMIN_URL="${MAI_TEST_ADMIN_URL:-postgresql://postgres:postgres@127.0.0.1:54334/postgres}"
DB_NAME="mai_plan23_$$_${RANDOM}"
[[ "$DB_NAME" =~ ^mai_plan23_[0-9]+_[0-9]+$ ]] || { echo 'unsafe disposable DB name' >&2; exit 1; }
TEST_URL="${ADMIN_URL%/*}/${DB_NAME}"
cleanup() {
  status=$?
  trap - EXIT
  set +e
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -qAtc \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DB_NAME' AND pid<>pg_backend_pid()" >/dev/null
  terminate_status=$?
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS \"$DB_NAME\"" >/dev/null
  drop_status=$?

  # Preserve the body's primary failure. After a successful body, cleanup is part
  # of the gate: either cleanup failure must make the wrapper non-zero.
  if [ "$status" -ne 0 ]; then
    exit "$status"
  fi
  if [ "$terminate_status" -ne 0 ]; then
    exit "$terminate_status"
  fi
  exit "$drop_status"
}
trap cleanup EXIT
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE \"$DB_NAME\"" >/dev/null
psql "$TEST_URL" -v ON_ERROR_STOP=1 -q -f db/schema.sql
for migration in \
  db/migrations/2026-07-09-git-evidence.sql \
  db/migrations/2026-07-09-agent-messages.sql \
  db/migrations/2026-07-10-agent-claims.sql \
  db/migrations/2026-08-26-git-history-rewrites.sql
do
  psql "$TEST_URL" -v ON_ERROR_STOP=1 -q -f "$migration"
done
export MAI_TEST_DB_URL="$TEST_URL"
export MAI_DB_URL="$TEST_URL"
"$@"
