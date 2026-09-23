/**
 * Does the replay mechanism actually discriminate between strategies?
 *
 * # What was broken, and what this measures
 *
 * This repository's own two-arm benchmark found its candidate pool *degenerate*:
 * four hand-written policies scored identically in every round, so selection had
 * nothing to select between. The diagnosis is in `BENCHMARK.md` §4.0.1 and is
 * structural rather than a bug: a single recorded tree has at most one child per
 * node, so reordering reveals changes *when* a node appears, not *which* nodes
 * are reachable. On one tree, "open branches first" and "deepen first" converge.
 *
 * The consequence is that one recorded run cannot tell you whether the mechanism
 * works. This suite therefore measures the mechanism against **many** recorded
 * trees from the explicit generative model in `synthetic.ts`, and it reports the
 * two quantities that decide whether a dreaming loop is worth running at all:
 *
 * 1. **Coverage** — how often a policy attains the best score present in the tree.
 * 2. **Regret** — how far short of that best score it falls when it does not.
 *
 * A candidate set is useful only if its members differ on those. It is *safe*
 * only if the incumbent is retained whenever nothing better is found, which is
 * the monotonicity the paper promises and `dream()` implements.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'

import { bestEvaluation, evaluatePolicy } from '../src/dream.ts'
import { replayScore, runPolicy } from '../src/replay.ts'
import type { ReplayWorld } from '../src/replay.ts'
import { POOL as EXPERIMENT_POOL, depthPolicy, statFor as experimentStatFor } from '../src/replay-experiment.ts'
import { makeRandom, syntheticCorpus } from '../src/synthetic.ts'
import type { ExplorationPolicy, PrefixQuestion } from '../src/types.ts'

const BETA = { cost: 0.05, parallelism: 0.1 } as const

/**
 * A *binding* replay budget, and the reason it must bind.
 *
 * Replay is only a decision problem when the budget binds. With unlimited
 * rounds every policy eventually reveals every recorded node, so they all find
 * the same best score and the pool collapses to one distinct outcome — the very
 * degeneracy `BENCHMARK.md` §4.0.1 reported for a single recorded tree. The
 * regime worth measuring is the one a real deployment is in: not enough rounds
 * to see everything, so allocation is the only thing that matters.
 *
 * The shape below was chosen by sweeping branch count x refinement depth x round
 * limit and keeping a cell where the pool neither saturates (every policy at
 * 100% coverage, so the choice is vacuous) nor starves (every policy near 0%,
 * which measures luck rather than allocation). At 3 refinements over 4 branches
 * and 8 rounds the pool spans roughly 15%-97% coverage with all five members
 * distinct, which is the informative band.
 */
const REPLAY = { maxParallelism: 4, roundLimit: 8 } as const

/** The pool under test. Defined once, in the module the report also reads. */
const POOL = EXPERIMENT_POOL

/** The baseline the dreaming loop must never regress against. */
const incumbent = POOL[0]!

/** Score one policy over a corpus, via the shared experiment implementation. */
function statFor(
  worlds: readonly ReplayWorld[],
  policy: ExplorationPolicy,
  replay: { readonly maxParallelism: number; readonly roundLimit?: number } = REPLAY,
) {
  const stat = experimentStatFor(worlds, policy, replay)
  return {
    policyId: stat.policy,
    meanScore: stat.mean_score,
    coverage: stat.coverage,
    meanRegret: stat.mean_regret,
  }
}

describe('synthetic world generator', () => {
  it('produces a replayable tree', () => {
    const { worlds } = syntheticCorpus(1, 1, { branchCount: 6, refinementDepth: 5 })
    const world = worlds[0]
    expect(world).toBeDefined()
    expect(world!.size).toBeGreaterThan(0)
    // Constructing a ReplayWorld already rejects a node with two recorded
    // children, so reaching here means the generator produced a legal tree.
    expect(world!.bestScore).toBeDefined()
  })

  it('is deterministic for a given seed', () => {
    const a = syntheticCorpus(3, 100, { branchCount: 4, refinementDepth: 4 })
    const b = syntheticCorpus(3, 100, { branchCount: 4, refinementDepth: 4 })
    expect(a.seeds).toEqual(b.seeds)
    expect(a.bestRecordedScores).toEqual(b.bestRecordedScores)
  })

  it('produces different trees for different seeds', () => {
    const a = syntheticCorpus(1, 1, { branchCount: 6 })
    const b = syntheticCorpus(1, 2, { branchCount: 6 })
    expect(a.bestRecordedScores).not.toEqual(b.bestRecordedScores)
  })

  it('generates exactly the requested number of branches', () => {
    const generated = syntheticCorpus(1, 7, { branchCount: 9, refinementDepth: 3 })
    expect(generated.worlds[0]?.rootIds).toHaveLength(9)
  })

  it('respects the refinement depth bound', () => {
    const generated = syntheticCorpus(4, 11, { branchCount: 3, refinementDepth: 4 })
    for (const world of generated.worlds) {
      expect(world.size).toBeLessThanOrEqual(3 * 5)
      expect(world.size).toBeGreaterThanOrEqual(3)
    }
  })

  it('keeps the prng in the unit interval', () => {
    const random = makeRandom(42)
    for (let i = 0; i < 1000; i += 1) {
      const value = random()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})

describe('replay discriminates between strategies on many worlds', () => {
  /**
   * Separate corpora, because selection is a *fitted* rule: choosing the best
   * policy on worlds W and then reporting its score on those same worlds would
   * measure the fit, not the mechanism.
   */
  const shape = { branchCount: 4, refinementDepth: 3 }
  const train = syntheticCorpus(120, 1_000, shape)
  const test = syntheticCorpus(120, 9_000, shape)

  const evaluate = (worlds: readonly ReplayWorld[], policy: ExplorationPolicy) =>
    evaluatePolicy(worlds, policy, BETA, REPLAY)

  it('keeps the pool non-degenerate', () => {
    const stats = POOL.map(policy => statFor(test.worlds, policy))
    const distinctScores = new Set(stats.map(stat => stat.meanScore?.toFixed(9)))
    const distinctCoverage = new Set(stats.map(stat => stat.coverage.toFixed(9)))
    // This is precisely the property the single-tree benchmark could not
    // establish, and the reason its pool collapsed to one distinct outcome.
    expect(distinctScores.size).toBeGreaterThan(1)
    expect(distinctCoverage.size).toBeGreaterThan(1)
  })

  it('keeps every policy operable on every world', () => {
    for (const policy of POOL) {
      for (const world of test.worlds.slice(0, 12)) {
        const run = runPolicy(world, policy, REPLAY)
        // Stopping at the round limit is the expected outcome under a binding
        // budget, so it is not a failure. What would invalidate the comparison
        // is a policy that stops *without revealing anything* — an empty batch
        // — because then it never entered the trade-off being measured.
        expect(run.stopReason).not.toBe('empty-batch')
        expect(run.revealedNodeCount).toBeGreaterThan(0)
      }
    }
  })

  it('reaches the recorded ceiling when the budget is not binding', () => {
    // The complement of the binding-budget table: given enough rounds the
    // allocation question disappears and every policy finds the best recorded
    // score. Reporting both is what shows the first table measures allocation
    // rather than a defect in some policy.
    for (const policy of POOL) {
      const stat = statFor(test.worlds, policy, { maxParallelism: 4 })
      expect(stat.coverage).toBe(1)
    }
  })

  it('reports coverage and regret for the whole pool', () => {
    const rows = POOL.map(policy => statFor(test.worlds, policy))
    const lines = rows.map(
      row =>
        `${row.policyId.padEnd(11)} coverage=${(row.coverage * 100).toFixed(1)}% ` +
        `meanReplayScore=${row.meanScore?.toFixed(3)} ` +
        `meanRegret=${row.meanRegret.toFixed(3)}`,
    )
    // Printed so the numbers appear in test output, not only in assertions.
    console.log(`\nsynthetic replay over ${test.worlds.length} held-out worlds`)
    console.log(lines.join('\n'))
    expect(rows).toHaveLength(POOL.length)
    for (const row of rows) expect(row.meanScore).toBeDefined()
  })

  it('never regresses against the incumbent on the history it selected from', () => {
    const evaluations = POOL.map(policy => evaluate(train.worlds, policy))
    const chosen = bestEvaluation(evaluations)
    const incumbentEvaluation = evaluations.find(e => e.policyId === 'depth-100')
    expect(chosen).toBeDefined()
    expect(incumbentEvaluation).toBeDefined()
    // This is the loop's actual guarantee. Unlike transfer, it must hold.
    expect(chosen!.meanScore).toBeGreaterThanOrEqual(incumbentEvaluation!.meanScore!)
  })

  it('reports whether the fitted choice transfers to unseen worlds', () => {
    const evaluations = POOL.map(policy => evaluate(train.worlds, policy))
    const selected = bestEvaluation(evaluations)
    expect(selected).toBeDefined()

    const heldOut = POOL.map(policy => statFor(test.worlds, policy))
    const chosen = heldOut.find(row => row.policyId === selected!.policyId)
    const base = heldOut.find(row => row.policyId === 'depth-100')
    expect(chosen).toBeDefined()
    expect(base).toBeDefined()

    const transferred =
      chosen!.coverage >= base!.coverage && chosen!.meanRegret <= base!.meanRegret

    console.log(
      `\nselected on training worlds: ${selected!.policyId}\n` +
        `  held-out coverage ${(chosen!.coverage * 100).toFixed(1)}% ` +
        `vs incumbent ${(base!.coverage * 100).toFixed(1)}%\n` +
        `  held-out regret   ${chosen!.meanRegret.toFixed(3)} ` +
        `vs incumbent ${base!.meanRegret.toFixed(3)}\n` +
        `  transferred: ${transferred}`,
    )

    // The finding is reported, not asserted in a fixed direction: an experiment
    // that can only pass by confirming its hypothesis is not an experiment.
    expect(typeof transferred).toBe('boolean')
  })
})
