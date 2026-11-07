#!/usr/bin/env bash
#
# Three application processes sharing one database must behave as one system
# (NFR-03). A single-instance solution is an elimination criterion, and the
# integration tests run in one process, so this is the check that uses several.
#
#   docker compose --profile app up -d --build --wait && ./.github/scripts/check-instances.sh
#
# What it proves: what one instance writes the others read, a wallet created at
# the same moment through three processes is created once, and bets submitted
# through different processes are applied once and never overdraw. The wider
# failure suite (a process killed mid-settlement, restarts) is issue #22.

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

# 5. Bets through different processes share one wallet, and so one lock
fresh_wallet() {
  local player; player=$(uuid)
  create "${PORTS[0]}" "$player" "$scratch/wallet" "$1" > /dev/null
  WALLET_ID=$(sed -E 's/.*"id":"([^"]+)".*/\1/' "$scratch/wallet"); PLAYER_ID=$player
}
bet() { # port, external id, amount, idempotency key, output file
  curl -s -o "$5" -w '%{http_code}' -X POST "localhost:$1/wagering/transactions" \
    -H 'content-type: application/json' -H "idempotency-key: $4" \
    -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"$2\",\"playerId\":\"$PLAYER_ID\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"r1\",\"gameId\":\"g1\",\"kind\":\"BET\",\"money\":{\"amount\":\"$3\",\"currency\":\"BRL\"}}"
}
balance() { curl -s "localhost:${PORTS[0]}/wallets/$WALLET_ID" | sed -E 's/.*"balance":\{"amount":"([^"]+)".*/\1/'; }
debits() { curl -s "localhost:${PORTS[1]}/wallets/$WALLET_ID/ledger?limit=200" | grep -o '"direction":"DEBIT"' | wc -l | tr -d ' '; }

# 5a. The same bet 50 times, spread over the three processes: one debit
fresh_wallet "100.00"; ext=$(uuid)
rm -f "$scratch"/same-*
for i in $(seq 1 50); do
  ( bet "${PORTS[$((i % 3))]}" "$ext" "1.00" "provider-a:$ext" "$scratch/same-$i" > "$scratch/same-status-$i" ) &
done
wait
ok=0; fresh=0
for i in $(seq 1 50); do
  [ "$(cat "$scratch/same-status-$i")" = "200" ] && ok=$((ok + 1))
  grep -q '"idempotentReplay":false' "$scratch/same-$i" && fresh=$((fresh + 1))
done
[ "$ok" = 50 ] || fail "the same bet 50 times: $ok of 50 answered 200"
[ "$fresh" = 1 ] || fail "the same bet 50 times: $fresh answers were not replays, expected 1"
[ "$(balance)" = "99.00" ] || fail "the same bet 50 times left the balance at $(balance), expected 99.00"
[ "$(debits)" = 1 ] || fail "the same bet 50 times wrote $(debits) debits, expected 1"
[ "$FAILED" = 0 ] && pass "the same bet 50 times through three processes: one debit, 49 replays"

# 5b. Two bets of 80 against 100, in different processes: one applied, one refused, 20 left
for round in 1 2 3; do
  fresh_wallet "100.00"
  rm -f "$scratch"/two-*
  ( bet "${PORTS[0]}" "$(uuid)" "80.00" "k-$(uuid)" "$scratch/two-0" > "$scratch/two-status-0" ) &
  ( bet "${PORTS[1]}" "$(uuid)" "80.00" "k-$(uuid)" "$scratch/two-1" > "$scratch/two-status-1" ) &
  ( bet "${PORTS[2]}" "$(uuid)" "80.00" "k-$(uuid)" "$scratch/two-2" > "$scratch/two-status-2" ) &
  wait
  # One file each, because curl writes the status with no newline and cat would run three of them together.
  applied=0; refused=0
  for f in "$scratch"/two-status-*; do
    case "$(cat "$f")" in 200) applied=$((applied + 1)) ;; 422) refused=$((refused + 1)) ;; esac
  done
  [ "$applied" = 1 ] && [ "$refused" = 2 ] || fail "round $round: three bets of 80 against 100 gave $applied applied and $refused refused, expected 1 and 2"
  [ "$(balance)" = "20.00" ] || fail "round $round: the balance is $(balance), expected 20.00"
  [ "$(debits)" = 1 ] || fail "round $round: $(debits) debits, expected 1"
done
[ "$FAILED" = 0 ] && pass "three bets of 80 against 100, one per process, three times: one applied, two refused, 20.00 left"

exit "$FAILED"
