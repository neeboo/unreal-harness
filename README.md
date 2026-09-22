# Unreal Harness — RSI-Harness

Recursive self-improvement for coding agents, built as an **out-of-tree
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin family**.

> An agent must dream to recursively self-improve. History is the world it dreams in.

## What this is

RSI-Harness turns a coding agent's session log into an **explorable world**. Every
attempt the agent made is a node; every re-attempt from an earlier attempt is a
fork. Because each node's outcome was already recorded, a *different* strategy for
allocating exploration effort can be evaluated by **replaying** the tree — with no
model calls and no execution at all.

That is the whole idea: **a completed run is not just a transcript, it is a
simulator.**

Three commitments shape the implementation:

- **The tree is derived, never authoritative.** It is a projection of the
  append-only session log, so a lost index is a cache miss, not data loss.
- **Replay is prefix-only.** A policy observes only what its own decisions have
  revealed, which is what makes an offline score a valid prediction of an online run.
- **No storage is invented.** `dsh` already records everything; this repository adds
  vocabulary, a fold, and a deterministic engine.

## Repository layout

| Path | What it is |
|---|---|
| `packages/rsi-trace/` | The plugin: `rsi/node` event, `rsi/discoveryTree` projection, `ctx.rsiTrace` reader, replay engine |
| `RSI-HARNESS.md` | The full design study — five axes, integration matrix, risks, roadmap |
| `PHASE0-VERIFICATION.md` | The four load-bearing assumptions, each verified against `dsh` source with a runnable test |
| `verification/` | The verification specs and fixtures, kept as evidence |
| `packages/rsi-trace/README.md` | Package reference: API, semantics, limitations |

## The five axes

The design integrates five independent things, and their relative position is
organised by **time**:

| Axis | Position | Role |
|---|---|---|
| **dsh** | runtime | the host — session log, seams, tools, sandbox, UI |
| **unreal-agent** | design-time | the type discipline: a pure translator with no I/O, serializable versioned operations |
| **Dream-RSI** | **post-hoc** | the algorithm: history as a replay simulator, offline policy improvement |
| **TypeSafe / Jev** | **inline** | typed judgment primitives (`Choice`/`Score`/`Noul`) for scoring and routing |
| **the design doc** | design-time | the requirement backlog: meta-attention, routing, background read-only work |

See [`RSI-HARNESS.md`](RSI-HARNESS.md) for why each is where it is, and which
claims did **not** survive scrutiny.

## Quick start

```ts
import { IMPLICIT_ROOT, replay, replayScore, replayWorldFromTree } from '@neeboo/unreal-harness-rsi-trace'

// A recorded run: the host session's marker plus one marker per attempt.
const nodes = ctx.rsiTrace.nodes(session)

// Replay evaluates a POLICY, not the task.
const world = replayWorldFromTree(hostSessionId, nodes)
const result = replay(world, question => {
  // Open every branch that is still untouched…
  if (question.legalRoots().length > 0) return [IMPLICIT_ROOT]
  // …then deepen one attempt per round.
  const legal = question.legalActions()
  return legal.length === 0 ? [] : [legal[0]!]
})

result.bestScore             // best recorded score in the revealed subtree
result.revealedNodeCount     // the trajectory's cost proxy
result.roundCount            // decision rounds taken
replayScore(result, { cost: 0.1, parallelism: 0.2 })
```

Mounting it into a `dsh` profile:

```yaml
# In your profile's cordis.patch.yml
- insert:
    - id: rsi-trace
      name: '@neeboo/unreal-harness-rsi-trace'
```

## Status

**Implemented and verified.** Phase 0's four load-bearing assumptions were each
tested against the real `dsh` runtime, and Phase 1's replay engine is complete and
accepted:

| Claim | Evidence |
|---|---|
| Per-session state needs no per-session service | `verification/v1-preset-isolation.spec.ts` (2/2) |
| The tree folds out of the log and rebuilds from it | `verification/v2-tree-projection.spec.ts` (2/2) |
| A request is reconstructable from the log | `verification/v3-request-reconstruction.spec.ts` (3/3) |
| Any recorded ancestor can be forked | `verification/v4-fork-arbitrary-node.spec.ts` (2/2) |
| Replay reproduces the online trajectory, and discriminates | `packages/rsi-trace/tests/replay-fidelity.spec.ts` |

**Not yet built:** workspace snapshots (the one thing with no `dsh` home, and the
prerequisite for re-running a node rather than only reasoning about it), and wet
forks. Both are scoped in [`RSI-HARNESS.md`](RSI-HARNESS.md) §4.3 and §5.5.

## Running the tests

The package is a `dsh` plugin, so its tests run inside a `dsh` checkout where the
workspace dependencies resolve:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness
cd deepseek-harness
pnpm install
cp -R /path/to/unreal-harness/packages/rsi-trace packages/rsi/rsi-trace
# add the tsconfig paths entry and host project reference, then:
pnpm exec vitest run packages/rsi/rsi-trace
```

`PHASE0-VERIFICATION.md` documents the exact wiring, including the four
declaration-merge and project-reference details that a first-time port gets wrong.

## Credits and prior art

This work stands on three external projects and one document, none of them ours:

- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** — the host. Everything here is a plugin beside it; no `dsh` source is modified.
- **[Dream-RSI](https://github.com/zhengkid/Dream-RSI)** — the algorithm (arXiv:2609.14858). This repository is an independent implementation of its replay-simulator idea; the paper ships no code.
- **[unreal-agent](https://github.com/unreallabsai/unreal-agent)** — the type discipline that made us take "no I/O in the translator" seriously as a *type* rather than a comment.
- **[TypeSafe / Jev](https://docs.typesafe.ai/introduction)** — typed judgment primitives, the natural home for the scoring and routing decisions this design needs.

Nothing from those projects is vendored or copied; see
[`RSI-HARNESS.md`](RSI-HARNESS.md) for a per-project account of what is reusable
and what is not.

## License

MIT — see [`LICENSE`](LICENSE).
