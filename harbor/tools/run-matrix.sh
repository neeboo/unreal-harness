#!/usr/bin/env bash
# Run both arms of the A/B, sequentially, in one command.
#
# Sequential rather than concurrent because two matrices sharing a results tree
# proved fragile: a killed run leaves orphaned trial containers that keep writing
# into the same job directories, so a comparison can silently end up measuring a
# run against itself. One arm at a time is slower and correct.
#
# Usage:
#   ./run-matrix.sh [plugin.tgz]
#
# Environment:
#   TASKS_ROOT, TASKS, ATTEMPTS, RESULTS_DIR, PLUGIN as for run-arm.sh.

set -uo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
# One argument: the treatment's plugin tarballs, comma-separated. The adapter
# splits on commas because `--agent-kwarg` is a single key.
PLUGIN="${1:-}"
RESULTS_DIR="${RESULTS_DIR:-/tmp/rsi-smoke/ab-results}"
TRIALS_DIR="${TRIALS_DIR:-/tmp/rsi-smoke/ab-trials}"

started=$(date +%s)

echo "### arm 1/2: Dsh (bare)"
"$SELF_DIR/run-arm.sh" Dsh "$TRIALS_DIR" "$RESULTS_DIR"

if [ -n "$PLUGIN" ]; then
  echo "### arm 2/2: DshRsi (RSI trace mounted)"
  "$SELF_DIR/run-arm.sh" DshRsi "$TRIALS_DIR" "$RESULTS_DIR-rsi" "$PLUGIN"
else
  echo "### arm 2/2 skipped: pass the RSI plugin tarball as \$1 to run it"
fi

echo "### matrix complete in $(( ($(date +%s) - started) / 60 )) minutes"
echo "results: $RESULTS_DIR and $RESULTS_DIR-rsi"
