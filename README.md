# Unreal Harness — RSI-Harness

Recursive self-improvement for coding agents: a **five-layer** monorepo, mixing
Rust and TypeScript, built as an out-of-tree
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin
family.

> An agent must dream to recursively self-improve. History is the world it dreams in.

## The idea in one paragraph

A coding agent's session log records every attempt it made and what happened. That
makes the log more than a transcript: it is a **simulator**. A *different* strategy
for allocating exploration effort can be scored by walking the recorded tree —
no model call, no attempt, no evaluator — because every outcome is already there.
RSI-Harness is the machinery that turns that observation into an improvable loop.

## Repository layout

Two build systems, one repository, and the split is deliberate.

| Path | Ecosystem | What it is |
|---|---|---|
| `crates/core/` | **Rust** | The decision types: a translator that cannot do I/O, durable versioned operations, a context build that accounts for every reduction |
| `packages/rsi-trace/` | **TypeScript** | The dsh plugin: `rsi/node` event, `rsi/discoveryTree` projection, `ctx.rsiTrace`, and the replay engine |
| `packages/judgment/` | TypeScript | Typed cheap judgments: a zero-cost structural provider, a TypeSafe Jev adapter, chunk scoring, cache-aware pricing, a capability catalogue |
| `packages/policy/` | TypeScript | The dreaming loop: replay-scored policy improvement, β sweeps, a versioned policy store |
| `packages/workspace/` | TypeScript | Per-node workspace snapshots: hard-linked forks with a copy-on-write boundary |
| `RSI-HARNESS.md` | — | The design study: five axes, integration matrix, risks, and the claims that did *not* survive scrutiny |
| `PHASE0-VERIFICATION.md` | — | Four load-bearing assumptions, each verified against the real `dsh` runtime, with the port details a first-time integrator gets wrong |
| `verification/` | — | The verification specs, kept as evidence |

## Status: what is built, layer by layer

Honest accounting, because "all five layers" means different things at different
depths. Every row marked ✅ has tests that run today.

### L1 — State discipline · **✅ complete** · `crates/core` · 16 unit + 2 doc tests

| Component | State |
|---|---|
| `Translator` that cannot name an I/O capability | ✅ |
| `Operation`: versioned, serialisable, inert; unknown version refused | ✅ |
| `Submit`: the only capability a translator receives | ✅ |
| `Manager`: at-most-once acceptance per identity | ✅ |
| `context::Builder` with a typed `Report` of every omission/truncation/demotion | ✅ |

### L2 — Host · **✅ not ours** · `dsh` itself

Sessions, tools, sandbox, approval, MCP, skills, jobs, UI. RSI-Harness mounts
beside it and modifies none of it.

### L3 — Context policy · **✅ core complete, dsh wiring pending**

| Component | State |
|---|---|
| `JudgmentProvider` seam (typed questions, per-question failure, batched) | ✅ |
| `HeuristicJudgmentProvider` — zero model cost, refuses what it cannot judge | ✅ |
| `JevProvider` — TypeSafe Jev, injectable transport, pinned model id | ✅ |
| `ChunkScorer` — four tiers with a confidence gate and an escalation path | ✅ |
| `cache.ts` — cache-break pricing, `breakEvenReuses` | ✅ |
| `CapabilityCatalogue` — cheap listing, schemas released on match | ✅ |
| A `dsh` plugin registering a custom `CompactionEngine` | ⬜ **not built** — the pure decisions are done; the host adapter is not |
| `ConditionalPrompt` + compaction-immune pinning | ⬜ **not built** |
| Router policy (cost/sensitivity aware) | ⬜ **not built** — the judgment layer it needs is done |

### L4 — World model · **✅ read path complete, execution path partial**

| Component | State |
|---|---|
| Discovery-tree projection folded from the log, rebuildable | ✅ `packages/rsi-trace` |
| `ReplayWorld` + `PrefixQuestion` + `replay` + `replayScore` | ✅ `packages/rsi-trace` |
| Replay fidelity: reproduces an online trajectory *and* discriminates | ✅ verified against a real session |
| Deterministic replay engine (duplicate of the above, standalone) | ✅ `packages/policy` |
| Per-node workspace snapshots, hard-linked, CoW boundary, tree-level GC | ✅ `packages/workspace` |
| **Wet fork** — actually re-running a node rather than reasoning about it | ⬜ **not built** — this is the honest gap. Dry replay is done; the paired-fork executor is not |

### L5 — Meta-policy · **✅ core complete**

| Component | State |
|---|---|
| `runPolicy` + the prefix-only environment | ✅ |
| `dream()` — M×t replay scoring over a fixed history, best-of selection | ✅ |
| Bounded monotonicity, reported rather than assumed | ✅ |
| `sweepBeta` + `sweepIsInformative` (a flat sweep is reported as degenerate) | ✅ |
| `PolicyStore` — append-only versions, separate deployed pointer, snapshot/restore | ✅ |
| `clampGrid` — a model-authored plan cannot be trusted with deployment arithmetic | ✅ |
| Executing a model-authored policy in a sandbox | ⬜ **not built** — `propose` is the seam; it takes any function, and wiring a code-writing proposer is deployment work |

## Quick start

### The Rust core

```sh
cargo test -p unreal-harness-core
```

The interesting part is what the types refuse. A translator receives `Submit` and
nothing else, so performing I/O is not forbidden — it is unnameable.

### The TypeScript packages

```sh
pnpm install
pnpm test        # 105 tests across judgment, policy, workspace
pnpm typecheck
```

`packages/rsi-trace` is a `dsh` plugin whose tests mount real `dsh` services, so
they run inside a `dsh` checkout — see `PHASE0-VERIFICATION.md` for the exact
wiring, including the four declaration-merge and project-reference details a
first-time port gets wrong.

### Replaying a recorded run

```ts
import { IMPLICIT_ROOT, replay, replayWorldFromTree } from '@neeboo/unreal-harness-rsi-trace'

const world = replayWorldFromTree(hostSessionId, ctx.rsiTrace.nodes(session))
const result = replay(world, question => {
  if (question.legalRoots().length > 0) return [IMPLICIT_ROOT]
  const legal = question.legalActions()
  return legal.length === 0 ? [] : [legal[0]!]
})

result.bestScore           // best recorded score in the revealed subtree
result.revealedNodeCount   // the trajectory's cost proxy
```

### Dreaming over a history

```ts
import { ReplayWorld, dream } from '@neeboo/unreal-harness-policy'

const outcome = await dream(worlds, incumbent, {
  revisions: 3,
  beta: { cost: 0.1, parallelism: 0.2 },
  propose: async ({ bestScore, triedIds }) => nextCandidate(bestScore, triedIds),
})

outcome.selected   // never worse than `incumbent` ON THIS HISTORY
outcome.monotone   // whether that comparison was even possible
```

## Two claims and their limits

**Monotonicity is bounded.** Because the candidate set includes the incumbent, the
selected policy is never worse than it *on the recorded history*. That is a real
guarantee and a narrow one: replay traverses outcomes that already happened, so a
better offline score does not promise a better live run. The loop raises the floor,
not the ceiling. `packages/policy` reports whether the comparison was even
possible, because an unscored incumbent makes the claim empty.

**Hiding context is not free.** A downgrade replaces a surface range, which
invalidates the cached prefix from that point — so the saving is tokens *not sent*
and the cost is tokens *re-prefilled*. Under a 50× miss-to-hit price gap, saving
9k against a 110k cached prefix needs **612 reuses** to pay for itself. The
dominant real benefit is the free case: reducing content *after* the cached prefix
invalidates nothing. `packages/judgment/src/cache.ts` computes this rather than
assuming it, which is why a scorer cannot quietly make the bill worse.

## Where the design came from

This work stands on three external projects and one document, none of them ours.
Nothing is vendored or copied.

- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** — the host. Everything here is a plugin beside it.
- **[Dream-RSI](https://github.com/zhengkid/Dream-RSI)** (arXiv:2609.14858) — the algorithm: history as a replay simulator. The paper ships no code, so `packages/policy` is an independent implementation of its idea, including the parts the paper leaves unspecified.
- **[unreal-agent](https://github.com/unreallabsai/unreal-agent)** — the type discipline that made "no I/O in the translator" worth taking seriously as a *type* rather than a comment.
- **[TypeSafe / Jev](https://docs.typesafe.ai/introduction)** — typed judgment primitives, the natural home for the scoring and routing decisions the design needs.

`RSI-HARNESS.md` records, per project, what is reusable and what is not — including
the claims of ours that did not survive contact with the source.

## License

MIT — see [`LICENSE`](LICENSE).
