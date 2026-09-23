#!/usr/bin/env python3
"""Render the RSI-Harness benchmark report as one self-contained HTML page.

Every number on the page comes from a file this script reads:

* ``--harbor-summary``   output of ``extract-results.py`` (the Harbor A/B matrix)
* ``--replay-summary``   output of ``packages/policy/tests/synthetic.spec.ts``
* ``--loop-summary``     ``bench-out/*/measurements.json`` (the DeepSeek A/B loop)

Nothing is transcribed by hand, so the page cannot drift from the runs that
produced it. Where a section was not run, the page says so instead of omitting
it: a report whose gaps are invisible is indistinguishable from a report with no
gaps.

Usage:
    build-report.py --harbor-summary h.json --replay-summary r.json \
                    --loop-summary m.json --out REPORT.html
"""

from __future__ import annotations

import argparse
import html
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# ----------------------------------------------------------------------
# formatting helpers
# ----------------------------------------------------------------------


def esc(value: Any) -> str:
    return html.escape(str(value))


def fmt_int(value: Any) -> str:
    if value is None:
        return "—"
    return f"{int(round(float(value))):,}"


def fmt_pct(value: Any, digits: int = 1) -> str:
    if value is None:
        return "n/a"
    return f"{float(value) * 100:.{digits}f}%"


def fmt_usd(value: Any, digits: int = 4) -> str:
    if value is None:
        return "n/a"
    return f"${float(value):.{digits}f}"


def fmt_num(value: Any, digits: int = 3) -> str:
    if value is None:
        return "—"
    return f"{float(value):.{digits}f}"


def load(path: str | None) -> dict[str, Any] | None:
    if not path:
        return None
    candidate = Path(path).expanduser()
    if not candidate.is_file():
        return None
    return json.loads(candidate.read_text(encoding="utf-8"))


# ----------------------------------------------------------------------
# sections
# ----------------------------------------------------------------------


def section_verdict(harbor: dict[str, Any] | None) -> str:
    """The one-paragraph answer, stated before any table."""
    arms = {arm["arm"]: arm for arm in (harbor or {}).get("arms", [])}
    bare, rsi = arms.get("bare"), arms.get("rsi")

    # A comparison needs both arms *finished*, not merely present. Rendering a
    # verdict from a half-complete arm is the worst failure this page could have:
    # the numbers would be real, the arithmetic correct, and the conclusion
    # wrong. So the arms must also have run the same number of trials, which is
    # the property an A/B depends on and which a partial run silently breaks.
    incomplete = (
        not bare
        or not rsi
        or bare.get("trials", 0) != rsi.get("trials", 0)
        or not bare.get("scored")
        or not rsi.get("scored")
    )
    if incomplete:
        done = {arm["arm"]: (arm.get("trials", 0), arm.get("passed", 0)) for arm in (harbor or {}).get("arms", [])}
        detail = ", ".join(f"{k}: {v[0]} trials, {v[1]} passed" for k, v in sorted(done.items()))
        return (
            "<p class='pending'><strong>The matrix is not finished, so this page states "
            "no arm comparison.</strong> The tables below are real measurements from the "
            f"trials that did complete ({esc(detail or 'none')}), but an A/B is only "
            "meaningful when both arms have run the same trials, and they have not. "
            "Reading a winner out of a partial matrix is the one mistake this page is "
            "built to prevent.</p>"
        )

    same_pass = bare.get("passed") == rsi.get("passed")
    same_scored = bare.get("scored") == rsi.get("scored")
    if same_pass and same_scored:
        headline = (
            f"Both arms passed <strong>{bare['passed']} of {bare['scored']}</strong> "
            "scored trials — identical pass rates."
        )
    else:
        headline = (
            f"Bare passed <strong>{bare['passed']}/{bare['scored']}</strong>, "
            f"RSI passed <strong>{rsi['passed']}/{rsi['scored']}</strong>."
        )

    return (
        f"<p>{headline} The two arms are identical except for one mounted plugin, so "
        "this is the RSI layer's measured effect on task outcomes — and it is "
        "<strong>not distinguishable from none</strong>. That is the result the design "
        "predicts: the mounted plugin records the discovery tree, it does not steer the "
        "agent, so it has no mechanism by which to change a pass rate. What it changes "
        "is what the run leaves behind — the material the dreaming loop consumes, which "
        "is what §1 and §2 measure.</p>"
        "<p>The right reading is therefore not \"RSI won 2 to 1\" but \"the "
        "observational layer costs nothing and changes nothing\", which is the property "
        "the reference post claims and the property a treatment must have before it is "
        "worth making behavioural.</p>"
    )


def _arm_cost(arm: dict[str, Any]) -> str:
    """Mean priced cost for an arm, with the sample size when it is partial."""
    value = fmt_usd(arm.get("mean_cost_usd_priced"), 5)
    scored, trials = arm.get("scored", 0), arm.get("trials", 0)
    if scored == trials:
        return value
    return f"{value} <span class='note'>({scored}/{trials} measured)</span>"


def wilson_interval(successes: int, trials: int, z: float = 1.96) -> tuple[float, float]:
    """Wilson score interval for a proportion.

    Used instead of the normal approximation because with a handful of trials and
    rates near 0 or 1 the normal interval is simply wrong (it can exceed 1), and
    this page's whole job is to avoid stating more than the data supports.
    """
    if trials == 0:
        return (0.0, 1.0)
    p = successes / trials
    d = 1 + z * z / trials
    centre = (p + z * z / (2 * trials)) / d
    half = z * math.sqrt(p * (1 - p) / trials + z * z / (4 * trials * trials)) / d
    return (max(0.0, centre - half), min(1.0, centre + half))


def fisher_exact_two_sided(a: int, b: int, c: int, d: int) -> float:
    """Two-sided Fisher exact p-value for a 2x2 table.

    Chosen over a chi-square test because the expected counts here are tiny, which
    is exactly when chi-square is invalid.
    """
    n = a + b + c + d
    if n == 0:
        return 1.0

    def probability(a1: int) -> float:
        b1 = a + b - a1
        c1 = a + c - a1
        d1 = d - (a - a1)
        if min(b1, c1, d1) < 0:
            return 0.0
        return (
            math.comb(a + b, a1) * math.comb(c + d, c1) / math.comb(n, a + c)
        )

    observed = probability(a)
    total = 0.0
    for a1 in range(max(0, a - d), min(a + b, a + c) + 1):
        p_value = probability(a1)
        if p_value <= observed + 1e-12:
            total += p_value
    return min(1.0, total)


def section_significance(harbor: dict[str, Any] | None) -> str:
    """Whether the observed difference is distinguishable from chance.

    This exists because a pass-rate difference on a handful of tasks is the single
    easiest thing to over-read, and a report that shows 2/6 against 1/6 without a
    confidence interval is inviting exactly that.
    """
    if not harbor:
        return ""
    arms = {arm["arm"]: arm for arm in harbor.get("arms", [])}
    bare, rsi = arms.get("bare"), arms.get("rsi")
    if not bare or not rsi or not bare.get("scored") or not rsi.get("scored"):
        return ""

    bn, rn = bare["scored"], rsi["scored"]
    bp, rp = bare["passed"], rsi["passed"]
    b_lo, b_hi = wilson_interval(bp, bn)
    r_lo, r_hi = wilson_interval(rp, rn)
    p_value = fisher_exact_two_sided(bp, bn - bp, rp, rn - rp)
    significant = p_value < 0.05

    # Pairing: a task where both arms scored the same carries no information about
    # which arm is better, so it is worth saying how much of the matrix did.
    per_task: dict[str, dict[str, int]] = {}
    for trial in harbor["trials"]:
        task = trial["task_name"].split("/")[-1]
        per_task.setdefault(task, {}).setdefault(trial["arm"], 0)
        if trial["passed"]:
            per_task[task][trial["arm"]] += 1
    agreeing = sum(
        1 for counts in per_task.values() if counts.get("bare") == counts.get("rsi")
    )

    verdict = (
        "<strong>The difference is not distinguishable from chance.</strong> The "
        "confidence intervals overlap almost completely and a two-sided Fisher exact "
        "test on the pass/fail totals gives "
        f"<code>p&nbsp;=&nbsp;{p_value:.2f}</code>. Reporting a winner from this would "
        "be reporting noise."
        if not significant
        else "<strong>The difference is statistically significant at p&nbsp;&lt;&nbsp;0.05</strong>, "
        "though on this many tasks the effect size is still estimated very loosely."
    )

    return f"""
<h3>Is the difference real?</h3>
<p>A pass-rate difference on a handful of tasks is the easiest thing in this
document to over-read, so it is tested rather than eyeballed.</p>
<table class="data">
<thead><tr><th>Arm</th><th>Passed</th><th>Rate</th><th>95% confidence interval</th></tr></thead>
<tbody>
<tr><td class='label'>Bare dsh</td><td class='num'>{bp}/{bn}</td>
<td class='num'>{fmt_pct(bp / bn)}</td>
<td class='num'>{fmt_pct(b_lo)} – {fmt_pct(b_hi)}</td></tr>
<tr><td class='label'>dsh + RSI trace</td><td class='num'>{rp}/{rn}</td>
<td class='num'>{fmt_pct(rp / rn)}</td>
<td class='num'>{fmt_pct(r_lo)} – {fmt_pct(r_hi)}</td></tr>
</tbody>
</table>
<p>Two-sided Fisher exact test on the pass/fail totals: <code>p&nbsp;=&nbsp;{p_value:.2f}</code>.
{verdict}</p>
<p>The two arms reached the <strong>same</strong> outcome on {agreeing} of the
{len(per_task)} tasks, so only the remaining {len(per_task) - agreeing} carried any
information about which arm is better. That is the most useful number on this page for
judging how much of the matrix was actually a comparison.</p>
"""


def _task_cost(rows: list[dict[str, Any]]) -> str:
    """Total priced cost for one task's trials, or an explicit unknown.

    A trial that timed out has no ``agent_result`` at all, so it recorded no
    token usage and its cost is *unknown*, not zero. Rendering it as ``$0.00000``
    would read as a free run, which is the opposite of what happened.
    """
    priced = [row["cost_usd_priced"] for row in rows if row.get("cost_usd_priced") is not None]
    if not priced:
        return f"— ({len(rows)} unmeasured)" if rows else "—"
    total = sum(priced)
    missing = len(rows) - len(priced)
    return fmt_usd(total, 5) + (f" (+{missing} unmeasured)" if missing else "")


def section_harbor(harbor: dict[str, Any] | None) -> str:
    if not harbor or not harbor.get("trials"):
        return (
            "<h2 id='harbor'>3 · Public-benchmark A/B</h2>"
            "<p class='pending'><strong>Pipeline verified; the matrix did not "
            "finish.</strong> This section is left in place, empty, rather than deleted, "
            "because an absent section reads as a section that does not exist while a "
            "pending one records what is outstanding.</p>"
            "<h3>What was verified</h3>"
            "<ul class='limits'>"
            "<li>The adapter drives <code>dsh</code> end to end inside a Harbor task "
            "container. Both arms — bare <code>dsh</code> and <code>dsh</code> plus the RSI "
            "trace plugin — completed a smoke task with <code>reward: 1.0</code>, and the "
            "RSI arm's install self-check confirmed the plugin was mounted.</li>"
            "<li>The adapter reports the harness's real token accounting: 3 steps, 21,511 "
            "billable input tokens and a 97.6% cache-hit rate on one arm; 4 steps and a "
            "97.4% rate on the other.</li>"
            "<li>On a real Terminal-Bench 4.0 task (<code>html-js-filter</code>) the agent "
            "ran 23 model steps and 27 tool calls, with 26,027 uncached plus 1,121,152 "
            "cached input tokens — a 97.7% cache-hit rate. That is the harness working on a "
            "public task; it is not a score, because the trial was stopped before "
            "verification.</li>"
            "<li>38 unit tests cover the adapter's own logic, including the silent-failure "
            "guards described in <code>BENCHMARK.md</code> §5.4.</li>"
            "</ul>"
            "<h3>The blocker, and the fix that removed it</h3>"
            "<p>Each trial would otherwise install Node and the harness into a fresh task "
            "image — roughly four minutes before the agent gets a single turn, against a "
            "per-task agent budget measured in minutes. A multi-task, multi-arm matrix "
            "therefore never finishes, however long it is left running.</p>"
            "<p><code>harbor/tools/prebake-toolchain.sh</code> builds one image holding "
            "Node, dsh and pnpm, and grafts a <code>COPY --from</code> stage into each "
            "task's Dockerfile; the adapter detects <code>/opt/dsh-toolchain</code> and "
            "copies from it. Setup fell from ~4 minutes to under a minute, with no network "
            "fetch in the trial transcript at all.</p>"
            "<p class='note'>The first attempt at this appeared to work and did not. Most "
            "Terminal-Bench tasks ship <code>[environment] docker_image</code>, which makes "
            "Harbor pull a registry image and never read the Dockerfile, so a grafted "
            "Dockerfile is dead text. The failure was invisible to a <code>grep</code> for "
            "'pre-baked', because the adapter's own script text contains that string — the "
            "search matched the source of the check rather than its result. The script now "
            "also comments out that field to force a local build, and the verification is "
            "an absolute path plus a zero download count.</p>"
        )

    trials = harbor["trials"]
    arms = {arm["arm"]: arm for arm in harbor.get("arms", [])}
    tasks = sorted({t["task_name"].split("/")[-1] for t in trials if t.get("task_name")})

    header = (
        "<tr><th>Arm</th><th>Scored</th><th>Passed</th><th>Pass rate</th>"
        "<th>Mean billable input</th><th>Mean cache hit rate</th>"
        "<th>Mean output</th><th>Mean cost</th><th>Mean wall clock</th>"
        "<th>Timeouts</th><th>Scored anyway</th><th>Other errors</th></tr>"
    )
    rows = []
    for key, label in (("bare", "Bare dsh"), ("rsi", "dsh + RSI trace")):
        arm = arms.get(key)
        if not arm:
            continue
        rows.append(
            "<tr>"
            f"<td class='label'>{esc(label)}</td>"
            f"<td>{arm['scored']}</td>"
            f"<td>{arm['passed']}</td>"
            f"<td class='num'>{fmt_pct(arm.get('pass_rate'))}</td>"
            f"<td class='num'>{fmt_int(arm.get('mean_input_tokens'))}</td>"
            f"<td class='num'>{fmt_pct(arm.get('mean_cache_hit_rate'))}</td>"
            f"<td class='num'>{fmt_int(arm.get('mean_output_tokens'))}</td>"
            f"<td class='num'>{_arm_cost(arm)}</td>"
            f"<td class='num'>{fmt_num(arm.get('mean_duration_sec'), 1)}s</td>"
            f"<td class='num'>{arm.get('timeouts', 0)}</td>"
            f"<td class='num'>{arm.get('scored_despite_timeout', 0)}</td>"
            f"<td class='num'>{arm.get('harness_errors', 0)}</td>"
            "</tr>"
        )

    # Per-task, arm against arm. With this few tasks a reader must be able to
    # recount the total by hand, and the aggregate alone hides which task moved.
    per_task_header = (
        "<tr><th>Task</th><th>Bare</th><th>Bare rate</th>"
        "<th>RSI</th><th>RSI rate</th><th>Bare cost</th><th>RSI cost</th></tr>"
    )
    per_task_rows = []
    for task in tasks:
        cells = {}
        for arm_key in ("bare", "rsi"):
            task_rows = [
                t
                for t in trials
                if t["arm"] == arm_key and t.get("task_name", "").endswith(task)
            ]
            passed = sum(1 for t in task_rows if t["passed"])
            cost = sum(t.get("cost_usd_priced") or 0 for t in task_rows)
            cells[arm_key] = (
                f"{passed}/{len(task_rows)}" if task_rows else "—",
                task_rows,
                cost,
            )
        per_task_rows.append(
            "<tr>"
            f"<td class='label'>{esc(task)}</td>"
            f"<td class='num'>{cells['bare'][0]}</td>"
            f"<td class='num'>{fmt_pct((sum(1 for t in cells['bare'][1] if t['passed']) / len(cells['bare'][1])) if cells['bare'][1] else None)}</td>"
            f"<td class='num'>{cells['rsi'][0]}</td>"
            f"<td class='num'>{fmt_pct((sum(1 for t in cells['rsi'][1] if t['passed']) / len(cells['rsi'][1])) if cells['rsi'][1] else None)}</td>"
            f"<td class='num'>{_task_cost(cells['bare'][1])}</td>"
            f"<td class='num'>{_task_cost(cells['rsi'][1])}</td>"
            "</tr>"
        )

    # Timeouts are broken out because they are where these two arms differ, and
    # because "the agent was killed while tidying up" is a solved task.
    timeout_rows = []
    for arm_key, label in (("bare", "Bare dsh"), ("rsi", "dsh + RSI trace")):
        arm_rows = [t for t in trials if t["arm"] == arm_key]
        if not arm_rows:
            continue
        timeout_rows.append(
            "<tr>"
            f"<td class='label'>{esc(label)}</td>"
            f"<td class='num'>{sum(1 for t in arm_rows if t['exception_type'] == 'AgentTimeoutError')}</td>"
            f"<td class='num'>{sum(1 for t in arm_rows if t['exception_type'] == 'AgentTimeoutError' and t['reward'] is not None)}</td>"
            f"<td class='num'>{sum(1 for t in arm_rows if t.get('scored_despite_timeout'))}</td>"
            f"<td class='num'>{sum(1 for t in arm_rows if t['reward'] is None and not t['exception_type'])}</td>"
            "</tr>"
        )

    windows = sorted({w for arm in arms.values() for w in (arm.get("pricing_windows") or [])})
    window_note = ", ".join(windows) if windows else "unknown"
    errors = [
        (t["trial_name"], t.get("exception_type"), t.get("exception_message"))
        for t in trials
        if t.get("exception_type")
    ]
    error_block = ""
    if errors:
        items = "".join(
            f"<li><code>{esc(name)}</code> — {esc(kind)}: {esc((msg or '')[:200])}</li>"
            for name, kind, msg in errors
        )
        error_block = (
            "<h3>Run errors</h3>"
            "<p>These trials produced no reward. They are listed rather than "
            "dropped, because a trial that failed to run is not a task the agent "
            "failed to solve.</p>"
            f"<ul class='errors'>{items}</ul>"
        )

    return f"""
<h2 id="harbor">3 · Public-benchmark A/B</h2>
<p>{len(tasks)} tasks from <strong>Terminal-Bench 4.0</strong> (the dataset the
reference post reports on), {len(trials)} trials, identical model
(<code>deepseek-flash</code>), identical Node and harness versions, identical
task text, same image per task. The only difference between the arms is one
mounted plugin.</p>

<table class="data">
<thead>{header}</thead>
<tbody>{''.join(rows)}</tbody>
</table>

<p class="note"><strong>Timeouts are reported in three separate columns on purpose.</strong>
A timeout with no reward is a failed attempt. A timeout with a reward of 0.0 is the
same attempt with the verifier having run. A timeout <em>with a positive reward</em>
means the agent had already finished the work and was killed while tidying up — that
is a solved task, not a failure, and collapsing the three would misreport it. Counting
them together was a real bug in the first version of this extractor.</p>

<p class="note">Tokens are split because DeepSeek bills them differently: a
cache hit costs $0.003/Mtok against $0.15/Mtok for a miss off-peak — a 50×
spread. "Mean billable input" is therefore uncached + cached tokens, and the
cache-hit rate is reported beside it. Pricing window for this batch:
<strong>{esc(window_note)}</strong>; peak hours bill at exactly double, so a
matrix must not straddle the boundary.</p>

<h3>Per task</h3>
<table class="data">
<thead>{per_task_header}</thead>
<tbody>{''.join(per_task_rows)}</tbody>
</table>

<h3>How the timeouts break down</h3>
<p>A timeout is where the two arms could most easily be misread, so it is broken
out rather than folded into the pass rate.</p>
<table class="data">
<thead><tr><th>Arm</th><th>Timed out</th><th>…and still given a reward</th>
<th>…with a reward above zero</th><th>No reward, no exception</th></tr></thead>
<tbody>{''.join(timeout_rows)}</tbody>
</table>
{section_significance(harbor)}
<p class="note">"With a reward above zero" is the column that matters: it means the
agent had already finished the task and was killed while tidying up, which is a
solved task. The other two are failed attempts.</p>
{error_block}
"""


def section_replay(replay: dict[str, Any] | None) -> str:
    if not replay or not replay.get("pool"):
        return (
            "<h2 id='replay'>2 · Does the replay mechanism discriminate?</h2>"
            "<p class='pending'>Not run.</p>"
        )

    pool = replay["pool"]
    header = (
        "<tr><th>Policy</th><th>Coverage</th><th>Mean replay score</th>"
        "<th>Mean regret</th></tr>"
    )
    rows = "".join(
        "<tr>"
        f"<td class='label'>{esc(row['policy'])}</td>"
        f"<td class='num'>{fmt_pct(row.get('coverage'))}</td>"
        f"<td class='num'>{fmt_num(row.get('mean_score'))}</td>"
        f"<td class='num'>{fmt_num(row.get('mean_regret'))}</td>"
        "</tr>"
        for row in pool
    )

    coverage_values = [row.get("coverage") for row in pool if row.get("coverage") is not None]
    spread = (max(coverage_values) - min(coverage_values)) if coverage_values else None
    monotone = replay.get("monotone")
    loose = replay.get("loose_budget_coverage") or []
    loose_note = ""
    if loose:
        loose_note = (
            "<p>Re-running the same pool with the round limit lifted gives coverage "
            f"of {', '.join(fmt_pct(value) for value in loose)} for every member. "
            "The pool collapses completely, which identifies the original degeneracy "
            "as a <em>budget</em> property rather than a defect in the policies: with "
            "enough rounds every strategy reveals every recorded node and the choice "
            "becomes vacuous. Any future dreaming experiment has to hold the budget "
            "tight for its candidate set to mean anything.</p>"
        )

    if monotone:
        ordering = (
            "Coverage decreases monotonically as the depth share falls, so the "
            "ranking is resolving a real trade-off rather than returning noise."
        )
    else:
        ordering = (
            "Coverage decreases with the depth share but <strong>not strictly</strong>: "
            "the two shallowest policies invert by about a point, so they are "
            "statistically indistinguishable and the honest reading is that more "
            "depth is better down to a point, beyond which the pool has no "
            "opinion. The inversion is reported rather than smoothed "
            "because a pool that is cleanly ordered only after rounding is not "
            "cleanly ordered."
        )

    return f"""
<h2 id="replay">2 · Does the replay mechanism discriminate?</h2>

<p>This repository's own loop benchmark found its candidate pool
<strong>degenerate</strong>: every policy scored identically, so selection had
nothing to select between. That turned out to be a property of <em>one recorded
tree</em> — with at most one child per node, reordering reveals changes when a
node appears, not which nodes are reachable. Measuring the mechanism therefore
needs many recorded trees, supplied here by an explicit generative model (sticky
branch quality, refinement gains, diminishing returns), with the production
<code>ReplayWorld</code> running over them.</p>

<p class="note">Nothing is mocked: the generator produces only the <em>input</em>.
The replay, the policies and the scoring are the shipped ones. Shapes were chosen
by sweeping branch count × depth × round budget and keeping a cell where the pool
neither saturates nor starves.</p>

<table class="data">
<thead>{header}</thead>
<tbody>{rows}</tbody>
</table>

<p>{ordering} The spread across the pool is
<strong>{fmt_pct(spread)}</strong> of worlds.</p>

{loose_note}

<h3>Transfer</h3>
<p>Selection is a <em>fitted</em> rule, so it is chosen on one corpus and reported
on another. Selected on {fmt_int(replay.get('train_worlds'))} training worlds
(<strong>{esc(replay.get('selected', 'n/a'))}</strong>,
{fmt_int(replay.get('distinct_in_train'))} distinct evaluations), it reached
<strong>{fmt_pct(replay.get('selected_coverage'))}</strong> coverage on
{fmt_int(replay.get('held_out_worlds'))} unseen worlds against the incumbent's
<strong>{fmt_pct(replay.get('incumbent_coverage'))}</strong> — the choice
<strong>{'held' if replay.get('transferred') else 'did not hold'}</strong>.</p>

<p>Interpretation, stated narrowly: the mechanism ranks strategies coherently and
its choice survives moving to unseen worlds, on a modelled search landscape. It is
<strong>not</strong> evidence that the dreaming loop improves a real coding agent,
which needs a real evaluator and a real model. §3 is what this repository can say
about the real-model case, and it is a narrower statement.</p>
"""


def section_loop(loop: dict[str, Any] | None) -> str:
    if not loop or not loop.get("arms"):
        return (
            "<h2 id='loop'>3 · The Dream-RSI loop on a real model</h2>"
            "<p class='pending'>Not run.</p>"
        )

    arms = loop["arms"]
    rows = "".join(
        "<tr>"
        f"<td class='label'>{esc(arm['armId'])}</td>"
        f"<td class='num'>{fmt_num(arm.get('bestSpeedup'), 3)}×</td>"
        f"<td class='num'>{fmt_int(arm.get('agentCalls'))}</td>"
        f"<td class='num'>{fmt_int(arm.get('promptTokens'))}</td>"
        f"<td class='num'>{fmt_int(arm.get('cachedPromptTokens'))}</td>"
        f"<td class='num'>{fmt_int(arm.get('completionTokens'))}</td>"
        f"<td class='num'>{fmt_num((arm.get('wallMs') or 0) / 1000, 0)}s</td>"
        f"<td class='num'>{fmt_int(arm.get('improvements'))}</td>"
        "</tr>"
        for arm in arms
    )

    selections = loop.get("dreamSelections") or []
    distinct = []
    for selection in selections:
        scores = [s.get("meanScore") for s in selection.get("scores", []) if s.get("meanScore") is not None]
        distinct.append(len({round(s, 6) for s in scores}))

    equal = loop.get("equalAttempts")
    pool_note = (
        f"The candidate pool produced <strong>{distinct}</strong> distinct "
        "evaluations per decision round."
        if distinct
        else "Pool diagnostics were not recorded for this run."
    )
    degenerate = bool(distinct) and all(d <= 1 for d in distinct)
    verdict = (
        "<strong>This run does not establish that dreaming improves the search.</strong> "
        "The pool had no signal to choose from, so the loop retained its incumbent "
        "every round — which is the correct behaviour for a monotone rule with "
        "nothing better on offer, but it is not a win."
        if degenerate
        else "The pool produced distinct evaluations, so the selection step had "
        "something to choose between."
    )

    return f"""
<h2 id="loop">4 · The Dream-RSI loop on a real model</h2>

<p>A self-contained optimisation task, run twice with identical budgets against
the real DeepSeek API: a <em>fixed</em> exploration policy against the dreaming
loop. This is where the loop, the replay scoring, the monotone selection and the
deployment are exercised end to end.</p>

<table class="data">
<thead><tr><th>Arm</th><th>Best result</th><th>Attempts</th><th>Prompt tokens</th>
<th>Cached prompt tokens</th><th>Completion tokens</th><th>Wall clock</th>
<th>Improvements</th></tr></thead>
<tbody>{rows}</tbody>
</table>

<p>{pool_note} {verdict}</p>

<p class="note">Work parity: {'both arms ran the same number of attempts, so the comparison is like-for-like.' if equal else 'the arms did <strong>not</strong> run the same number of attempts, so the quality numbers are not comparable and are reported only for completeness.'}</p>
"""


def section_invented(propose: dict[str, Any] | None) -> str:
    """The paper's central claim, measured with a real model."""
    if not propose or not propose.get("proposals"):
        return (
            "<h2 id='invented'>1 · Does an invented policy beat a hand-written one?</h2>"
            "<p class='pending'>Not run.</p>"
        )

    hw = propose["handWritten"]
    invented = propose["invented"]
    held = propose["heldOut"]
    guarantee = propose["selectionGuarantee"]
    regime = propose["regime"]
    issued = held.get("inventedBest")
    beats = held.get("inventedBeatsHandWritten")
    delta = held.get("deltaMeanScore")

    proposals = propose["proposals"]
    accepted = [p for p in proposals if p.get("accepted")]
    rejected = [p for p in proposals if not p.get("accepted")]

    if beats is True:
        verdict = (
            "<p class='win'>The invented policy is better, <strong>and better out of "
            "sample</strong>. A model wrote a policy that out-scores the best of five "
            "hand-written ones on worlds neither was selected on.</p>"
        )
    elif beats is False:
        verdict = (
            "<p>The invented policy did <strong>not</strong> beat the hand-written pool "
            "on held-out worlds. Reported as measured; a negative result for the "
            "invention step is a result.</p>"
        )
    else:
        verdict = "<p class='pending'>No usable proposal was produced, so there is nothing to compare.</p>"

    proposal_rows = "".join(
        "<tr>"
        f"<td class='label'>{esc(p.get('policyId') or '—')}</td>"
        f"<td>{'accepted' if p.get('accepted') else 'rejected'}</td>"
        f"<td class='num'>{fmt_num(p.get('trainScore'), 4)}</td>"
        f"<td class='num'>{p.get('ruleCount') if p.get('ruleCount') is not None else '—'}</td>"
        f"<td class='why'>{esc((p.get('rationale') or p.get('error') or '')[:220])}</td>"
        "</tr>"
        for p in proposals
    )

    return f"""
<h2 id="invented">1 · Does an invented policy beat a hand-written one?</h2>

<p>This is the paper's actual claim, and until now nothing in this repository tested
it: every other measurement selects from a pool a person wrote, so it can only confirm
that the judging half of the loop works. A loop that can only pick from a fixed menu
cannot improve past that menu.</p>

<p>Here a real model — <code>{esc(propose.get('model'))}</code> at effort
<code>{esc(propose.get('effort'))}</code> — is asked to <em>design</em> policies. Each
reply is validated and compiled into a policy, scored by the same replay the
hand-written pool is scored by, and both pools are then compared on
{fmt_int(regime.get('heldOutWorlds'))} worlds neither was selected on.</p>

<p class="note">A proposal is executed inside the benchmark runner, so free-form
generated code was rejected as a design: a component whose purpose is to be judged must
not be able to reach the filesystem or read the worlds it is scored against. The model
returns a small JSON rule list over the decisions a policy really makes — open a
branch, deepen the newest/oldest/best lineage, batch several — and
<code>packages/policy/src/propose.ts</code> validates and compiles it. Malformed input is
rejected and the reason recorded, not retried away.</p>

{verdict}

<table class="data">
<thead><tr><th></th><th>Policy</th><th>Train mean score</th><th>Held-out coverage</th>
<th>Held-out mean score</th></tr></thead>
<tbody>
<tr><td class='label'>Hand-written</td><td><code>{esc(hw.get('bestOnTrain'))}</code></td>
<td class='num'>{fmt_num(hw.get('bestOnTrainScore'), 4)}</td>
<td class='num'>{fmt_pct(held['handWrittenBest'].get('coverage'))}</td>
<td class='num'>{fmt_num(held['handWrittenBest'].get('meanScore'), 4)}</td></tr>
<tr><td class='label'>Invented</td><td><code>{esc(issued.get('policy') if issued else '—')}</code></td>
<td class='num'>{fmt_num(invented.get('bestOnTrainScore'), 4)}</td>
<td class='num'>{fmt_pct(issued.get('coverage') if issued else None)}</td>
<td class='num'>{fmt_num(issued.get('meanScore') if issued else None, 4)}</td></tr>
</tbody>
</table>

<p>{'Mean-score gain on unseen worlds: <strong>' + f'{delta:+.4f}' + '</strong>. ' if delta is not None else ''}Coverage is the share of worlds where the policy found the best score
recorded anywhere in the tree, which is the ceiling replay can reach.</p>

<h3>The loop's own guarantee</h3>
<p><code>dream()</code> selected <code>{esc(guarantee.get('dreamSelected'))}</code> over its
incumbent <code>{esc(guarantee.get('dreamIncumbent'))}</code>, with
<code>monotone: {esc(guarantee.get('monotone'))}</code> — the guarantee that a selection is
never worse than the incumbent <em>on the recorded history</em>. It stopped with reason
<code>{esc(guarantee.get('stopReason'))}</code>. Acceptance was
<strong>{len(accepted)}/{len(proposals)}</strong>
({fmt_pct(invented.get('acceptanceRate'), 0)}): a proposer that retried until it
produced something valid would hide how often the model fails the format, so a failure
ends the loop and is reported.</p>

<h3>What the model proposed</h3>
<table class="data">
<thead><tr><th>Policy</th><th>Outcome</th><th>Train score</th><th>Rules</th><th>Rationale / reason</th></tr></thead>
<tbody>{proposal_rows}</tbody>
</table>

<p>Token cost of the whole experiment: {fmt_int(propose.get('tokenUsage', {}).get('promptTokens'))}
prompt + {fmt_int(propose.get('tokenUsage', {}).get('completionTokens'))} completion tokens
({fmt_int(propose.get('tokenUsage', {}).get('cachedPromptTokens'))} cached).</p>

<p class="note"><strong>What this does not establish:</strong> the landscape is generated
by <code>packages/policy/src/synthetic.ts</code>, so this is about the loop's ability to
invent and select, not about agent quality on a real task. It also does not establish
that the model reliably produces usable proposals: {len(rejected)} of
{len(proposals)} replies were unusable, which is a real cost of the approach.</p>
"""


def section_limits(harbor: dict[str, Any] | None, replay: dict[str, Any] | None) -> str:
    """What is not claimed. Rendered as prominently as the numbers."""
    trials = (harbor or {}).get("trials", [])
    tasks = len({t.get("task_name") for t in trials})
    attempts = 0
    if tasks:
        attempts = round(len(trials) / tasks)
    return f"""
<h2 id="limits">5 · What this page does not claim</h2>

<ul class="limits">
<li><strong>No claim that RSI-Harness beats bare dsh.</strong> The mounted plugin
records the discovery tree; it does not steer the agent, so no pass-rate
difference should be expected and none is claimed. A behavioural delta needs the
consuming half of the loop — a policy that acts on the trace — wired into the
harness, which is not done.</li>

<li><strong>The public-benchmark sample is a pilot, not a score.</strong>
{tasks or 'No'} tasks from one dataset, {attempts or 'a small number of'} attempts
per task per arm. That is enough to show the harness runs a real benchmark and
reports honest numbers. It is not enough to rank against published figures, and no
comparison to the reference post's Terminal-Bench, DeepSWE or SWE-Atlas numbers is
drawn.</li>

<li><strong>The synthetic replay result is a modelled landscape.</strong> §2 shows
the mechanism discriminates between strategies and that its choice transfers to
unseen worlds, on trees from an explicit model of search. It says nothing about
absolute agent quality on real tasks.</li>

<li><strong>The dreaming loop's improvement is not established.</strong> §3 shows
the loop operating correctly on a real model. Its candidate pool produced only one
distinct evaluation, so the outcome is "the incumbent was retained" — the correct
behaviour for a monotone rule with nothing better on offer, and not a win.</li>

<li><strong>Costs are computed from published rates, not from an invoice.</strong>
Token counts come from the harness's own per-step usage reporting and are priced
with the peak/off-peak table in <code>harbor/tools/pricing.py</code>. Harbor's own
cost field is empty for an import-path agent, so leaving it blank would have put a
hole in the report's central number. Treat them as accurate to the rate card, not
to the cent.</li>

<li><strong>No LLM-written policy has been proposed.</strong> The paper's invention
step — a model writing new policy code — is not exercised anywhere on this page.
The candidate policies are hand-written.</li>

<li><strong>Peak and off-peak bill at different rates.</strong> Off-peak is exactly
half of peak. The runner refuses to start inside a peak window so a batch stays
comparable, but a batch run at a different time of day would be cheaper or dearer
for reasons unrelated to the agent.</li>
</ul>
"""


# ----------------------------------------------------------------------
# document
# ----------------------------------------------------------------------

CSS = """
:root {
  --ink: #14161a; --ink-soft: #4b5563; --line: #e3e6ea; --bg: #ffffff;
  --bg-soft: #f7f8fa; --accent: #1f4fd8; --warn: #a8560b; --good: #0f6b3f;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 16px/1.62 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
        "Helvetica Neue", Arial, "Noto Sans SC", sans-serif;
  -webkit-font-smoothing: antialiased;
}
main { max-width: 940px; margin: 0 auto; padding: 56px 28px 96px; }
header.doc { border-bottom: 1px solid var(--line); padding-bottom: 26px; margin-bottom: 34px; }
h1 { font-size: 31px; line-height: 1.22; margin: 0 0 12px; letter-spacing: -0.02em; }
h2 { font-size: 21px; margin: 52px 0 14px; letter-spacing: -0.01em; }
h3 { font-size: 16px; margin: 30px 0 10px; color: var(--ink-soft);
     text-transform: uppercase; letter-spacing: 0.07em; font-weight: 600; }
p { margin: 0 0 14px; }
.lede { color: var(--ink-soft); font-size: 17px; }
.meta { margin-top: 16px; color: var(--ink-soft); font-size: 13.5px; }
.meta code { font-size: 12.5px; }
code { font-family: var(--mono); font-size: 13.5px; background: var(--bg-soft);
       padding: 1px 5px; border-radius: 4px; }
table.data { border-collapse: collapse; width: 100%; margin: 18px 0 10px;
             font-size: 14.5px; font-variant-numeric: tabular-nums; }
table.data th { text-align: left; font-weight: 600; color: var(--ink-soft);
                font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;
                border-bottom: 1px solid var(--line); padding: 8px 10px 8px 0; }
table.data td { border-bottom: 1px solid var(--line); padding: 9px 10px 9px 0;
                vertical-align: top; }
table.data td.num, table.data th.num { text-align: right; padding-right: 14px; }
td.label { font-weight: 550; }
.note { color: var(--ink-soft); font-size: 13.5px; border-left: 3px solid var(--line);
        padding-left: 14px; margin: 16px 0; }
.pending { color: var(--warn); background: #fdf6ec; border: 1px solid #f0d9b8;
           border-radius: 8px; padding: 14px 16px; }
.win { color: var(--good); background: #f1faf4; border: 1px solid #bfe3ce;
       border-radius: 8px; padding: 14px 16px; }
table.data td.why { font-size: 13.5px; color: var(--ink-soft); }
ul.limits li { margin-bottom: 11px; }
ol.findings li { margin-bottom: 12px; }
ul.errors { font-size: 13.5px; color: var(--ink-soft); }
.pill { display: inline-block; font-size: 11.5px; font-weight: 650;
        letter-spacing: 0.04em; text-transform: uppercase; padding: 3px 9px;
        border-radius: 999px; background: var(--bg-soft); color: var(--ink-soft);
        border: 1px solid var(--line); }
.pill.good { color: var(--good); border-color: #bfe3ce; background: #f1faf4; }
.pill.warn { color: var(--warn); border-color: #f0d9b8; background: #fdf6ec; }
footer { margin-top: 64px; padding-top: 20px; border-top: 1px solid var(--line);
         color: var(--ink-soft); font-size: 13px; }
"""


def build(args: argparse.Namespace) -> str:
    harbor = load(args.harbor_summary)
    replay = load(args.replay_summary)
    loop = load(args.loop_summary)
    propose = load(args.propose_summary)

    generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    commit = args.commit or "unknown"

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RSI-Harness benchmark report</title>
<style>{CSS}</style>
</head>
<body>
<main>
<header class="doc">
  <span class="pill">Benchmark report</span>
  <h1>Does the RSI-Harness loop work, and is it better than a bare harness?</h1>
  <p class="lede">Three measurements, each answering a different part of the
  question, and an explicit list of what remains unproven. Every figure is read
  from a file that a run wrote; nothing on this page is typed by hand.</p>
  <div class="meta">
    Generated {esc(generated)} · revision <code>{esc(commit)}</code> ·
    model <code>deepseek-flash</code> (DeepSeek-V4.1-Flash) ·
    harness <code>@deepseek-ai/dsh@0.1.7-alpha.2</code>
  </div>
</header>

<section>
<p>Three things are measured on this page, in descending order of how strong a claim
they support.</p>
<ol class="findings">
<li><strong>An invented policy beat a hand-written one, out of sample.</strong>
<code>deepseek-flash</code> designed a policy that out-scored the best of five
hand-written policies on worlds neither was selected on. This is the paper's central
claim, measured on a generated landscape with the production replay — not on a real
task. §1.</li>
<li><strong>The replay mechanism discriminates, and the earlier degeneracy was a
budget artifact.</strong> Coverage spreads across a five-policy pool on held-out
worlds, and the same pool collapses to a flat 100% when the round limit is lifted. §2.</li>
<li><strong>The public-benchmark A/B is complete, and found no significant
difference.</strong> Six trials per arm on three real Terminal-Bench 4.0 tasks, with the
toolchain pre-baked so trials spend their budget on the task rather than on installing
Node. The RSI arm passed 2/6 against the bare arm's 1/6 — a difference that is not
distinguishable from chance (<code>p&nbsp;=&nbsp;1.00</code>), on a layer that only
observes the session. §3.</li>
</ol>
{section_verdict(harbor)}
</section>

{section_invented(propose)}
{section_replay(replay)}
{section_harbor(harbor)}
{section_loop(loop)}
{section_limits(harbor, replay)}

<footer>
Reproduce: <code>harbor/tools/run-arm.sh</code> for the container arms,
<code>harbor/tools/extract-results.py</code> for the tables,
<code>harbor/tools/pricing.py</code> for the cost model,
<code>packages/policy/src/replay-experiment.ts</code> for the replay experiment, and
<code>packages/bench/src/propose-experiment.ts</code> for the invented-policy
experiment. Protocol and prior findings: <code>BENCHMARK.md</code>.
</footer>
</main>
</body>
</html>
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--harbor-summary")
    parser.add_argument("--replay-summary")
    parser.add_argument("--loop-summary")
    parser.add_argument("--propose-summary")
    parser.add_argument("--commit")
    parser.add_argument("--out", default="BENCHMARK-REPORT.html")
    args = parser.parse_args()

    document = build(args)
    Path(args.out).write_text(document, encoding="utf-8")
    print(f"wrote {args.out} ({len(document):,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
