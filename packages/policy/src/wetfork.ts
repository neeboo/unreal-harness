/**
 * Wet forks: actually run attempts from a recorded node, instead of reasoning
 * about the ones that already happened.
 *
 * Dry replay is cheap and bounded. It scores a strategy by walking outcomes that
 * were recorded, which means it can only dream where history already went — a
 * policy that would explore genuinely new territory cannot be evaluated at all,
 * and a question about *cause* ("what if this node had been hidden?") has no
 * recorded answer.
 *
 * A wet fork answers those by running. It takes one node's workspace, executes
 * attempts from it under a chosen condition, and records the outcomes as new
 * nodes. That is real work and real money, which is exactly why it belongs behind
 * an interface the caller controls rather than inside the dreaming loop: the
 * cheap layer should decide *what is worth running*, and this layer runs it.
 *
 * # What this module owns, and what it does not
 *
 * It owns the orchestration: which nodes to fork from, how to pair the arms of a
 * comparison so they are comparable, what to record, and how to tell a real
 * difference from noise. It does **not** own attempt execution — the agent, the
 * evaluator, and the sandbox are the deployment's, reached through
 * {@link WetForkOptions.runAttempt}. That keeps the comparison logic testable
 * without a model or a container.
 * @module
 */

import type { RecordedNode } from './replay.ts'

/** Why a wet fork was refused. */
export class WetForkError extends Error {
  override readonly name = 'WetForkError'

  constructor(
    readonly code:
      | 'empty-plan'
      | 'unknown-condition'
      | 'replicas-out-of-range'
      | 'attempt-failed',
    message: string,
  ) {
    super(message)
  }
}

/**
 * One condition to run attempts under.
 *
 * A condition is a named variation — "full context", "chunk c7 hidden", "β 0.3" —
 * and it is the deployment's job to interpret it. Keeping it opaque here is what
 * lets the same executor compare a context change, a model route, and a policy
 * parameter without this module knowing which it is.
 */
export interface ForkCondition {
  /** Stable identity, used to pair arms and to label results. */
  readonly id: string
  /** For humans: what this arm varies. */
  readonly label?: string
  /** Opaque payload the deployment's `runAttempt` interprets. */
  readonly payload?: unknown
}

/** One attempt the executor asks for. */
export interface AttemptRequest {
  /** The node whose workspace and history this attempt continues. */
  readonly fromNodeId: string
  /** Which variation to run. */
  readonly condition: ForkCondition
  /** 1-based replica index, so a caller can average over repeats. */
  readonly replica: number
}

/** One attempt's outcome, as the deployment reports it. */
export interface AttemptResult {
  /** Whether the attempt produced a usable result. */
  readonly ok: boolean
  /** The evaluator's score, when one was produced. */
  readonly score?: number
  /** A failure classification, when the attempt failed. */
  readonly failure?: string
}

/** One recorded arm of a comparison. */
export interface ForkArm {
  readonly conditionId: string
  readonly fromNodeId: string
  readonly replica: number
  readonly result: AttemptResult
}

/** The aggregate for one arm across its replicas. */
export interface ArmSummary {
  readonly conditionId: string
  readonly label?: string
  /** Attempts that produced a score. */
  readonly scored: number
  /** Attempts that failed or produced no score. */
  readonly failed: number
  /** Mean score over the scored attempts, or `undefined` when none scored. */
  readonly meanScore: number | undefined
  /** Best score seen, or `undefined`. */
  readonly bestScore: number | undefined
  /** Every attempt's failure class, deduplicated, so a pattern is visible. */
  readonly failures: readonly string[]
}

/** The verdict of a paired comparison. */
export type ComparisonOutcome =
  /** An arm was better by more than the noise floor. */
  | { readonly kind: 'advantage'; readonly winner: string; readonly margin: number }
  /** The arms were within the noise floor of each other. */
  | { readonly kind: 'tie'; readonly margin: number }
  /** No arm produced a usable score, so there is nothing to compare. */
  | { readonly kind: 'inconclusive'; readonly reason: string }

/** The full result of one wet fork. */
export interface WetForkResult {
  readonly arms: readonly ForkArm[]
  readonly summaries: readonly ArmSummary[]
  readonly comparison: ComparisonOutcome
  /** Attempts actually executed. Real cost, reported rather than implied. */
  readonly attemptsRun: number
}

/** How a wet fork is executed. */
export interface WetForkOptions {
  /** The condition every other arm is compared against. */
  readonly control: ForkCondition
  /** Conditions to compare against the control. At least one is required. */
  readonly conditions: readonly ForkCondition[]
  /**
   * Replicas per arm.
   *
   * More than one is the honest default for a stochastic attempt: an agent given
   * the same workspace twice does not behave identically, so a single run per arm
   * compares noise. Kept configurable because replicas multiply cost linearly.
   */
  readonly replicas?: number
  /**
   * Score difference below which two arms are called a tie.
   *
   * Required rather than defaulted: what counts as a real difference is a
   * property of the task's scoring, and a library default would quietly decide a
   * research question.
   */
  readonly noiseFloor: number
  /** Execute one attempt. The only place real work happens. */
  readonly runAttempt: (request: AttemptRequest) => Promise<AttemptResult>
}

/**
 * Run attempts from one node under several conditions and compare them.
 *
 * Arms are interleaved rather than run one condition at a time: if the environment
 * drifts during the fork — a rate limit, a warming cache, a noisy machine — running
 * all of arm A then all of arm B would attribute the drift to the condition.
 * Interleaving spreads it across arms, which is the difference between a
 * comparison and a coincidence.
 * @param fromNodeId - the recorded node whose workspace every arm continues.
 * @param options - conditions, replicas, the noise floor, and the executor.
 * @returns every arm's result, its summary, and the comparison verdict.
 * @throws {WetForkError} when the plan is empty, a condition repeats, or the
 * replica count is not positive.
 */
export async function wetFork(
  fromNodeId: string,
  options: WetForkOptions,
): Promise<WetForkResult> {
  const replicas = options.replicas ?? 1
  if (!Number.isInteger(replicas) || replicas < 1) {
    throw new WetForkError(
      'replicas-out-of-range',
      `replicas must be a positive integer, received ${options.replicas}`,
    )
  }
  if (options.conditions.length === 0) {
    throw new WetForkError('empty-plan', 'a wet fork needs at least one non-control condition')
  }

  const planned = [options.control, ...options.conditions]
  const seen = new Set<string>()
  for (const condition of planned) {
    if (seen.has(condition.id)) {
      throw new WetForkError(
        'unknown-condition',
        `condition "${condition.id}" appears twice; arms must be distinguishable`,
      )
    }
    seen.add(condition.id)
  }

  const arms: ForkArm[] = []
  // Interleaved: replica 1 of every arm, then replica 2 of every arm, and so on.
  for (let replica = 1; replica <= replicas; replica += 1) {
    for (const condition of planned) {
      const result = await options.runAttempt({ fromNodeId, condition, replica })
      arms.push({ conditionId: condition.id, fromNodeId, replica, result })
    }
  }

  const summaries = planned.map(condition => summarise(condition, arms))
  return {
    arms,
    summaries,
    comparison: compare(summaries, options.noiseFloor),
    attemptsRun: arms.length,
  }
}

/** Aggregate one condition's arms. */
function summarise(condition: ForkCondition, arms: readonly ForkArm[]): ArmSummary {
  const mine = arms.filter(arm => arm.conditionId === condition.id)
  const scores = mine
    .map(arm => (arm.result.ok ? arm.result.score : undefined))
    .filter((score): score is number => score !== undefined)
  const failures = [
    ...new Set(
      mine
        .filter(arm => !arm.result.ok || arm.result.score === undefined)
        .map(arm => arm.result.failure ?? 'no score'),
    ),
  ]
  return {
    conditionId: condition.id,
    ...condition.label === undefined ? {} : { label: condition.label },
    scored: scores.length,
    failed: mine.length - scores.length,
    meanScore: scores.length === 0 ? undefined : scores.reduce((a, b) => a + b, 0) / scores.length,
    bestScore: scores.length === 0 ? undefined : Math.max(...scores),
    failures,
  }
}

/**
 * Decide whether the control differs from the best other arm.
 *
 * Compares against the BEST challenger rather than each in turn, because a plan
 * with three variants is asking "did any of these beat the control" — and
 * reporting three pairwise verdicts would invite reading a winner out of a
 * family of noisy comparisons.
 * @param summaries - per-condition aggregates, control first.
 * @param noiseFloor - score difference below which the arms are a tie.
 * @returns the verdict.
 */
function compare(summaries: readonly ArmSummary[], noiseFloor: number): ComparisonOutcome {
  const [control, ...challengers] = summaries
  if (control === undefined || control.meanScore === undefined) {
    return { kind: 'inconclusive', reason: 'the control produced no score' }
  }
  const scored = challengers.filter(
    (summary): summary is ArmSummary & { meanScore: number } => summary.meanScore !== undefined,
  )
  if (scored.length === 0) {
    return { kind: 'inconclusive', reason: 'no condition produced a score' }
  }

  const best = scored.reduce((left, right) =>
    right.meanScore > left.meanScore ? right : left)
  const margin = best.meanScore - control.meanScore

  if (margin > noiseFloor) {
    return { kind: 'advantage', winner: best.conditionId, margin }
  }
  // A challenger that is WORSE by more than the floor is also a real finding, but
  // it is not an "advantage" for the challenger, and reporting it as a tie would
  // hide a regression.
  if (margin < -noiseFloor) {
    return { kind: 'advantage', winner: control.conditionId, margin: -margin }
  }
  return { kind: 'tie', margin }
}

/**
 * Whether a result justifies acting on it.
 *
 * A single wet fork is evidence, not proof: the attempts are stochastic and the
 * comparison is against one node's workspace. This asks the questions a caller
 * should ask before deploying a condition, and it returns them as a list rather
 * than a boolean so a caller can see which one failed.
 * @param result - a completed wet fork.
 * @param options - minimum scored attempts per arm, and whether failures matter.
 * @returns the unmet conditions, empty when the result is usable.
 */
export function actionabilityGaps(
  result: WetForkResult,
  options: { readonly minimumScoredPerArm?: number; readonly allowFailures?: boolean } = {},
): readonly string[] {
  const minimum = options.minimumScoredPerArm ?? 1
  const gaps: string[] = []

  if (result.comparison.kind === 'inconclusive') {
    gaps.push(`the comparison is inconclusive: ${result.comparison.reason}`)
  }
  for (const summary of result.summaries) {
    if (summary.scored < minimum) {
      gaps.push(`"${summary.conditionId}" produced ${summary.scored} scored attempt(s), fewer than ${minimum}`)
    }
    if (options.allowFailures !== true && summary.failed > 0) {
      // A condition that fails more often is a finding about robustness, not just
      // a missing data point, so it is surfaced instead of averaged away.
      gaps.push(`"${summary.conditionId}" failed ${summary.failed} attempt(s): ${summary.failures.join(', ')}`)
    }
  }
  return gaps
}

/**
 * Convert wet-fork arms into recorded nodes, so a completed fork extends the
 * history the dreaming loop can read.
 *
 * This is what closes the loop: a wet fork is the only way to reach outcomes that
 * were never recorded, and once recorded they become replayable like any other
 * history. The returned nodes carry the numeric score the evaluator gave; branch
 * and attempt indices come from the caller, which owns the tree's shape.
 * @param parentId - the node every arm continues from.
 * @param result - a completed wet fork.
 * @param placement - branch and starting sibling order for the new nodes.
 * @returns recorded nodes, in arm order, skipping attempts that scored nothing.
 */
export function recordForkAsNodes(
  parentId: string,
  result: WetForkResult,
  placement: { readonly branch: number; readonly siblingOrderStart?: number },
): readonly RecordedNode[] {
  const nodes: RecordedNode[] = []
  let siblingOrder = placement.siblingOrderStart ?? 0
  let attempt = 0
  for (const arm of result.arms) {
    if (!arm.result.ok || arm.result.score === undefined) {
      // An attempt that produced no score is not a failed node; it is a missing
      // data point, and recording it as a scored node would put a made-up value
      // into a history the loop later trusts.
      continue
    }
    nodes.push({
      nodeId: `${parentId}#${arm.conditionId}#${arm.replica}`,
      parent: parentId,
      branch: placement.branch,
      attempt,
      siblingOrder,
      turns: 1,
      status: 'scored',
      score: arm.result.score,
    })
    attempt += 1
    siblingOrder += 1
  }
  return nodes
}
