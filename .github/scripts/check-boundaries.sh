#!/usr/bin/env bash
#
# Enforces the layer rules in .dependency-cruiser.cjs.
#
# Reads the report rather than the exit code, for two reasons found by watching
# this check fail to fail: the JSON reporter exits 0 even with violations, and
# under TypeScript 7 (unsupported at the time) dependency-cruiser analysed 0
# modules and reported none. A check that never looked at the code is worse than
# no check, so analysing nothing is itself a failure.

set -uo pipefail
cd "$(dirname "$0")/../.."

report=$(mktemp)
trap 'rm -f "$report"' EXIT
bunx depcruise src --config .dependency-cruiser.cjs --output-type json > "$report" || true

read -r modules errors < <(bun -e '
  const { summary } = JSON.parse(await Bun.file(process.argv[1]).text());
  console.log(summary.totalCruised, summary.error);
' "$report")

if [ "${modules:-0}" -lt 1 ]; then
  echo "FAIL  dependency-cruiser analysed no modules, so it verified nothing."
  echo "      Check that the installed TypeScript is one it supports."
  exit 1
fi
if [ "${errors:-1}" -ne 0 ]; then
  bunx depcruise src --config .dependency-cruiser.cjs --output-type err
  echo "FAIL  layer boundary violated. See the Layers section of ARCHITECTURE.md."
  exit 1
fi
echo "ok    layer boundaries hold ($modules modules analysed)"
