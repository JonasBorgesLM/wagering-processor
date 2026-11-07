#!/usr/bin/env bash
#
# Stresses this service's own local stack with sapper (https://github.com/JonasBorgesLM/sapper): a spike, a ramp-up, a
# soak, and a dependency outage, each against a fresh throwaway database and one instance on loopback, each judged by
# the SLOs written in stress/scenarios/*.yaml and then by the books: the wallet is reconciled (balance == ledger).
#
#   docker compose up -d --wait postgres sqs && bun run provision
#   SAPPER_SRC=/path/to/sapper ./scripts/stress.sh spike ramp-up      # or SAPPER=/path/to/binary
#   ./scripts/stress.sh                                               # spike, ramp-up, outage (soak takes 10 minutes)
#
# Needs a sapper with request bodies and {{uuid}} (sapper PR #61, ADR-0010 there): an older one refuses the scenarios.
# Output: stress-results/<scenario>.json and .html (not committed). Exit status is non-zero if any SLO or any
# reconciliation failed. Never point sapper at anything you do not own.

set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${STRESS_PORT:-3098}"
WALLET="0192f291-27dd-7d3f-8071-5f8685deef37"
OUT="stress-results"
ADMIN_URL="${ADMIN_DATABASE_URL:-postgres://wagering:wagering@localhost:5433/wagering}"
APP_PID=""
DB=""

if [ -z "${SAPPER:-}" ]; then
  if [ -n "${SAPPER_SRC:-}" ]; then
    SAPPER="$(mktemp -d)/sapper"
    (cd "$SAPPER_SRC" && go build -o "$SAPPER" ./cmd/sapper) || exit 2
  elif command -v sapper >/dev/null 2>&1; then
    SAPPER="$(command -v sapper)"
  else
    echo "Set SAPPER to the sapper binary, or SAPPER_SRC to its checkout." >&2; exit 2
  fi
fi

SCENARIOS=("$@")
[ ${#SCENARIOS[@]} -eq 0 ] && SCENARIOS=(spike ramp-up outage)

psql_admin() { docker compose exec -T postgres psql -U wagering -d wagering -v ON_ERROR_STOP=1 -tA "$@"; }
cleanup() {
  # Waited for, not just signalled: the next scenario binds the same port, and a draining instance still holds it.
  [ -n "$APP_PID" ] && { kill "$APP_PID" 2>/dev/null; wait "$APP_PID" 2>/dev/null; }
  docker compose unpause postgres >/dev/null 2>&1
  [ -n "$DB" ] && psql_admin -c "drop database if exists $DB with (force)" >/dev/null 2>&1
  APP_PID=""; DB=""
}
trap cleanup EXIT

mkdir -p "$OUT"
FAILED=0

for name in "${SCENARIOS[@]}"; do
  scenario="stress/scenarios/$name.yaml"
  [ -f "$scenario" ] || { echo "no such scenario: $name" >&2; exit 2; }
  echo; echo "=== $name"

  DB="stress_$$_${name//-/_}"
  psql_admin -c "create database $DB" >/dev/null || exit 1
  export DATABASE_URL="${ADMIN_URL%/*}/$DB" PORT="$PORT" APP_ROLES=api,consumer,publisher,reference-worker
  bun run migrate up >/dev/null && bun run scripts/seed-stress.ts >/dev/null || { echo "setup failed" >&2; exit 1; }
  bun run src/main.ts > "$OUT/$name.app.log" 2>&1 &
  APP_PID=$!
  for _ in $(seq 1 60); do curl -sf "127.0.0.1:$PORT/health/ready" >/dev/null && break; sleep 0.5; done
  curl -sf "127.0.0.1:$PORT/health/ready" >/dev/null || { echo "the instance did not become ready" >&2; exit 1; }

  if [ "$name" = outage ]; then
    # Twenty seconds in (after the 5 s warm-up and some steady state), PostgreSQL stops answering for ten.
    ( sleep 20; docker compose pause postgres >/dev/null; sleep 10; docker compose unpause postgres >/dev/null ) &
    PAUSER=$!
  fi

  "$SAPPER" run --config stress/sapper.yaml --scenario "$scenario" --runs 1 --out "$OUT/$name.json"
  "$SAPPER" assert --in "$OUT/$name.json" || FAILED=1
  "$SAPPER" report --in "$OUT/$name.json" --out "$OUT/$name.html" >/dev/null 2>&1
  [ -n "${PAUSER:-}" ] && { wait "$PAUSER"; PAUSER=""; }
  docker compose unpause postgres >/dev/null 2>&1

  # sapper sees statuses; only the database knows whether the money is right.
  for _ in $(seq 1 20); do curl -sf "127.0.0.1:$PORT/health/ready" >/dev/null && break; sleep 0.5; done
  recon="$(curl -s -X POST "127.0.0.1:$PORT/wallets/$WALLET/reconciliation")"
  echo "reconciliation: $recon"
  echo "$recon" | grep -q '"consistent":true' || { echo "RECONCILIATION FAILED for $name" >&2; FAILED=1; }
  echo "transactions by status:"
  psql_admin -d "$DB" -c "select status, count(*) from wager_transactions where kind <> 'OPENING' group by status order by 1" | sed 's/^/  /'

  cleanup
done

echo; [ $FAILED -eq 0 ] && echo "all scenarios passed" || echo "FAILED (see above)"
exit $FAILED
