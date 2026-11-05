#!/usr/bin/env bash
#
# An ADR records the reasoning current when it was decided. A change of mind is
# a new ADR or an appended `## Amendment`, so an existing record may only gain lines.
#
#   ./.github/scripts/check-adr-immutable.sh <base-ref>

set -uo pipefail
base="${1:?usage: check-adr-immutable.sh <base-ref>}"

rewritten=""
while IFS= read -r file; do
  [ -z "$file" ] && continue
  deleted=$(git diff --numstat "$base"...HEAD -- "$file" | awk '{print $2}')
  [ "${deleted:-0}" -gt 0 ] && rewritten="$rewritten $file($deleted removed)"
done < <(git diff --name-only --diff-filter=MD "$base"...HEAD -- 'docs/adr/[0-9]*.md')

if [ -n "$rewritten" ]; then
  echo "FAIL  ADR rewritten rather than amended:$rewritten"
  echo "      Append '## Amendment', or write an ADR that supersedes it."
  echo "      Genuine typo: label the PR 'adr-typo'."
  exit 1
fi
echo "ok    no existing ADR lost a line"
