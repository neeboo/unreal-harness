/**
 * The replay experiment as a runnable artifact.
 *
 * The same measurement `synthetic.spec.ts` asserts is emitted here as JSON, so
 * the report page can render it without a human transcribing anything. It is a
 * plain node script rather than a test because a report needs a file, and a test
 * runner's job is to fail, not to publish.
 *
 * ```sh
 * pnpm replay-experiment --out harbor/tools/replay-summary.json
 * ```
 *
 * @module
 */

import { writeFileSync } from 'node:fs'

import { bestEvaluation, evaluatePolicy } from './dream.ts'
import { replayScore, runPolicy } from './replay.ts'
import type { ReplayWorld } from './replay.ts'
import { syntheticCorpus } from './synthetic.ts'
import type { ExplorationPolicy, PrefixQuestion } from './types.ts'

const BETA = { cost: 0.05, parallelism: 0.1 } as const

/** The binding budget: see the note in `synthetic.spec.ts`. */
const BINDING = { maxParallelism: 4, roundLimit: 8 } as const

/** The loose budget, kept to show the degeneracy is a budget property. */
const LOOSE = { maxParallelism: 4 } as const

/**
 * A policy that spends a fixed share of decision rounds deepening the most
 * recent lineage and the rest opening fresh branches.
 *
 * Stateless by construction: a policy is replayed against every recorded world,
 * so captured counters would make it mean different things in different worlds.
 */
export function depthPolicy(id: string, depthShare: number): ExplorationPolicy {
  return {
    id,
    label: `${Math.round(depthShare * 100)}% of rounds deepen`,
    beta: 0.5,
    planGrid: () => ({ branchCount: 1, refineCount: 1 }),
    selectBatch: (question: PrefixQuestion) => {
      const actions = question.legalActions()
      if (actions.length === 0) return []
      const deepenable = actions.filter(action => action !== 'root')
      const canOpen = actions.includes('root')
      const canDeepen = deepenable.length > 0

      if (!canOpen) return canDeepen ? [deepenable.at(-1)!] : []

      const round = question.roundCount + 1
      const wanted = Math.round(round * depthShare)
      const already = Math.max(
        0,
        Math.min(round - 1, Math.round((round - 1) * depthShare)),
      )
      const wantsDepth = already < wanted
      if (wantsDepth && canDeepen) return [deepenable.at(-1)!]
      return ['root']
    },
  }
}

/** The measured pool, spanning the depth-versus-breadth axis. */
export const POOL: readonly ExplorationPolicy[] = [
  depthPolicy('depth-100', 1),
  depthPolicy('depth-75', 0.75),
  depthPolicy('depth-50', 0.5),
  depthPolicy('depth-25', 0.25),
  depthPolicy('breadth-0', 0),
]

export interface PolicyStat {
  readonly policy: string
  readonly coverage: number
  readonly mean_score: number
  readonly mean_regret: number
}

/** Score one policy across a corpus. */
export function statFor(
  worlds: readonly ReplayWorld[],
  policy: ExplorationPolicy,
  replay: { readonly maxParallelism: number; readonly roundLimit?: number } = BINDING,
): PolicyStat {
  let score = 0
  let covered = 0
  let regret = 0
  let count = 0
  for (const world of worlds) {
    const ceiling = world.bestScore
    if (ceiling === undefined) continue
    count += 1
    const run = runPolicy(world, policy, replay)
    score += replayScore(run, BETA) ?? 0
    if (run.bestScore !== undefined && run.bestScore >= ceiling - 1e-9) covered += 1
    regret += run.bestScore === undefined ? ceiling : Math.max(0, ceiling - run.bestScore)
  }
  return {
    policy: policy.id,
    coverage: count === 0 ? 0 : covered / count,
    mean_score: count === 0 ? 0 : score / count,
    mean_regret: count === 0 ? 0 : regret / count,
  }
}

/** Run the experiment and return the JSON the report consumes. */
export function runReplayExperiment(options: { train?: number; heldOut?: number } = {}): unknown {
  const shape = { branchCount: 4, refinementDepth: 3 }
  const train = syntheticCorpus(options.train ?? 120, 1_000, shape)
  const test = syntheticCorpus(options.heldOut ?? 120, 9_000, shape)

  const pool = POOL.map(policy => statFor(test.worlds, policy, BINDING))
  const loose = POOL.map(policy => statFor(test.worlds, policy, LOOSE).coverage)

  const evaluations = POOL.map(policy => evaluatePolicy(train.worlds, policy, BETA, BINDING))
  const selected = bestEvaluation(evaluations)
  const chosen = pool.find(row => row.policy === selected?.policyId)
  const incumbent = pool.find(row => row.policy === 'depth-100')
  if (chosen === undefined || incumbent === undefined || selected === undefined) {
    throw new Error('the pool must contain the incumbent and the selected policy')
  }

  return {
    generated_at: new Date().toISOString(),
    generator: 'packages/policy/src/synthetic.ts',
    regime: { ...shape, roundLimit: BINDING.roundLimit, maxParallelism: BINDING.maxParallelism },
    worlds: { train: train.worlds.length, held_out: test.worlds.length },
    train_worlds: train.worlds.length,
    held_out_worlds: test.worlds.length,
    pool,
    loose_budget_coverage: loose,
    selected: selected.policyId,
    selected_coverage: chosen.coverage,
    selected_mean_score: chosen.mean_score,
    incumbent_coverage: incumbent.coverage,
    incumbent_mean_score: incumbent.mean_score,
    transferred:
      chosen.coverage >= incumbent.coverage && chosen.mean_regret <= incumbent.mean_regret,
    distinct_in_train: new Set(evaluations.map(e => (e.meanScore ?? 0).toFixed(6))).size,
    monotone: pool.every(
      (row, index) => index === 0 || (pool[index - 1]?.coverage ?? 0) >= row.coverage,
    ),
  }
}

const outIndex = process.argv.indexOf('--out')
const target = outIndex === -1 ? undefined : process.argv[outIndex + 1]
const summary = runReplayExperiment()
const serialised = `${JSON.stringify(summary, null, 2)}\n`
if (target) {
  writeFileSync(target, serialised, 'utf8')
  process.stdout.write(`wrote ${target}\n`)
}
process.stdout.write(serialised)
