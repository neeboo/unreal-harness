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
#
# Environment:
#   HARBOR_DIR    the unreal-agent Harbor project (default below)
#   TASKS_ROOT    dataset directory of task folders
#   TASKS         space-separated task names
#   ATTEMPTS      attempts per task
#
# Prerequisites, in order of how easily they are missed:
#   1. A pre-baked toolchain (`./prebake-toolchain.sh`). Without it each trial
#      spends ~4 minutes installing Node and the harness, which is more than the
#      agent budget, so the matrix never produces a scored trial.
#   2. DEEPSEEK_API_KEY in the environment.

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
# task's own value scaled down). 0.03 of the 8-hour default is ~864s. This was
# measured, not guessed: at 288s every trial ended in AgentTimeoutError with the
# agent still working (23-63 model steps observed), and a timed-out trial yields
# no reward at all -- so too tight a budget does not make the matrix faster, it
# makes it produce nothing. The environment build timeout is left alone; scaling
# that down would fail image builds rather than shorten runs.
#
# Harbor's agent-setup base is a fixed 360s (Trial._AGENT_SETUP_TIMEOUT_SEC),
# not the task's value, so that multiplier scales 360. With a pre-baked
# toolchain setup is under a minute, so the slack is unused; it is kept for
# images where the toolchain is absent and npm must actually run.
SETUP_MULTIPLIER="${SETUP_MULTIPLIER:-3.34}"
AGENT_MULTIPLIER="${AGENT_MULTIPLIER:-0.03}"

# A small, deliberately mixed subset: code authoring, debugging an existing
# implementation, and log forensics. All three build from a slim Python base and
# need no GPU. Three tasks with two attempts each is a *pilot*: enough to show
# the harness drives a real public benchmark and reports honest numbers, not
# enough to rank against published figures. `BENCHMARK.md` §5 states that
# boundary.
read -r -a TASKS <<< "${TASKS:-html-js-filter session-window-debug shadow-relay}"

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"

# DeepSeek bills peak hours at exactly double the off-peak rate, so it matters
# which window a batch ran in -- but *blocking* on the boundary is worse than
# the problem. An earlier revision slept until off-peak resumed; on a peak
# afternoon that was a 166-minute stall with no output, which reads as a hung
# harness for a reason the operator cannot see.
#
# So the window is reported, never enforced. The extractor re-derives it from
# each trial's own start timestamp, which is the actual hazard: a batch that
# spans both windows mixes two price levels inside one comparison.
if [ -f "$SELF_DIR/pricing.py" ]; then
  echo "--- pricing window ---"
  python3 "$SELF_DIR/pricing.py" | head -2
  echo "----------------------"
fi

cd "$HARBOR_DIR" || exit 1
mkdir -p "$TRIALS_DIR" "$RESULTS_DIR"

# A killed run must not leave orphaned trial containers behind: leftovers keep
# writing into the results directory and silently duplicate trials, which is how
# an A/B can end up comparing a run against itself.
cleanup_orphans() {
  docker ps -a --format '{{.Names}}' 2>/dev/null \
    | grep -E '__env-(main|verifier)' \
    | xargs -r docker rm -f >/dev/null 2>&1 || true
}
trap cleanup_orphans EXIT

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
