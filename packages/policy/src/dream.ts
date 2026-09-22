/**
 * The dreaming loop: improve the exploration policy offline, from history.
 *
 * The problem this solves is one of feedback cost. Judging a policy requires
 * seeing how it shapes an entire discovery process, so online evaluation means
 * one full rollout per candidate — and a bad candidate costs a rollout to
 * discover. But a *completed* rollout already recorded every attempt and its
 * outcome, so a different policy can be scored by walking that record. Many
 * candidates can then be judged for the price of reading.
 *
 * One iteration is: score the current policy against every recorded world, let a
 * proposer suggest a revision, score that too, and keep the best. Because the
 * candidate set includes the incumbent, the selection is **monotone in replay
 * score** — the policy that comes out is never worse than the one that went in,
 * on the history it was judged against.
 *
 * # What the guarantee is and is not
 *
 * It is a guarantee about the recorded history, not about the next live run.
 * Replay traverses outcomes that already happened, so a policy that looks better
 * offline may still be worse on a world it has never seen. The loop raises the
 * floor; it does not promise the ceiling. Stating that plainly is the difference
 * between a method and a sales pitch.
 *
 * # Where the intelligence is
 *
 * This module contains no model call. {@link DreamingLoopOptions.propose} is the
 * seam where a proposer — an LLM revising policy code, a search, a human — plugs
 * in. Keeping the loop model-free means the orchestration is testable without a
 * provider and a deployment can change how policies are invented without
 * touching how they are judged.
 * @module
 */

import { runPolicy, type ReplayOptions, type ReplayWorld } from './replay.ts'
import { replayScore } from './replay.ts'
import type { ExplorationPolicy } from './types.ts'

/** What one policy scored on one world. */
export interface WorldScore {
  readonly worldIndex: number
  /** Averaged replay score, or `undefined` when no world produced a score. */
  readonly score: number | undefined
  /** Per-world scores, in history order. */
  readonly perWorld: readonly (number | undefined)[]
}

/** One policy version's evaluation across the whole history. */
export interface PolicyEvaluation {
  readonly policyId: string
  readonly label?: string
  /** Average replay score across worlds. `undefined` when nothing scored. */
  readonly meanScore: number | undefined
  readonly perWorld: readonly (number | undefined)[]
}

/** Why a dreaming iteration stopped improving. */
export type DreamStopReason =
  /** The revision budget was spent. */
  | 'budget-spent'
  /** The proposer declined to suggest another revision. */
  | 'proposer-stopped'

/** The outcome of one dreaming phase: what was tried, and what won. */
export interface DreamOutcome {
  /** Every candidate evaluated, in the order they were tried. */
  readonly evaluations: readonly PolicyEvaluation[]
  /** The selected policy: the best on the fixed history. */
  readonly selected: ExplorationPolicy
  /** The incumbent it replaced. */
  readonly incumbent: ExplorationPolicy
  /**
   * Whether the selection is provably no worse than the incumbent on this
   * history. Always true unless the incumbent failed to score at all, which means
   * there was nothing to compare against.
   */
  readonly monotone: boolean
  readonly stopReason: DreamStopReason
}

/** How the loop is configured. */
export interface DreamingLoopOptions {
  /**
   * Suggest a revision of a scored policy, or decline.
   *
   * The one place intelligence enters. It receives the incumbent, the history's
   * scores so far, and the revisions already tried, and returns a new policy or
   * `undefined` to stop. A proposer that returns the same policy id is rejected
   * rather than scored again, because a duplicate would consume budget while
   * proving nothing.
   */
  readonly propose: (context: ProposalContext) => Promise<ExplorationPolicy | undefined>
  /**
   * Revisions to attempt after the incumbent.
   *
   * Bounds the phase: each revision costs a full pass over the history, which is
   * cheap but not free.
   */
  readonly revisions: number
  /** Coefficients of the replay score. */
  readonly beta: { readonly cost: number; readonly parallelism: number }
  /** Round and parallelism limits for every replay. */
  readonly replay?: ReplayOptions
}

/** What a proposer is told. */
export interface ProposalContext {
  /** The policy currently deployed, already scored. */
  readonly incumbent: ExplorationPolicy
  /** Everything tried so far, best-known first is NOT guaranteed — history order. */
  readonly evaluations: readonly PolicyEvaluation[]
  /** The best score seen so far, for a proposer that wants to beat it. */
  readonly bestScore: number | undefined
  /** Policy ids already tried, so a proposer does not repeat one. */
  readonly triedIds: readonly string[]
}

/**
 * Evaluate one policy against every recorded world.
 *
 * Averaging rather than summing so a phase's scores stay comparable as history
 * grows. A world that yields no score contributes `undefined` and is excluded
 * from the mean, because counting it as zero would punish a policy for a world
 * where nothing was ever scored.
 * @param worlds - the recorded history.
 * @param policy - the policy to evaluate.
 * @param beta - score coefficients.
 * @param options - round and parallelism limits.
 * @returns the evaluation, with per-world detail retained.
 */
export function evaluatePolicy(
  worlds: readonly ReplayWorld[],
  policy: ExplorationPolicy,
  beta: { readonly cost: number; readonly parallelism: number },
  options: ReplayOptions = {},
): PolicyEvaluation {
  const perWorld: (number | undefined)[] = []
  for (const world of worlds) {
    const run = runPolicy(world, policy, options)
    perWorld.push(replayScore(run, beta))
  }
  const scored = perWorld.filter((score): score is number => score !== undefined)
  return {
    policyId: policy.id,
    ...policy.label === undefined ? {} : { label: policy.label },
    meanScore: scored.length === 0 ? undefined : scored.reduce((a, b) => a + b, 0) / scored.length,
    perWorld,
  }
}

/**
 * Run one dreaming phase: improve a policy over a fixed history.
 *
 * The history does not change during the phase, which is what makes the scores
 * comparable and the monotonicity claim meaningful. It grows only when the
 * selected policy is deployed and produces another recorded run.
 *
 * @param worlds - the recorded history to dream over.
 * @param incumbent - the deployed policy.
 * @param options - the proposer, the revision budget, and score coefficients.
 * @returns what was tried, what won, and whether the selection was monotone.
 */
export async function dream(
  worlds: readonly ReplayWorld[],
  incumbent: ExplorationPolicy,
  options: DreamingLoopOptions,
): Promise<DreamOutcome> {
  if (options.revisions < 0 || !Number.isInteger(options.revisions)) {
    throw new RangeError(`revisions must be a non-negative integer, received ${options.revisions}`)
  }

  const evaluations: PolicyEvaluation[] = [
    evaluatePolicy(worlds, incumbent, options.beta, options.replay ?? {}),
  ]
  let best = incumbent
  let bestEvaluation = evaluations[0]!
  let stopReason: DreamStopReason = 'budget-spent'

  for (let revision = 0; revision < options.revisions; revision += 1) {
    const proposal = await options.propose({
      incumbent: best,
      evaluations,
      bestScore: bestEvaluation.meanScore,
      triedIds: evaluations.map(evaluation => evaluation.policyId),
    })

    if (proposal === undefined) { stopReason = 'proposer-stopped'; break }

    // A repeated id would spend budget while proving nothing, and — worse —
    // would let a proposer "improve" by resubmitting the incumbent.
    if (evaluations.some(evaluation => evaluation.policyId === proposal.id)) {
      throw new Error(`the proposer returned policy "${proposal.id}", which has already been evaluated`)
    }

    const evaluation = evaluatePolicy(worlds, proposal, options.beta, options.replay ?? {})
    evaluations.push(evaluation)

    // Strictly greater keeps the incumbent on a tie, so a revision that changes
    // nothing does not churn the deployed policy.
    if (isBetter(evaluation.meanScore, bestEvaluation.meanScore)) {
      best = proposal
      bestEvaluation = evaluation
    }
  }

  return {
    evaluations,
    selected: best,
    incumbent,
    // The candidate set includes the incumbent, so a score for the incumbent is
    // what makes the comparison meaningful. Without one there was nothing to
    // compare, and claiming monotonicity would be empty.
    monotone: evaluations[0]!.meanScore !== undefined,
    stopReason,
  }
}

/** Whether `candidate` beats `current`, treating an absent score as no evidence. */
function isBetter(candidate: number | undefined, current: number | undefined): boolean {
  if (candidate === undefined) return false
  if (current === undefined) return true
  return candidate > current
}

/**
 * Sweep a fixed β grid and report the trade-off curve.
 *
 * β is the policy's single intensity scalar: high means wider and more patient,
 * low means more selective and quicker to stop. Sweeping it in replay is how a
 * caller finds out whether the scalar moves the attainment/effort trade-off at
 * all — a grid whose points land on top of each other is measuring nothing.
 *
 * The sweep changes only the deployment parameter, never the policy's decisions
 * within a run: a policy that adapted its own β mid-run would be optimising
 * during the run, which is what the offline phase exists to avoid.
 * @param worlds - the recorded history.
 * @param makePolicy - build a policy at one β.
 * @param grid - the β values to try, in order.
 * @param beta - score coefficients.
 * @param options - round and parallelism limits.
 * @returns one evaluation per grid point, in grid order.
 */
export function sweepBeta(
  worlds: readonly ReplayWorld[],
  makePolicy: (beta: number) => ExplorationPolicy,
  grid: readonly number[],
  beta: { readonly cost: number; readonly parallelism: number },
  options: ReplayOptions = {},
): readonly PolicyEvaluation[] {
  if (grid.length === 0) throw new RangeError('the beta grid must not be empty')
  return grid.map(value => evaluatePolicy(worlds, makePolicy(value), beta, options))
}

/**
 * Whether a β sweep actually measures anything.
 *
 * A grid that leaves the score unchanged is a degenerate sweep: it says the
 * scalar does not move the trade-off, so a caller should not read a "best β" out
 * of it. Reported explicitly because a flat sweep looks exactly like a
 * well-converged one unless someone checks.
 * @param evaluations - the sweep result.
 * @returns whether any two grid points differed in score.
 */
export function sweepIsInformative(evaluations: readonly PolicyEvaluation[]): boolean {
  const scores = evaluations
    .map(evaluation => evaluation.meanScore)
    .filter((score): score is number => score !== undefined)
  if (scores.length < 2) return false
  const first = scores[0]!
  return scores.some(score => score !== first)
}

/**
 * The best-scoring evaluation, or `undefined` when nothing scored.
 * @param evaluations - evaluations to compare.
 * @returns the winner under the replay score.
 */
export function bestEvaluation(
  evaluations: readonly PolicyEvaluation[],
): PolicyEvaluation | undefined {
  let best: PolicyEvaluation | undefined
  for (const evaluation of evaluations) {
    if (evaluation.meanScore === undefined) continue
    if (best === undefined || best.meanScore === undefined || evaluation.meanScore > best.meanScore) {
      best = evaluation
    }
  }
  return best
}
