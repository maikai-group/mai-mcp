#!/usr/bin/env bash
# Disposable MySQL for the graph-mysql extractor suite (plan 34): starts an
# ephemeral mysql:8 container on a random high port, seeds a WordPress-shaped
# schema, exports MAI_TEST_MYSQL_URL, runs the given command, tears down under
# trap. Mirrors run-with-disposable-db.sh's contract: the suite REQUIRES the
# env var and fails loudly without it — a skipped suite is fail-open.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=$(( 20000 + (RANDOM % 20000) ))
NAME="mai-test-mysql-$$-${RANDOM}"
[[ "$NAME" =~ ^mai-test-mysql-[0-9]+-[0-9]+$ ]] || { echo 'unsafe container name' >&2; exit 1; }

cleanup() {
  status=$?
  trap - EXIT
  # errexit is still live inside a trap handler: without set +e a failing
  # docker rm terminates the handler HERE and the body's real failure is
  # replaced by the cleanup status (pass-3 finding — the inverse of the
  # swallowed-cleanup defect).
  set +e
  docker rm -f "$NAME" >/dev/null 2>&1
  rm_status=$?
  # Mirror run-with-disposable-db.sh: after a successful body, cleanup is part
  # of the gate — a leaked container must make the wrapper non-zero, never be
  # swallowed by an || true.
  if [ "$status" -ne 0 ]; then exit "$status"; fi
  exit "$rm_status"
}
trap cleanup EXIT

docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:3306" \
  -e MYSQL_ROOT_PASSWORD=maitest -e MYSQL_DATABASE=acmewp \
  mysql:8 >/dev/null

# Readiness phase 1: an AUTHENTICATED query against the target database, not
# mysqladmin ping. The official mysql:8 image initializes on a TEMPORARY server
# and restarts it; ping answers on the temp server before the root password and
# database exist, so a seed fired after a mere ping hits ERROR 1045 (observed
# live 2026-08-25 — the harness died before vitest ran). This query can only
# succeed on the final server with auth and the database in place.
for i in $(seq 1 120); do
  if docker exec "$NAME" mysql -uroot -pmaitest acmewp -e 'SELECT 1' >/dev/null 2>&1; then
    break
  fi
  [ "$i" -lt 120 ] || { echo 'mysql container never became ready (authenticated SELECT)' >&2; exit 1; }
  sleep 1
done

# WordPress-shaped seed: prefixed FK-less tables (the ecosystem convention),
# ONE real FK pair so fk_to is positively exercised, and one wrong-prefix table
# so the wp linker's discrimination is testable from the same seed.
docker exec -i "$NAME" mysql -uroot -pmaitest acmewp <<'SQL'
CREATE TABLE wp_acme_tips (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  amount DECIMAL(10,2) NOT NULL,
  note VARCHAR(255) NULL
);
CREATE TABLE wp_acme_drivers (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(190) NOT NULL
);
CREATE TABLE wp_acme_payouts (
  id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  driver_id BIGINT UNSIGNED NOT NULL,
  CONSTRAINT fk_payout_driver FOREIGN KEY (driver_id) REFERENCES wp_acme_drivers(id)
);
CREATE TABLE wpx_acme_tips (id INT PRIMARY KEY);
SQL

# Decoy DATABASE on the same server: the extractor is scoped to the URL's
# database (TABLE_SCHEMA = DATABASE()), so nothing from otherdb may appear.
docker exec -i "$NAME" mysql -uroot -pmaitest <<'SQL'
CREATE DATABASE otherdb;
CREATE TABLE otherdb.wp_acme_tips (id INT PRIMARY KEY);
SQL

export MAI_TEST_MYSQL_URL="mysql://root:maitest@127.0.0.1:${PORT}/acmewp"

# Readiness phase 2: HOST-side probe through the exact URL and driver the suite
# will use — proves host TCP publish, auth from outside the container, AND that
# the seed landed (init restarts make an early in-container ping a false ready).
# Retries absorb the image's init-restart window. Requires mysql2 (Task 1) —
# run this harness from the repo root after dependencies are installed.
for i in $(seq 1 60); do
  if node -e '
    import("mysql2/promise").then(async (m) => {
      const c = await m.default.createConnection(process.env.MAI_TEST_MYSQL_URL);
      const [rows] = await c.query("SELECT COUNT(*) AS n FROM wp_acme_tips");
      await c.end();
      if (rows[0].n !== 0) throw new Error("unexpected seed rows");
    }).catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });
  ' >/dev/null 2>&1; then
    break
  fi
  [ "$i" -lt 60 ] || { echo 'seeded MySQL never became reachable from the host via MAI_TEST_MYSQL_URL' >&2; exit 1; }
  sleep 2
done

"$@"
