#!/usr/bin/env bash
# Run one arm of the RSI-Harness A/B over a fixed subset of Terminal-Bench 4.0.
#
# Both arms are launched by this same script with the same arguments; the only
# difference the caller may introduce is the agent import path and the RSI
# plugin tarball. That is deliberate: if the two arms were driven by two
# different scripts, a difference in result could always be attributed to the
# scripts rather than to the plugin.
#
#   ./run-arm.sh Dsh    <trials-dir> <results-dir> [plugin.tgz]
#   ./run-arm.sh DshRsi <trials-dir> <results-dir> [plugin.tgz]
#
# The task subset is fixed here, in one place, so both arms provably saw it.

set -uo pipefail

ARM="${1:?usage: run-arm.sh <Dsh|DshRsi> <trials-dir> <results-dir> [plugin.tgz]}"
TRIALS_DIR="${2:?trials dir required}"
RESULTS_DIR="${3:?results dir required}"
PLUGIN="${4:-}"

HARBOR_DIR="${HARBOR_DIR:-/tmp/req_repos/ua/benchmarks/harbor}"
TASKS_ROOT="${TASKS_ROOT:-/tmp/tb-probe/terminal-bench}"
ATTEMPTS="${ATTEMPTS:-2}"
# Terminal-Bench ships an 8-hour per-task agent budget. That is the wrong scale
# for a comparison run, and it would also let one pathological task consume the
# whole matrix, so the agent and setup phases are capped by *multiplier* (the
# task's own value scaled down). The environment build timeout is left alone:
# scaling that one down would fail image builds rather than shorten runs.
# Harbor's agent-setup base is a fixed 360s (Trial._AGENT_SETUP_TIMEOUT_SEC), not
# the task's value, so the multiplier scales THAT. 3.34 gives ~1200s, which Node
# download + npm install + pnpm needs on a cold image.
SETUP_MULTIPLIER="${SETUP_MULTIPLIER:-3.34}"
AGENT_MULTIPLIER="${AGENT_MULTIPLIER:-0.0125}"

# A small, deliberately mixed subset: code authoring, debugging an existing
# implementation, and log forensics. All three build from a slim Python base and
# need no GPU. The subset is an environment variable so the report can name
# exactly what ran, and so a larger run does not require editing this file.
#
# Three tasks with one attempt each is a *pilot*: enough to show the harness
# drives a real public benchmark and reports honest numbers, not enough to rank
# against published figures. `BENCHMARK.md` §5 states that boundary.
read -r -a TASKS <<< "${TASKS:-html-js-filter session-window-debug shadow-relay}"

cd "$HARBOR_DIR" || exit 1
mkdir -p "$TRIALS_DIR" "$RESULTS_DIR"

# A killed run must not leave orphaned trial containers behind: leftovers keep
# writing into the results directory and silently duplicate trials, which is
# how an A/B can end up comparing a run against itself.
cleanup_orphans() {
  docker ps -a --format '{{.Names}}' 2>/dev/null \
    | grep -E '__env-(main|verifier)' \
    | xargs -r docker rm -f >/dev/null 2>&1 || true
}
trap cleanup_orphans EXIT

# DeepSeek bills peak hours at exactly double the off-peak rate. A matrix that
# straddles the boundary produces costs differing by 2x for reasons unrelated to
# the agent, so refuse to start inside a peak window rather than poison the
# comparison. The check lives here, not in the report, because by report time it
# is too late to fix.
# This script lives beside pricing.py, so resolve it relative to itself rather
# than to a hard-coded checkout path.
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
PRICING_PY="$SELF_DIR/pricing.py"
[ -f "$PRICING_PY" ] || PRICING_PY=""
if [ -n "${PRICING_PY:-}" ]; then
  if python3 "$PRICING_PY" | head -1 | grep -q PEAK; then
    WAIT_UNTIL="$(python3 - "$PRICING_PY" <<'PYEOF'
import sys, datetime
sys.path.insert(0, sys.argv[1].rsplit("/", 1)[0])
from pricing import next_off_peak_start
resume = next_off_peak_start(datetime.datetime.now(datetime.timezone.utc))
print("" if resume is None else resume.isoformat())
PYEOF
)"
    echo "currently in a DeepSeek PEAK pricing window (2x rates)."
    if [ -n "$WAIT_UNTIL" ]; then
      echo "off-peak resumes at $WAIT_UNTIL; waiting."
      SECONDS_TO_WAIT=$(python3 -c "
import datetime,sys
target=datetime.datetime.fromisoformat('$WAIT_UNTIL')
print(max(0,int((target-datetime.datetime.now(datetime.timezone.utc)).total_seconds())+30))")
      echo "sleeping ${SECONDS_TO_WAIT}s"
      sleep "$SECONDS_TO_WAIT"
    fi
  fi
fi

AGENT_ARGS=(--agent "harness_harbor.dsh_agent:${ARM}")
if [ -n "$PLUGIN" ]; then
  AGENT_ARGS+=(--agent-kwarg "rsi_plugin=${PLUGIN}")
fi

echo "arm=${ARM} attempts=${ATTEMPTS} tasks=${#TASKS[@]} plugin=${PLUGIN:-none}"

for task in "${TASKS[@]}"; do
  if [ ! -d "$TASKS_ROOT/$task" ]; then
    echo "MISSING TASK: $TASKS_ROOT/$task" >&2
    continue
  fi
  echo "=== ${ARM} :: ${task} ==="
  # Log to a file as well as the console: piping through `tail` buffers
  # everything, so an interrupted run loses the very output needed to diagnose
  # it -- which is exactly what happened on the first attempt.
  LOG="${RESULTS_DIR}/${ARM}-${task}.log"
  env -u ALL_PROXY -u all_proxy -u NO_PROXY -u no_proxy \
    timeout 5400 .venv/bin/harbor run \
      -p "$TASKS_ROOT/$task" \
      "${AGENT_ARGS[@]}" \
      -m deepseek/deepseek-flash \
      -k "$ATTEMPTS" \
      --agent-setup-timeout-multiplier "$SETUP_MULTIPLIER" \
      --agent-timeout-multiplier "$AGENT_MULTIPLIER" \
      --jobs-dir "$RESULTS_DIR" \
      --job-name "${ARM}-${task}" \
    > "$LOG" 2>&1
  status=$?
  tail -12 "$LOG"
  if [ "$status" -ne 0 ]; then
    echo "WARN: ${ARM} :: ${task} exited ${status} (see $LOG)" >&2
  fi
  echo "--- ${ARM} :: ${task} done ---"
done

echo "arm=${ARM} complete; results under $RESULTS_DIR"
