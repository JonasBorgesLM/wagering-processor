#!/usr/bin/env bash
#
# `number` for money is an elimination criterion, and TypeScript accepts it
# silently once a value is typed loosely. This catches the ways a float gets in.
#
# Scope is src/wagering and src/messaging: platform code legitimately parses
# ports and timeouts as numbers. A deliberate exception goes on its own line,
# marked `money-check: not-money <reason>`, so it stays visible in review.

set -uo pipefail
cd "$(dirname "$0")/../.."

dirs=()
for dir in src/wagering src/messaging migrations; do [ -d "$dir" ] && dirs+=("$dir"); done
if [ "${#dirs[@]}" -eq 0 ]; then
  echo "ok    no business code yet"
  exit 0
fi

pattern='parseFloat|parseInt|Number\(|\.toFixed\(|Math\.round|(amount|balance|money|Balance|Amount)[A-Za-z]*\??: *number|(numeric|decimal)\([^,)]*\)|double precision|\breal\b|\bmoney\b +(not null|null|default)'
# Lines that are only a comment are skipped: a comment declares no type, and the
# English word "real" otherwise matches the SQL type `real`. A comment trailing
# code on the same line is still scanned, because the code part is.
hits=$(grep -rnE "$pattern" "${dirs[@]}" --include='*.ts' \
  | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|/\*|\*)' \
  | grep -v 'money-check: not-money' || true)

if [ -n "$hits" ]; then
  printf '%s\n' "$hits"
  echo
  echo "FAIL  possible float or unscaled type for money. Use the Money class and numeric(20,2)."
  echo "      Not money? Add a comment on that line: // money-check: not-money <reason>"
  exit 1
fi
echo "ok    no float arithmetic or unscaled money type in business code"
