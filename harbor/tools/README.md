# The Harbor side of the benchmark

Everything here is a plain script or a generated artifact. Nothing is hand-edited
after a run, which is the property that makes the report verifiable.

## Where the adapter lives

Harbor resolves an agent from `AgentConfig.import_path`, so the adapter attaches
without patching Harbor's tree:

```
<unreal-agent>/benchmarks/harbor/src/harness_harbor/dsh_agent.py
<unreal-agent>/benchmarks/harbor/tests/test_dsh_agent.py
```

The copy this repository versions lives in `../adapter/`, and
`../adapter/README.md` has the install steps. It is copied into the Harbor project
rather than imported from here, because Harbor resolves the agent as
`harness_harbor.dsh_agent:Dsh` and a benchmark should not depend on the repository
it is measuring.

```sh
cp ../adapter/harness_harbor/dsh_agent.py \
   <unreal-agent>/benchmarks/harbor/src/harness_harbor/
cp ../adapter/tests/test_dsh_agent.py \
   <unreal-agent>/benchmarks/harbor/tests/
cd <unreal-agent>/benchmarks/harbor && uv sync --locked --all-extras
.venv/bin/python -m unittest tests.test_dsh_agent      # 38 tests
```

Two agent classes are registered:

| Import path | What it is |
|---|---|
| `harness_harbor.dsh_agent:Dsh` | bare `dsh`, booted from the shipped `headless` profile |
| `harness_harbor.dsh_agent:DshRsi` | the same, plus the RSI plugin set |

They differ by exactly one field, `RSI_BUNDLES`, which is what makes an A/B
meaningful: a difference in outcome cannot be attributed to configuration drift
because there is none.

## Running the arms

```sh
export DEEPSEEK_API_KEY=...
TASKS_ROOT=/path/to/terminal-bench \\
  ./run-arm.sh Dsh    /tmp/trials /tmp/results
TASKS_ROOT=/path/to/terminal-bench \\
  ./run-arm.sh DshRsi /tmp/trials /tmp/results /path/to/rsi-trace.tgz
```

The RSI plugin is not on the public npm registry, so the treatment arm needs a
tarball. `dsh-plugins/BUILD.md` in this repository is the recipe; `rsi_plugin`
accepts either that path or a published package name.

The runner refuses to start inside a DeepSeek peak-pricing window, because peak
rates are exactly double off-peak and a batch that straddles the boundary would
produce costs differing by 2× for reasons unrelated to the agent.

## Making the matrix finishable: pre-bake the toolchain

**This is the difference between a pilot and a benchmark.** Each trial would
otherwise download Node and `npm install` the harness into a fresh task image —
roughly four minutes before the agent gets a single turn, against a per-task agent
budget measured in minutes. Nothing about the measurement is wrong; it simply
never finishes.

```sh
TASKS_ROOT=/path/to/terminal-bench \
TASKS="html-js-filter session-window-debug shadow-relay" \
  ./prebake-toolchain.sh
```

That builds one `dsh-toolchain:<node version>` image holding Node, dsh and pnpm,
then grafts a `COPY --from` stage into each task's `environment/Dockerfile`. The
adapter notices `/opt/dsh-toolchain` and copies from it instead of downloading
(`Dsh.PREBAKED_TOOLCHAIN`). Measured effect: setup drops from ~4 minutes to under
a minute, and the trial transcript contains no download at all.

`--restore` puts every modified file back; `Dockerfile.orig` and `task.toml.orig`
are kept beside each one.

### The trap this had to clear first

Most Terminal-Bench tasks set `[environment] docker_image`, which makes Harbor
pull a registry image and **never read `environment/Dockerfile`**. A grafted
Dockerfile is then dead text. Worse, the failure is invisible in the transcript:
the adapter's own script text contains the string `using pre-baked dsh from
$PREBAKED`, so a `grep` for "pre-baked" matches the *source* of the check rather
than its result. The first attempt at this pre-bake reported success while still
downloading 514 packages.

`prebake-toolchain.sh` therefore also comments out `docker_image` in the task's
`[environment]` section, forcing a local build — ~30s against ~4min of per-trial
installing. The `[verifier.environment] docker_image` is deliberately left alone:
the verifier is the task's grading logic and must not be perturbed.

Verify the fast path actually engaged by looking for an absolute path and the
absence of downloads:

```sh
grep -o "using pre-baked dsh from /opt[a-z/-]*" <trial>/trial.log   # must match /opt/...
grep -cE "downloading https://nodejs|added [0-9]+ packages" <trial>/trial.log   # must be 0
```

## Producing the page

```sh
./extract-results.py      /tmp/results --out harbor-summary.json
python3 ../packages/policy/... # see the package script for the replay summary
python3 build-report.py \\
  --propose-summary propose-summary.json \\
  --replay-summary  replay-summary.json \\
  --loop-summary    ../../bench-out/main-low2/measurements.json \\
  --harbor-summary  harbor-summary.json \\
  --out ../../BENCHMARK-REPORT.html
```

## The cost model, and why it is not Harbor's field

`pricing.py` prices token counts from the published rate card, including the
peak/off-peak split. Harbor's own `cost_usd` is empty for an import-path agent —
it has no rate card for one — so leaving that field to Harbor would have put a
hole in the report's central number.

The two input buckets are priced separately on purpose: a cache hit is $0.003/Mtok
against $0.15/Mtok for a miss off-peak, a 50× spread. A single blended input rate
would misreport any cache-heavy run by up to that factor.

## The three failures worth remembering

Each of these failed **silently** — exit 0, no output — and would have been
recorded as a task the agent simply could not solve. They are documented at
length in `BENCHMARK.md` §5.4 and guarded in the adapter:

1. **Node < 22.18.0.** `dsh`'s entrypoint is guarded by
   `if (import.meta.main) await runCli()`, and `import.meta.main` does not exist
   before 22.18.0 / 24.2.0. dsh then exits 0 having printed nothing. The adapter
   pins 22.23.2 and probes for version output during install.
2. **The global `dsh` shim's shebang.** `#!/usr/bin/env node` fails unless the
   Node *bin directory* is itself on `PATH`. The adapter invokes `node` and the
   entrypoint by absolute path.
3. **An empty transcript scored as a failed task.** `_assert_harness_booted`
   refuses to score a trial that produced no events, and reports the container's
   stderr. In a two-arm comparison a silently dead arm reads as the *other* arm
   winning, which is the most expensive mistake this harness could make.
