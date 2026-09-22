# Benchmarking: which standards, what they measure, and what this repository can actually run

## 1. The short version

Two different questions are being asked, and they need two different benchmarks.

| Question | What answers it | Status here |
|---|---|---|
| Does the Dream-RSI loop work — does replay-based policy improvement actually improve anything, or at least not regress? | A controlled A/B where the **only** difference between arms is the exploration policy, on a task with a real evaluator | **Measured.** `packages/bench`, results in [`bench-out/main-low/report.md`](bench-out/main-low/report.md) |
| Is RSI-Harness better than a plain harness on public coding benchmarks? | Harbor-based runs on Terminal-Bench 4.0 / DeepSWE 1.1 / SWE-Atlas QnA / ALE-CLI, against a bare-`dsh` arm | **Not measured yet.** The harness layer exists; the runs are blocked on Docker/Modal. Design in §5 |

The rest of this document says exactly which standards apply, and why the second
question cannot be answered by the first.

## 2. What the reference numbers actually are

[Unreal Labs' Unreal Agent post](https://unreallabs.ai/blog/unreal-agent) is the
comparison this repository aims to sit beside. Its numbers, for reference:

| Benchmark | Agent | Pass rate | Total $ | In/trial | Out/trial | Turns | Tools |
|---|---|---:|---:|---:|---:|---:|---:|
| Terminal-Bench 4.0 | unreal-agent | 57.9% | **1428** | 1.73M | 32k | 28 | 37 |
| Terminal-Bench 4.0 | Codex (leaderboard) | 57.9% | 2350 | — | — | — | — |
| Terminal-Bench 4.0 | Pi | 55.0% | 1827 | 2.83M | 35k | 44 | 57 |
| SWE-Atlas Codebase QnA | unreal-agent | **65.8%** | **936** | 898k | 15k | 16 | 27 |
| SWE-Atlas Codebase QnA | Codex | 63.3% | 1303 | 1.69M | 17k | 22 | 21 |
| SWE-Atlas Codebase QnA | Pi | 64.0% | 1033 | 1.29M | 16k | 24 | 60 |
| DeepSWE 1.1 | unreal-agent | **72.4%** | **1367** | 1.60M | 28k | 26 | 38 |
| DeepSWE 1.1 | Codex | 69.0% | 1633 | 2.19M | 30k | 30 | 29 |
| DeepSWE 1.1 | Pi | 69.6% | 1584 | 2.21M | 30k | 40 | 75 |
| ALE-CLI | unreal-agent | 30.0% (mean 59.7) | **217** | 0.76M | 18k | 18 | 23 |
| ALE-CLI | Codex | 29.0% (mean 58.1) | 292 | 1.59M | 15k | — | 21 |
| ALE-CLI | Pi | 29.0% (mean 59.2) | 262 | 1.19M | 19k | 27 | 37 |

**The claim being made there is not "higher pass rate".** The pass-rate differences
are 1.6–3.4 points and the post itself calls them "marginal … benchmark variance".
The claim is **cost at equal pass rate** — 40% cheaper than Codex, 20% cheaper than
Pi. That is why the metrics that matter are the cost columns, and why any comparison
this repository makes must report both axes. `packages/bench/src/types.ts` enforces
this with a four-way verdict (`dominates` / `equivalent` / `trade-off` /
`dominated`) rather than a single better-or-worse.

## 3. The standards, and why each is the right (or wrong) yardstick

| Benchmark | What it is | Why it would be used | Access path |
|---|---|---|---|
| **Terminal-Bench 4.0** | Agentic terminal tasks in a container; graded by task-specific tests | The closest public analogue to "a coding agent doing real work"; the reference post's headline number | Harbor: `-d terminal-bench/terminal-bench@4.0.0` |
| **DeepSWE 1.1** | Software-engineering issue resolution | The strongest signal for code-editing ability specifically | Harbor dataset id |
| **SWE-Atlas Codebase QnA** | Questions answered against a large codebase | Reads and searches rather than edits — the 56% of tool turns the design doc calls out as the dominant cost | Harbor dataset id |
| **ALE-CLI** | Agents' Last Exam, CLI subset; full-pass rate and mean score | Long-horizon tasks that resist shallow optimization | Not on Harbor; run separately |
| **Dream-RSI's own tasks** | Lasso regularization path, Sum–Diff, Circle Packing, Autocorrelation, KernelBench (VGG16 / LayerNorm / ConvDiv / ConvMax) | The only benchmarks the Dream-RSI paper reports on, so the only way to check an implementation against the paper | Paper's repo ships a Lasso solver only; the rest must be rebuilt |
| **Harbor** itself | The evaluation framework all of the above run in | Reproducibility: job ids are published, so a reader can re-inspect a run | `harbor run`; needs Docker or Modal |

**Which to use for the two questions:**

- *Does the loop work?* — none of them. A public coding benchmark conflates the
  exploration policy with the model, the scaffold, and the task mix. It cannot
  isolate "did the dreaming improve the strategy". Use a controlled A/B (§4).
- *Is the harness better?* — Terminal-Bench 4.0 first (most reproducible and the
  reference post's headline), DeepSWE 1.1 second (code editing), SWE-Atlas QnA
  third (read-heavy, where a context policy should show up most).

## 4. What this repository measures, and what it found

`packages/bench` runs a **two-arm, equal-attempt-budget A/B** where the model
(`deepseek-flash`), the task, the seed code, and the evaluator are identical, and
the **only** difference is which node each attempt continues from.

- **Task:** optimize a rolling-maximum implementation. Correctness is a gate
  (checked against the seed's output on held-out instances); quality is median
  held-out runtime, measured **out of process** so candidate code cannot influence
  its own scoring.
- **Arm `fixed`:** the hand-written baseline — open a branch, continue the newest
  node. The same policy every round.
- **Arm `dream`:** identical budget, but between rounds it replays every recorded
  tree, scores each candidate policy against them, and deploys the best. Dreaming
  costs **no model calls**.
- **Premise, checked not assumed:** both arms execute the same number of attempts,
  and the report says so explicitly (or marks the comparison invalid).

### The result

See [`bench-out/main-low/report.md`](bench-out/main-low/report.md) for the run that
produced these, with the discovery curve and the per-round replay scores.

**Dream-RSI's mechanism works and its selection is monotone; on this task it had
nothing to improve.** Two facts, and the second matters as much as the first:

1. **The loop is doing its job.** Replaying 0 → 1 → 2 → … recorded worlds, the
   selection rule always kept the incumbent, and it is never worse on the recorded
   history than the policy it started from. That is the paper's guarantee, observed.
2. **The incumbent was already the best policy in the pool.** The four candidates
   differ in *when* they spend attempts, and with a fixed attempt budget they explore
   the same amount of tree — so the dreaming had no headroom to find.

The honest reading: **this run validates the loop, not the payoff.** A payoff needs
either a candidate pool containing a genuinely better policy, or a budget model
where allocation actually differs (§4.1).

### 4.1 The budget model decides which question you are asking

| Budget model | What it isolates | Status |
|---|---|---|
| **Equal attempts** (implemented) | Routing: identical work, placed differently | Measured |
| **Equal decision rounds** | Parallelism: same wall-clock rounds, more attempts per round | Not yet run — needs the round-budget driver |
| **Equal wall-clock** | What a latency-bound deployment actually cares about | Not yet run |

Reporting only the first would hide the batching effect; only the second would
compare different amounts of work and call it efficiency. Both must be reported, and
labelled.

### 4.1.1 A structural limit found while building this: sparse branching

A first candidate pool varied only *batching*, and every candidate scored identically
— the report now prints a `distinguishing` column so this cannot pass unnoticed. The
cause is structural, not a bug:

**In a recorded tree every node has at most one child**, because that is how the
online arm built it: one selection produces one attempt, which becomes one node. So
replaying different policies over one world mostly reveals **the same subtree**, and a
policy's choice of *which* node to select changes the order, not the content. On top
of that, `legalRoots()` is bounded by `branchCount`, so once the branches are open the
only remaining freedom is how much refining the budget buys.

The consequence is narrow but real: **with an equal attempt budget and this task's
branching, policies that differ only in ordering cannot be told apart by replay.** A
pool must differ in *where the budget goes* — how much deepening versus how much fresh
lineage — for the dreaming to have a choice. The pool now spans that axis, and the
report states per round whether it discriminated, so a reader can tell "the loop found
no improvement" from "the loop had nothing to choose between".

Recording *rejected* alternatives would widen the pool further, and is the natural
next step: a world with branch points is a world where ordering matters.

### 4.2 Why the candidate pool is hand-written, and what that leaves untested

That is the one thing this run does **not** exercise. The paper's proposer is an LLM
that rewrites policy *code*, and its candidate policies are programs the model
invented — so its headroom comes from ideas a human did not enumerate. Here the pool
is four hand-written strategies, so the selection step is tested and the invention
step is not. `dream()` takes any proposer, so wiring an LLM proposer is a bounded
piece of work, but until it is done the claim "Dream-RSI improves exploration" is
**not** established by this benchmark — only "the loop runs, scores, selects, and
improves monotonically".

## 4.3 The four-level ladder: what "everything works" has to mean

"The whole thing works" is four separate claims, each with its own experiment. They
are ordered because a higher level is uninterpretable if a lower one fails.

| Level | Claim | Experiment | Status |
|---|---|---|---|
| **L0 — mechanism** | The replay → evaluate → select → deploy loop runs and never regresses on recorded history | Two-arm equal-attempt A/B on a real task with an out-of-process evaluator | ✅ **Measured** (§4) |
| **L1 — overhead** | Mounting the plugins does not make a session more expensive | Same task through `dsh` headless with and without the plugins mounted; compare tokens and turns | ⬜ Designed (§5.5) |
| **L2 — routing** | A policy chosen by replay beats a hand-written fixed strategy at equal compute | The L0 A/B with a candidate pool that actually discriminates | ⏳ Running |
| **L3 — public** | `dsh` + plugins beats bare `dsh` on a public benchmark | Harbor: Terminal-Bench 4.0 / DeepSWE 1.1 / SWE-Atlas QnA, two profiles | ⬜ Blocked on Docker + a frontier key (§5) |

Two properties of this ladder matter more than the rows:

- **L0 passing is not evidence for L1–L3.** A loop can work and be worthless. The
  paper's own ablation is the warning: history-as-simulator beat history-as-guidance,
  but the *magnitude* was "2 of 3 tasks at or above baseline" and one task regressed.
- **L0 failing invalidates L2 and L3.** If the loop does not run, there is nothing to
  mount, and a public-benchmark difference would be someone else's variable.

### Why L1 is a real level and not a formality

The reference post's claim is explicitly "**without any negative performance
impact**". A plugin family that adds a projection fold, a judgment call and a
cost-priced rebuild path could easily cost more than it saves. L1 is the experiment
that answers "is mounting this free?" — and it is measurable today, unlike L2/L3.

## 5. How to answer the second question: RSI-Harness vs a bare harness

The comparison is **appending**, not modifying: RSI-Harness is a plugin family, so
"better than plain dsh" means *the same benchmark, the same budget, with the plugins
mounted*. The delta is the result.

### 5.1 The arms

| Arm | Composition | Why |
|---|---|---|
| `dsh-bare` | `dsh` with a stock profile | The baseline |
| `dsh-rsi` | the same profile plus `@neeboo/unreal-harness-rsi-trace` and `-rsi-context` | The treatment |
| `reference` | the published number for Codex / Pi | The context the reference post provides |

### 5.2 The metrics, taken from the reference post so the tables are comparable

Pass rate · total $ · input tokens per trial · output tokens per trial · turns per
trial · tool calls per trial. Plus two this repository needs and the post does not
report: **cached input tokens** (the design's cache-aware layer is only meaningful
if cache behaviour is visible) and **wall-clock**, since the asynchronous runtime the
post describes is a latency claim.

### 5.3 The blocker, stated precisely

Running these needs **Docker (or Modal)** for the task containers and an **OpenAI /
OpenRouter / Fireworks** key for `gpt-6-astra`, plus Harbor. On the machine this was
developed on: `docker info` fails (daemon not running) and no such key is present.
So the honest status is **designed, not run**.

### 5.4 The exact commands, ready to paste once the prerequisites exist

```sh
# Prerequisites: a running Docker daemon (or Modal credentials) and a provider key.
git clone https://github.com/unreallabsai/unreal-agent && cd unreal-agent
export OPENAI_API_KEY=...            # or OPENROUTER_API_KEY / FIREWORKS_AI_API_KEY
make -C benchmarks/harbor sync
make -C benchmarks/harbor build REVISION=HEAD

# Terminal-Bench 4.0 in a container, 5 attempts, 40 tasks
uv run --project benchmarks/harbor --locked harbor run \
  -d terminal-bench/terminal-bench@4.0.0 \
  -a harness_harbor.agent:UnrealAgent \
  -m openai/gpt-6-astra \
  --ak bundle="$PWD/bin/harbor/<short-commit>" --ak thinking_level=max \
  -k 5 -n 40 --job-name tb4-unreal-agent

harbor view jobs/tb4-unreal-agent
```

To measure the **RSI-Harness delta** the same way, the treatment arm is a `dsh`
profile with the plugins mounted in its `cordis.patch.yml`:

```yaml
- insert:
    - id: rsi-trace
      name: '@neeboo/unreal-harness-rsi-trace'
    - id: rsi-context
      name: '@neeboo/unreal-harness-rsi-context'
      config:
        provider: { name: heuristic }        # zero-cost structural judgments
        prices: { cacheMissPerMillion: 0.15, cacheHitPerMillion: 0.003 }
```

Then run both profiles over the same dataset and budget, and compare with the
dominance rule in `packages/bench/src/types.ts`.

### 5.5 The L1 experiment, which *is* runnable today

No Docker and no frontier key are needed for this one, so it should be run first: it
is the cheapest way to test the reference post's "no negative performance impact"
claim against this repository's own plugins.

```sh
# One task, the same model, two profiles: base and base + RSI plugins.
dsh --profile headless --patch ./profiles/base.yml --  "$TASK" > base.jsonl
dsh --profile headless --patch ./profiles/with-rsi.yml -- "$TASK" > rsi.jsonl
```

with `profiles/with-rsi.yml` inserting the two plugin rows (§5.4). Then compare, per
run: total tokens, cached input tokens, turns, tool calls, wall time, and whether the
task's own check passed. The result to look for is **equal pass, no worse cost** —
and because `deepseek-flash` reports cached prompt tokens per call, a regression in
cache behaviour would show up rather than hide inside an aggregate.

## 6. What this repository does **not** claim

Stated plainly, because a benchmark page that only lists wins is an advertisement:

- **No public-benchmark number is claimed.** No Terminal-Bench, DeepSWE, SWE-Atlas,
  or ALE-CLI run has been executed here. §5 is a design, not a result.
- **No "better than dsh" claim.** The plugin layer is built and tested; the A/B that
  would establish the delta has not been run.
- **"Dream-RSI works" is bounded** to what §4 measured: the loop, the replay
  scoring, the monotone selection, and the deployment. The invention step — an LLM
  proposer writing new policy code — is not exercised.
- **Absolute numbers from §4 mean nothing on their own.** They are properties of a
  rolling-maximum task with a `node` evaluator. Only the *comparison between arms*
  is informative, and only because the arms are identical in every other respect.
- **The mock/deterministic rig is not evidence.** `packages/bench/src/task-synthetic.ts`
  exists to smoke-test the machinery without credentials. No quality number in this
  document comes from it.

## 7. Next steps, in the order that makes each one meaningful

1. **Wire an LLM proposer** into `dream()` — the only way to test the paper's actual
   claim. Bounded: the seam exists, and the replay evaluation it needs is built.
2. **Add the round-budgeted arm** so the parallelism effect is measured, not argued.
3. **Run the Harbor comparison** once a container runtime and a frontier key are
   available. The commands are in §5.4.
4. **Add a cache-hit metric** to the report. DeepSeek reports cached prompt tokens
   per call (observed on `deepseek-flash`), so the design's cache-aware layer can be
   evaluated against real billing rather than a model of it.
