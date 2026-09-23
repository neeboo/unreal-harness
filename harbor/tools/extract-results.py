#!/usr/bin/env python3
"""Turn Harbor job output into the A/B table the report renders.

Reads every ``*/<trial>/result.json`` under a results directory and emits a JSON
summary keyed by ``(job_name, trial)``. Nothing here invents a number: a metric
is ``null`` when the run did not report it, and the report is expected to render
that as "not measured" rather than as zero.

Usage:
    extract-results.py <results-dir> [--out summary.json]
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pricing import TokenUsage, is_peak, price_usage  # noqa: E402


def _deep_get(mapping: Any, *path: str) -> Any:
    """Walk nested dicts, returning None instead of raising."""
    current = mapping
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _summarise_trial(result: dict[str, Any]) -> dict[str, Any]:
    """One trial's outcome, flattened into the fields the report uses."""
    verifier = result.get("verifier_result") or {}
    agent = result.get("agent_result") or {}
    exception = result.get("exception_info") or {}

    # Harbor reports rewards as a mapping (``{"rewards": {"reward": 1.0}}``) so a
    # task can carry several metrics; only the primary key is read, because
    # summing unrelated metrics would invent a number.
    reward = verifier.get("reward")
    if reward is None:
        reward = _deep_get(verifier, "rewards", "reward")

    duration_sec = _duration_sec(result.get("started_at"), result.get("finished_at"))

    usage = TokenUsage(
        uncached_input=int(_deep_get(result, "agent_result", "metadata", "dsh_uncached_input_tokens") or 0),
        cache_read=int(_deep_get(result, "agent_result", "metadata", "dsh_cache_read_tokens") or 0),
        cache_write=int(_deep_get(result, "agent_result", "metadata", "dsh_cache_write_tokens") or 0),
        output=int(agent.get("n_output_tokens") or 0),
    )
    model = _deep_get(result, "agent_info", "model_info", "name") or "deepseek-flash"
    priced = None
    started = result.get("started_at")
    if usage.total_input or usage.output:
        when = _parse_iso(started) if isinstance(started, str) else None
        try:
            priced = price_usage(usage, model, when)
        except KeyError:
            priced = None

    return {
        "trial_name": result.get("trial_name"),
        "task_name": result.get("task_name"),
        "agent": _deep_get(result, "agent_info", "name"),
        "agent_version": _deep_get(result, "agent_info", "version"),
        "model": _deep_get(result, "agent_info", "model_info", "name"),
        "reward": reward,
        "passed": (reward is not None and float(reward) >= 1.0),
        "n_input_tokens": agent.get("n_input_tokens"),
        "n_cache_tokens": agent.get("n_cache_tokens"),
        "n_output_tokens": agent.get("n_output_tokens"),
        "cost_usd": agent.get("cost_usd"),
        "metadata": agent.get("metadata"),
        # Priced here rather than read from Harbor, because Harbor's own cost
        # field is empty for an import-path agent (it has no rate card for one)
        # and a benchmark's central number must not be a hole.
        "cost_usd_priced": None if priced is None else round(priced.usd, 6),
        "pricing_window": None if priced is None else priced.window,
        "pricing_rates": None if priced is None else priced.rates_used,
        "started_at": result.get("started_at"),
        "finished_at": result.get("finished_at"),
        "duration_sec": duration_sec,
        "exception_type": exception.get("exception_type"),
        "exception_message": exception.get("exception_message"),
    }


def summarise(results_dir: Path) -> dict[str, Any]:
    trials: list[dict[str, Any]] = []
    # Recurse: Harbor nests a run's trials differently depending on whether it
    # was started by `harbor run` (job -> trials) or a bare job directory, and a
    # fixed-depth glob silently reports zero trials for one of them.
    for result_path in sorted(results_dir.rglob("result.json")):
        try:
            parsed = json.loads(result_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"skipping {result_path}: {exc}", file=sys.stderr)
            continue
        # A job-level result.json summarises its trials and has no trial_name;
        # counting it as a trial would double-count every run.
        if not parsed.get("trial_name"):
            continue
        job_name = _job_name_for(result_path, results_dir)
        trial = _summarise_trial(parsed)
        trial["job_name"] = job_name
        trial["arm"] = _arm_for(job_name, trial)
        trials.append(trial)

    return {"results_dir": str(results_dir), "arms": _by_arm(trials), "trials": trials}


def _job_name_for(result_path: Path, results_dir: Path) -> str:
    """The job directory a trial result lives under."""
    relative = result_path.relative_to(results_dir)
    return relative.parts[0] if len(relative.parts) > 1 else "unknown"


def _arm_for(job_name: str, trial: dict[str, Any]) -> str:
    """Which arm a trial belongs to.

    Taken from the job name, which the runner sets, and cross-checked against the
    agent name recorded by Harbor so a mislabelled directory cannot silently
    swap the arms of a comparison.
    """
    agent = trial.get("agent")
    if agent == "dsh-rsi":
        return "rsi"
    if agent == "dsh":
        return "bare"
    # Unknown agent: fall back to the job prefix rather than guessing.
    return "rsi" if job_name.startswith("DshRsi") else "bare"


def _by_arm(trials: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for trial in trials:
        grouped[trial["arm"]].append(trial)

    arms: list[dict[str, Any]] = []
    for arm in sorted(grouped):
        rows = grouped[arm]
        scored = [row for row in rows if row["reward"] is not None]
        passed = [row for row in scored if row["passed"]]
        arms.append(
            {
                "arm": arm,
                "trials": len(rows),
                "scored": len(scored),
                "passed": len(passed),
                "pass_rate": (len(passed) / len(scored)) if scored else None,
                "errors": sum(1 for row in rows if row["exception_type"]),
                "mean_input_tokens": _mean(row["n_input_tokens"] for row in scored),
                "mean_cache_tokens": _mean(row["n_cache_tokens"] for row in scored),
                "mean_output_tokens": _mean(row["n_output_tokens"] for row in scored),
                "total_cost_usd": _sum(row["cost_usd"] for row in scored),
                "total_cost_usd_priced": _sum(row["cost_usd_priced"] for row in scored),
                "mean_cost_usd_priced": _mean(row["cost_usd_priced"] for row in scored),
                "pricing_windows": sorted(
                    {row["pricing_window"] for row in scored if row["pricing_window"]}
                ),
                "mean_duration_sec": _mean(row["duration_sec"] for row in scored),
                # The billable prompt split, the primary dependent variable for a
                # cost claim. Cache hits bill at a fraction of misses, so these
                # must never be collapsed into one figure.
                "mean_uncached_input_tokens": _mean(
                    _deep_get(row["metadata"], "dsh_uncached_input_tokens")
                    for row in scored
                ),
                "mean_cache_read_tokens": _mean(
                    _deep_get(row["metadata"], "dsh_cache_read_tokens") for row in scored
                ),
                "mean_cache_hit_rate": _mean(
                    _deep_get(row["metadata"], "dsh_cache_hit_rate") for row in scored
                ),
                "mean_steps": _mean(_deep_get(row["metadata"], "dsh_steps") for row in scored),
            }
        )
    return arms


def _parse_iso(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _duration_sec(started: Any, finished: Any) -> float | None:
    """Wall-clock seconds between two ISO timestamps, or None if unusable."""
    if not isinstance(started, str) or not isinstance(finished, str):
        return None

    begin, end = _parse_iso(started), _parse_iso(finished)
    if begin is None or end is None:
        return None
    return (end - begin).total_seconds()


def _mean(values: Any) -> float | None:
    numbers = [float(value) for value in values if value is not None]
    return sum(numbers) / len(numbers) if numbers else None


def _sum(values: Any) -> float | None:
    numbers = [float(value) for value in values if value is not None]
    return sum(numbers) if numbers else None


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    results_dir = Path(sys.argv[1]).expanduser().resolve()
    if not results_dir.is_dir():
        print(f"not a directory: {results_dir}", file=sys.stderr)
        return 2

    summary = summarise(results_dir)
    out_path = (
        Path(sys.argv[sys.argv.index("--out") + 1])
        if "--out" in sys.argv
        else results_dir / "summary.json"
    )
    out_path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")

    for arm in summary["arms"]:
        rate = arm["pass_rate"]
        print(
            f"{arm['arm']:5} trials={arm['trials']:3} scored={arm['scored']:3} "
            f"passed={arm['passed']:3} "
            f"pass_rate={'n/a' if rate is None else f'{rate * 100:.1f}%'} "
            f"errors={arm['errors']:3}"
        )
    print(f"wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
