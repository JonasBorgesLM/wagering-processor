#!/usr/bin/env bash
#
# Scans this service's own local stack with warden (https://github.com/JonasBorgesLM/warden), a black-box API
# security scanner. It builds a throwaway database, seeds it with the rows the OpenAPI examples name, starts one
# instance on loopback, runs scan, attack and report, and removes what it made.
#
#   docker compose up -d --wait postgres sqs && bun run provision
#   WARDEN=/path/to/warden ./scripts/security-scan.sh          # or WARDEN_SRC=/path/to/warden/checkout
#
# Output: security-results/ (not committed): findings.json, confirmed.json, report.html, report.json.
#
# Warden's active checks send hostile input and `test_creates` lets them send bodies to POST routes, so the target is
# a database made for the run and an instance on 127.0.0.1. Never point this at anything you do not own.

set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${SCAN_PORT:-3099}"
DB="warden_scan_$$"
OUT="security-results"
ADMIN_URL="${ADMIN_DATABASE_URL:-postgres://wagering:wagering@localhost:5433/wagering}"
APP_PID=""

if [ -z "${WARDEN:-}" ]; then
  if [ -n "${WARDEN_SRC:-}" ]; then
    WARDEN="$(mktemp -d)/warden"
    (cd "$WARDEN_SRC" && go build -o "$WARDEN" ./cmd/warden)
  elif command -v warden >/dev/null 2>&1; then
    WARDEN="$(command -v warden)"
  else
    echo "Set WARDEN to the warden binary, or WARDEN_SRC to its checkout." >&2; exit 2
  fi
fi

psql_admin() { docker compose exec -T postgres psql -U wagering -d wagering -v ON_ERROR_STOP=1 "$@" >/dev/null; }
cleanup() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null || true
  psql_admin -c "drop database if exists $DB with (force)" 2>/dev/null || true
}
trap cleanup EXIT

psql_admin -c "create database $DB"
export DATABASE_URL="${ADMIN_URL%/*}/$DB" PORT="$PORT" APP_ROLES=api

bun run migrate up >/dev/null
bun run scripts/seed-scan.ts
bun run start > "$(mktemp)" 2>&1 &
APP_PID=$!
for _ in $(seq 1 40); do curl -sf "127.0.0.1:$PORT/health/ready" >/dev/null && break; sleep 0.5; done
curl -sf "127.0.0.1:$PORT/health/ready" >/dev/null || { echo "the instance did not become ready" >&2; exit 1; }

mkdir -p "$OUT"
"$WARDEN" scan   --spec docs/openapi.yaml --config security/warden.yaml --out "$OUT/findings.json"
"$WARDEN" attack --in "$OUT/findings.json" --config security/warden.yaml --out "$OUT/confirmed.json"
"$WARDEN" report --in "$OUT/confirmed.json" --out "$OUT/report.html" --json "$OUT/report.json"
echo "report: $OUT/report.html"
