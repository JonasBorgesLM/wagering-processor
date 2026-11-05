#!/usr/bin/env bash
#
# Three application processes sharing one database must behave as one system
# (NFR-03). A single-instance solution is an elimination criterion, and the
# integration tests run in one process, so this is the check that uses several.
#
#   docker compose --profile app up -d --build --wait && ./.github/scripts/check-instances.sh
#
# What it proves: what one instance writes the others read, and a wallet created
# at the same moment through three processes is created once. It does not prove
# the settlement lock across processes: that is the failure suite's (issue #22).

set -uo pipefail
PORTS=(3001 3002 3003)
FAILED=0
fail() { printf 'FAIL  %s\n' "$1"; FAILED=1; }
pass() { printf 'ok    %s\n' "$1"; }

uuid() { cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen | tr '[:upper:]' '[:lower:]'; }
wallet_body() { printf '{"playerId":"%s","initialBalance":{"amount":"%s","currency":"BRL"}}' "$1" "$2"; }
create() { curl -s -o "$3" -w '%{http_code}' -X POST "localhost:$1/wallets" -H 'content-type: application/json' -d "$(wallet_body "$2" "${4:-100.00}")"; }

scratch=$(mktemp -d); trap 'rm -rf "$scratch"' EXIT

# 1. Written by one instance, read by the others
player=$(uuid)
status=$(create "${PORTS[0]}" "$player" "$scratch/created")
[ "$status" = "201" ] || fail "creating on ${PORTS[0]} answered $status, expected 201"
id=$(sed -E 's/.*"id":"([^"]+)".*/\1/' "$scratch/created")
for port in "${PORTS[@]:1}"; do
  got=$(curl -s "localhost:$port/wallets/$id")
  [ "$got" = "$(cat "$scratch/created")" ] || fail "port $port did not return the wallet created on ${PORTS[0]}: $got"
done
[ "$FAILED" = 0 ] && pass "a wallet created on ${PORTS[0]} is read identically on ${PORTS[*]:1}"

# 2. A duplicate is refused wherever it lands
for port in "${PORTS[@]}"; do
  status=$(create "$port" "$player" "$scratch/dup")
  [ "$status" = "409" ] || fail "a duplicate on $port answered $status, expected 409"
done
[ "$FAILED" = 0 ] && pass "a duplicate wallet is a 409 on every instance"

# 3. The same wallet requested at once through all three: one is created, two are refused
for round in 1 2 3 4 5; do
  racer=$(uuid)
  for port in "${PORTS[@]}"; do
    ( create "$port" "$racer" "$scratch/race-$port" > "$scratch/status-$port" ) &
  done
  wait
  created=0; refused=0
  for port in "${PORTS[@]}"; do
    case "$(cat "$scratch/status-$port")" in 201) created=$((created + 1)) ;; 409) refused=$((refused + 1)) ;; *) fail "round $round: port $port answered $(cat "$scratch/status-$port")" ;; esac
  done
  [ "$created" = 1 ] && [ "$refused" = 2 ] || fail "round $round: $created created and $refused refused, expected 1 and 2"
done
[ "$FAILED" = 0 ] && pass "five races of the same wallet through three processes: one created, two refused each time"

# 4. A bad request is the same answer everywhere
for port in "${PORTS[@]}"; do
  code=$(curl -s -o "$scratch/bad" -w '%{http_code}' -X POST "localhost:$port/wallets" -H 'content-type: application/json' -d '{"playerId":"nope"}')
  grep -q '"code":"VALIDATION_ERROR"' "$scratch/bad" && [ "$code" = "400" ] || fail "an invalid request on $port answered $code: $(cat "$scratch/bad")"
done
[ "$FAILED" = 0 ] && pass "an invalid request is a 400 with the same envelope on every instance"

exit "$FAILED"
