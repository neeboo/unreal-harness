#!/usr/bin/env bash
# Regenerate every derived artifact, then the report page.
#
# One command, so the page cannot drift from the runs that produced it: the
# report is built from JSON that this script derives from raw trial output, and
# nothing on the page is transcribed by hand.
#
# Usage:
#   ./refresh-report.sh [--harbor <results-dir> [<rsi-results-dir>]]
#
# With no arguments the harbor step is skipped and the existing summary is kept.
# Passing one directory extracts that tree; passing two merges the arms from
# both trees, which is how the A/B is rendered (the arms run into separate
# directories so a crashed arm cannot corrupt the other's results).

set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SELF_DIR/../.." && pwd)"
cd "$REPO_ROOT"

echo "### 1/3 replay experiment (synthetic worlds, no model calls)"
pnpm exec tsc -b packages/policy packages/bench >/dev/null
node packages/policy/lib/replay-experiment.js --out harbor/tools/replay-summary.json >/dev/null
echo "wrote harbor/tools/replay-summary.json"

# Harbor extraction is optional and separate. The committed
# harbor/tools/harbor-summary.json is the extracted comparison; re-extracting
# needs the raw run trees, which are large and deliberately not kept in the
# repository. Pass directories to refresh it, or leave it alone and the page
# renders from the committed summary.
if [ "${1:-}" = "--harbor" ]; then
  shift
  BARE="${1:?--harbor needs a results directory}"
  RSI="${2:-}"
  if [ ! -d "$BARE" ]; then
    echo "### 2/3 ERROR: $BARE does not exist; keeping the committed summary" >&2
  else
    mkdir -p /tmp/harbor-merged
    rm -rf /tmp/harbor-merged/*
    cp -R "$BARE" /tmp/harbor-merged/bare
    [ -n "$RSI" ] && [ -d "$RSI" ] && cp -R "$RSI" /tmp/harbor-merged/rsi
    echo "### 2/3 extract Harbor results"
    python3 "$SELF_DIR/extract-results.py" /tmp/harbor-merged --out harbor/tools/harbor-summary.json
  fi
else
  echo "### 2/3 Harbor extraction skipped; using the committed summary"
fi

echo "### 3/3 render the report page"
ARGS=(
  --propose-summary harbor/tools/propose-summary.json
  --replay-summary harbor/tools/replay-summary.json
  --loop-summary bench-out/main-low2/measurements.json
  --commit "$(git rev-parse --short HEAD)"
  --out BENCHMARK-REPORT.html
)
[ -f harbor/tools/harbor-summary.json ] && ARGS+=(--harbor-summary harbor/tools/harbor-summary.json)
python3 "$SELF_DIR/build-report.py" "${ARGS[@]}"

echo
echo "open: $REPO_ROOT/BENCHMARK-REPORT.html"
