#!/usr/bin/env bash
#
# A behaviour change updates its documents in the same pull request (NFR-12).
#
# This is a tripwire, not proof: it shows a document changed, never that it is
# right. A refactor with nothing to document uses the `no-docs-needed` label,
# which keeps the exception visible on the pull request.
#
#   ./.github/scripts/check-docs-touched.sh <base-ref>

set -uo pipefail
base="${1:?usage: check-docs-touched.sh <base-ref>}"

changed=$(git diff --name-only "$base"...HEAD)
if [ -z "$changed" ]; then
  echo "FAIL  no files differ from $base, so this check verified nothing."
  exit 1
fi

code=$(printf '%s\n' "$changed" | grep -E '^(src|migrations)/' || true)
docs=$(printf '%s\n' "$changed" | grep -E '(^|/)[^/]+\.md$' || true)

if [ -n "$code" ] && [ -z "$docs" ]; then
  echo "FAIL  behaviour may have changed, and no document did:"
  printf '%s\n' "$code" | sed 's/^/        /'
  echo "      Update the documents the issue names, or label the PR 'no-docs-needed'."
  exit 1
fi
echo "ok    documents kept up with code"
