/**
 * The benchmark CLI: run the A/B, print a report, and write the measurements to
 * disk.
 *
 * Everything a report prints comes from here, and everything here comes from a
 * real run: real DeepSeek calls, real generated code, real out-of-process timing.
 * There is no path through this file that produces a number a run did not measure.
 *
 * # The two budget models, and why both are reported
 *
 * A discovery loop can be budgeted two ways, and they answer different questions:
 *
 * - **attempt-budgeted** — both arms execute the same number of attempts. This
 *   isolates the policy's *routing* effect: given identical work, did it place the
 *   work better?
 * - **round-budgeted** — both arms get the same number of decision rounds, so an arm
 *   that batches executes more attempts. This isolates the *parallelism* effect,
 *   which is what a latency-bound deployment actually cares about.
 *
 * Reporting only the first would hide the batching benefit; only the second would
 * compare different amounts of work and call it an efficiency win. Both are
 * measured and labelled.
 * @module
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ReplayWorld, type ExplorationPolicy, type PrefixQuestion } from '@neeboo/unreal-harness-policy'
import { DeepSeekClient, type Effort } from './deepseek.ts'
import { runArm, selectByDreaming, type ArmResult } from './ab.ts'
import { HELD_OUT_INSTANCES, referenceOutputs } from './task-optimize.ts'
import { evaluateCandidate } from './evaluator.ts'
import { SEED_SOURCE } from './task-optimize.ts'

/** The seed's own speedup, which is 1 by definition. */
const SEED_SPEEDUP = 1

/**
 * The fixed arm's policy: the hand-written baseline.
 *
 * Opens one branch per decision round and always continues the most recently
 * revealed node. It is deliberately simple — it is what a harness does when nobody
 * is improving the strategy — and it is also the pool's incumbent, so the dream arm
 * can never do worse on the recorded history.
 */
export const fixedPolicy: ExplorationPolicy = {
  id: 'fixed-greedy',
  label: 'open one branch per round, continue the latest',
  beta: 0.5,
  planGrid: context => ({
    branchCount: Math.max(1, Math.min(4, context.hardMaxBranchCount)),
    refineCount: 1,
  }),
  selectBatch: (question: PrefixQuestion) => {
    if (question.legalRoots().length > 0) return ['root']
    // Positional, never an id: a policy is replayed against every recorded world,
    // and ids differ between them.
    const actions = question.legalActions().filter(action => action !== 'root')
    return actions.length === 0 ? [] : [actions.at(-1)!]
  },
}

/**
 * Candidate policies the dream arm may deploy, the incumbent included.
 *
 * # The constraint that shapes these
 *
 * A policy is evaluated by replaying **every** recorded world, so it must not
 * depend on anything world-specific. Node ids are exactly that: the fixed arm's
 * round-1 tree and the dream arm's round-3 tree name their nodes differently, so a
 * policy that returned `observed()` keys verbatim would ask world A for a node that
 * only exists in world B.
 *
 * Every policy here therefore decides from information that is the same shape in
 * every world — the count of revealed nodes, the implicit root, and the question's
 * own counters. That is not a workaround; it is the property that makes a policy
 * portable between the history it was dreamed in and the run it is deployed to.
 */
export function candidatePolicies(branchCount: number, refineCount: number): readonly ExplorationPolicy[] {
  const grid = (): { branchCount: number; refineCount: number } => ({ branchCount, refineCount })

  /**
   * The hand-written baseline: open a branch, then keep continuing the newest node.
   *
   * Uses positional selection (`legalActions().at(-1)`) rather than an id, so it
   * means the same thing in every world.
   */
  const greedy: ExplorationPolicy = {
    id: 'fixed-greedy',
    label: 'open one branch, continue the newest node',
    beta: 0.5,
    planGrid: grid,
    selectBatch: question => {
      if (question.legalRoots().length > 0) return ['root']
      const actions = question.legalActions().filter(action => action !== 'root')
      return actions.length === 0 ? [] : [actions.at(-1)!]
    },
  }

  /** Open every branch first, then refine breadth-first from the front. */
  const breadthFirst: ExplorationPolicy = {
    id: 'breadth-first',
    label: 'open all branches, then refine from the oldest',
    beta: 0.7,
    planGrid: grid,
    selectBatch: question => {
      if (question.legalRoots().length > 0) return ['root']
      const actions = question.legalActions().filter(action => action !== 'root')
      return actions.slice(0, question.maxParallelism)
    },
  }

  /** One attempt per decision round: deliberately the most serial arm. */
  const serial: ExplorationPolicy = {
    id: 'serial',
    label: 'one attempt per decision round',
    beta: 0.1,
    planGrid: grid,
    selectBatch: question => {
      const actions = question.legalActions()
      return actions.length === 0 ? [] : [actions[0]!]
    },
  }

  /**
   * Spend attempts on fresh lineages rather than on improving one.
   *
   * The breadth bet at its extreme: many shallow versions instead of one deep one.
   * It is the candidate most likely to score differently from the incumbent, which
   * is what makes the pool worth selecting within.
   */
  const openHeavy: ExplorationPolicy = {
    id: 'open-heavy',
    label: 'spend attempts opening fresh lineages',
    beta: 0.6,
    planGrid: grid,
    selectBatch: question => {
      if (question.legalRoots().length > 0) return ['root']
      return question.legalActions().slice(0, question.maxParallelism)
    },
  }

  return [greedy, serial, openHeavy, breadthFirst]
}

/** How the run is configured. */
export interface BenchRunOptions {
  readonly apiKey: string
  readonly rounds: number
  readonly branchCount: number
  readonly refineCount: number
  readonly maxParallelism: number
  readonly effort: Effort
  readonly model?: string
  /** Write measurements and the report here. */
  readonly outDir: string
  /** Print progress as rounds finish. */
  readonly onProgress?: (message: string) => void
}

/** One arm's summary, as the report prints it. */
export interface ArmSummary {
  readonly armId: string
  readonly bestSpeedup?: number
  readonly agentCalls: number
  readonly providerCalls: number
  readonly promptTokens: number
  readonly completionTokens: number
  readonly cachedPromptTokens: number
  readonly wallMs: number
  /** Policy deployed in each round, so a reader can see selection change. */
  readonly deployed: readonly string[]
  /** Per-round best speedup, which is the discovery curve. */
  readonly curve: readonly (number | undefined)[]
  /** Attempts that produced correct, faster code. */
  readonly improvements: number
}

/** The full benchmark output, written to disk as JSON. */
export interface BenchRunOutput {
  readonly startedAt: string
  readonly model: string
  readonly effort: Effort
  readonly budget: {
    readonly rounds: number
    readonly branchCount: number
    readonly refineCount: number
    readonly attemptsPerRound: number
    readonly maxParallelism: number
  }
  readonly seed: {
    readonly source: string
    readonly speedup: number
  }
  readonly heldOutInstances: readonly string[]
  readonly arms: readonly ArmSummary[]
  /** Whether the two arms executed the same number of attempts, which is the experiment's premise. */
  readonly equalAttempts: boolean
  readonly dreamSelections: readonly {
    readonly round: number
    readonly selected: string
    readonly scores: readonly { readonly policyId: string; readonly meanScore: number | undefined }[]
  }[]
}

/**
 * Run the A/B and write its outputs.
 * @param options - credentials, budget, and the output directory.
 * @returns the measurements, also written to `outDir`.
 */
export async function runBenchmark(options: BenchRunOptions): Promise<BenchRunOutput> {
  const client = new DeepSeekClient({
    apiKey: options.apiKey,
    effort: options.effort,
    ...options.model === undefined ? {} : { model: options.model },
  })
  const progress = options.onProgress ?? ((): void => {})
  const attemptsPerRound = options.branchCount * (options.refineCount + 1)

  progress(`model ${client.model} (effort ${client.effort}); ${options.rounds} rounds x ${attemptsPerRound} attempts`)

  // ---- Arm 1: fixed exploration -------------------------------------------
  progress('arm fixed: starting')
  const fixed = await runArm({
    armId: 'fixed',
    client,
    policy: fixedPolicy,
    rounds: options.rounds,
    branchCount: options.branchCount,
    refineCount: options.refineCount,
    maxParallelism: options.maxParallelism,
    onRound: (round) => {
      progress(`arm fixed: round ${round.round}/${options.rounds} ${round.bestSpeedup === undefined ? '(no correct candidate yet)' : `best ${round.bestSpeedup.toFixed(2)}x`}`)
    },
  })

  // ---- Arm 2: Dream-RSI ---------------------------------------------------
  progress('arm dream: starting')
  const worlds: ReplayWorld[] = []
  const candidates = candidatePolicies(options.branchCount, options.refineCount)
  const dreamSelections: BenchRunOutput['dreamSelections'][number][] = []

  const dream = await runArm({
    armId: 'dream',
    client,
    policy: fixedPolicy,
    rounds: options.rounds,
    branchCount: options.branchCount,
    refineCount: options.refineCount,
    maxParallelism: options.maxParallelism,
    selectPolicy: async (round, history) => {
      worlds.splice(0, worlds.length, ...history)
      const { selected, evaluations } = selectByDreaming(worlds, candidates, {
        cost: 0.05,
        parallelism: 0.1,
      })
      dreamSelections.push({
        round,
        selected: selected.id,
        scores: evaluations.map(evaluation => ({
          policyId: evaluation.policyId,
          meanScore: evaluation.meanScore,
        })),
      })
      progress(`arm dream: round ${round}/${options.rounds} replays ${history.length} world(s) -> deploys ${selected.id}`)
      return selected
    },
    onRound: (round) => {
      progress(`arm dream: round ${round.round}/${options.rounds} ${round.bestSpeedup === undefined ? '(no correct candidate yet)' : `best ${round.bestSpeedup.toFixed(2)}x`}`)
    },
  })

  const fixedSummary = summariseArm(fixed)
  const dreamSummary = summariseArm(dream)

  const output: BenchRunOutput = {
    startedAt: new Date().toISOString(),
    model: client.model,
    effort: client.effort,
    budget: {
      rounds: options.rounds,
      branchCount: options.branchCount,
      refineCount: options.refineCount,
      attemptsPerRound,
      maxParallelism: options.maxParallelism,
    },
    seed: { source: SEED_SOURCE, speedup: SEED_SPEEDUP },
    heldOutInstances: HELD_OUT_INSTANCES.map(instance => instance.name),
    arms: [fixedSummary, dreamSummary],
    // The experiment's premise, checked rather than asserted: if the arms ran
    // different amounts of work, no quality comparison between them is valid, and a
    // reader must be told rather than left to assume.
    equalAttempts: fixedSummary.agentCalls === dreamSummary.agentCalls,
    dreamSelections,
  }

  await mkdir(options.outDir, { recursive: true })
  await writeFile(join(options.outDir, 'measurements.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8')
  await writeFile(join(options.outDir, 'report.md'), renderReport(output, fixed, dream), 'utf8')
  progress(`wrote ${join(options.outDir, 'measurements.json')} and report.md`)
  return output
}

function summariseArm(arm: ArmResult): ArmSummary {
  const improvements = arm.rounds
    .flatMap(round => round.attempts)
    .filter(attempt => attempt.correct && (attempt.speedup ?? 0) > 1)
    .length
  return {
    armId: arm.armId,
    ...arm.bestSpeedup === undefined ? {} : { bestSpeedup: arm.bestSpeedup },
    agentCalls: arm.agentCalls,
    providerCalls: arm.providerCalls,
    promptTokens: arm.promptTokens,
    completionTokens: arm.completionTokens,
    cachedPromptTokens: arm.cachedPromptTokens,
    wallMs: arm.rounds.reduce((sum, round) => sum + round.wallMs, 0),
    deployed: arm.deployed.map(entry => entry.policyId),
    curve: arm.rounds.map(round => round.bestSpeedup),
    improvements,
  }
}

/**
 * Render the markdown report.
 *
 * Written so that the tables are derived from the measurements and nothing is
 * typed by hand: a report that can disagree with its own data is worse than no
 * report.
 * @param output - the measurements.
 * @param fixed - the fixed arm's raw result, for per-attempt detail.
 * @param dream - the dream arm's raw result.
 * @returns the report as markdown.
 */
export function renderReport(output: BenchRunOutput, fixed: ArmResult, dream: ArmResult): string {
  const lines: string[] = []
  const [fixedSummary, dreamSummary] = output.arms
  if (fixedSummary === undefined || dreamSummary === undefined) {
    throw new Error('the report needs both arms')
  }

  lines.push('# RSI-Harness benchmark: fixed exploration vs Dream-RSI')
  lines.push('')
  lines.push(`Run at \`${output.startedAt}\` · model \`${output.model}\` (effort \`${output.effort}\`) · seed \`node\` evaluator`)
  lines.push('')
  lines.push('## Headline')
  lines.push('')
  lines.push('| arm | best speedup | attempts | provider calls | input tokens | output tokens | cached input | wall time |')
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const arm of [fixedSummary, dreamSummary]) {
    lines.push(`| \`${arm.armId}\` | ${fmtX(arm.bestSpeedup)} | ${arm.agentCalls} | ${arm.providerCalls} | ${arm.promptTokens.toLocaleString('en-US')} | ${arm.completionTokens.toLocaleString('en-US')} | ${arm.cachedPromptTokens.toLocaleString('en-US')} | ${(arm.wallMs / 1000).toFixed(1)}s |`)
  }
  lines.push('')
  lines.push(`Budget: ${output.budget.rounds} rounds × ${output.budget.attemptsPerRound} attempts (branchCount ${output.budget.branchCount} × (refineCount ${output.budget.refineCount} + 1)), parallelism ${output.budget.maxParallelism}.`)
  lines.push('')
  lines.push(output.equalAttempts
    ? '**Premise held:** both arms executed the same number of attempts, so the speedup comparison is like-for-like.'
    : '**Premise BROKEN:** the arms executed different attempt counts, so the speedup comparison is NOT like-for-like. Treat the quality row as invalid.')
  lines.push('')

  lines.push('## Discovery curve')
  lines.push('')
  lines.push('Best held-out speedup after each round. The first round is identical by design — the dream arm starts from the same incumbent policy, so any divergence after round 1 is the dreaming.')
  lines.push('')
  lines.push(`| round | ${fixedSummary.armId} | ${dreamSummary.armId} | deployed by dream |`)
  lines.push('| ---: | ---: | ---: | --- |')
  for (let index = 0; index < output.budget.rounds; index += 1) {
    const selection = output.dreamSelections.find(entry => entry.round === index + 1)
    lines.push(`| ${index + 1} | ${fmtX(fixedSummary.curve[index])} | ${fmtX(dreamSummary.curve[index])} | \`${selection?.selected ?? '—'}\` |`)
  }
  lines.push('')

  lines.push('## What the dreaming chose, and why')
  lines.push('')
  lines.push('Each row is the offline replay evaluation that decided the next round\'s policy. Scores are the paper\'s replay objective over the recorded trees: best realized speedup, minus a cost term for attempts, plus a parallelism bonus for achieving it in fewer decision rounds.')
  lines.push('')
  lines.push('| round | deployed | ' + uniquePolicies(output).map(id => `\`${id}\``).join(' | ') + ' |')
  lines.push('| ---: | --- | ' + uniquePolicies(output).map(() => '---:').join(' | ') + ' |')
  for (const selection of output.dreamSelections) {
    const byPolicy = new Map(selection.scores.map(entry => [entry.policyId, entry.meanScore]))
    lines.push('| ' + String(selection.round) + ' | `' + selection.selected + '` | ' + uniquePolicies(output).map(id => {
      const score = byPolicy.get(id)
      return score === undefined ? 'not evaluated' : score.toFixed(4)
    }).join(' | ') + ' |')
  }
  lines.push('')

  lines.push('### Is the pool discriminating?')
  lines.push('')
  lines.push('A pool whose candidates all score the same gives the dreaming nothing to choose between, and a "no difference" result from such a pool measures the benchmark design rather than the loop. `Discriminating` means at least two candidates scored differently on the recorded history.')
  lines.push('')
  lines.push('| round | discriminating | distinct scores |')
  lines.push('| ---: | --- | ---: |')
  for (const selection of output.dreamSelections) {
    const scores = selection.scores.map(entry => entry.meanScore).filter((score): score is number => score !== undefined)
    const distinct = new Set(scores.map(score => score.toFixed(6))).size
    lines.push('| ' + String(selection.round) + ' | ' + (distinct >= 2 ? 'yes' : '**no**') + ' | ' + String(distinct) + ' |')
  }
  lines.push('')
  lines.push('A pool whose candidates all score the same gives the dreaming nothing to choose between, and a "no difference" result from such a pool measures the benchmark design rather than the loop. `Discriminating` means at least two candidates scored differently on the recorded history.')
  lines.push('')
  lines.push('| round | discriminating | distinct scores |')
  lines.push('| ---: | --- | ---: |')
  for (const selection of output.dreamSelections) {
    const scores = selection.scores
      .map(entry => entry.meanScore)
      .filter((score): score is number => score !== undefined)
    const distinct = new Set(scores.map(score => score.toFixed(6))).size
    lines.push('| ' + String(selection.round) + ' | ' + (distinct >= 2 ? 'yes' : '**no**') + ' | ' + String(distinct) + ' |')
  }
  lines.push('')

  lines.push('## Efficiency')
  lines.push('')
  lines.push('Cost per unit of quality, which is the axis the published harness comparisons use.')
  lines.push('')
  lines.push('| arm | attempts per improvement | input tokens per improvement | output tokens per improvement |')
  lines.push('| --- | ---: | ---: | ---: |')
  for (const arm of [fixedSummary, dreamSummary]) {
    lines.push(`| \`${arm.armId}\` | ${arm.improvements === 0 ? 'n/a' : (arm.agentCalls / arm.improvements).toFixed(1)} | ${arm.improvements === 0 ? 'n/a' : Math.round(arm.promptTokens / arm.improvements).toLocaleString('en-US')} | ${arm.improvements === 0 ? 'n/a' : Math.round(arm.completionTokens / arm.improvements).toLocaleString('en-US')} |`)
  }
  lines.push('')

  lines.push('## Correctness, per attempt')
  lines.push('')
  lines.push('A candidate counts only when it matched the seed on every held-out instance. A fast wrong answer is recorded as a failure, so the improvement counts above are correctness-gated.')
  lines.push('')
  lines.push('| arm | attempts | correct | incorrect | declined (NOCHANGE) | unparsable |')
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: |')
  for (const arm of [['fixed', fixed] as const, ['dream', dream] as const]) {
    const attempts = arm[1].rounds.flatMap(round => round.attempts)
    const correct = attempts.filter(entry => entry.correct).length
    const declined = attempts.filter(entry => entry.failure === 'NOCHANGE').length
    const unparsable = attempts.filter(entry => entry.failure === 'no code block in the reply').length
    lines.push(`| \`${arm[0]}\` | ${attempts.length} | ${correct} | ${attempts.length - correct - declined - unparsable} | ${declined} | ${unparsable} |`)
  }
  lines.push('')

  lines.push('## How to read this')
  lines.push('')
  lines.push('- **The seed is the baseline at 1.00×.** Every attempt starts from the previous best code on its branch, so a speedup above 1 means the agent found a faster correct implementation.')
  lines.push('- **Quality is held-out runtime**, measured out of process on inputs the agent never saw. `node` JIT noise is real; the evaluator takes a median over repetitions and discards the warm-up call.')
  lines.push('- **The dream arm spends no model calls on dreaming.** Replay reads recorded attempts, so its provider-call count is identical to the fixed arm\'s by construction — any token difference comes from the deployed policy changing which code each attempt inherits, not from extra work.')
  lines.push('- **What is not claimed:** this is not Terminal-Bench, SWE-Atlas, or DeepSWE. Those numbers require Harbor and a container runtime; see `HARBOR.md`. A result here measures the *exploration loop*, not general coding ability.')
  lines.push('')
  return `${lines.join('\n')}\n`
}

function uniquePolicies(output: BenchRunOutput): readonly string[] {
  const ids = new Set<string>()
  for (const selection of output.dreamSelections) {
    for (const score of selection.scores) ids.add(score.policyId)
  }
  return [...ids].sort()
}

function fmtX(value: number | undefined): string {
  return value === undefined ? '—' : `${value.toFixed(3)}×`
}

/** Distance helper for callers that need the evaluator's own view of the seed. */
export async function seedBaseline(): Promise<{ readonly correct: boolean; readonly medianMs?: number }> {
  const result = await evaluateCandidate(SEED_SOURCE, {
    instances: HELD_OUT_INSTANCES,
    reference: referenceOutputs(HELD_OUT_INSTANCES),
  })
  return {
    correct: result.correct,
    ...result.medianMs === undefined ? {} : { medianMs: result.medianMs },
  }
}

export { dirname }
