/**
 * The exploration-policy vocabulary: what a policy decides, and what it is
 * allowed to see.
 *
 * A policy does not solve the task. It decides *where to spend search effort* —
 * which recorded branch to continue, how many continuations to run at once, when
 * to open a new direction, and when to stop. Keeping that separate from the agent
 * is what makes the strategy improvable without touching the agent at all.
 *
 * # The one hard constraint
 *
 * A policy sees only {@link PrefixObservation}: what its own decisions have
 * revealed. It cannot read an unrevealed score, a true optimum, or a hardcoded
 * winning node. That is not a style rule — it is what makes an offline replay
 * score a valid prediction of running the same policy online. A policy with
 * privileged information would score well in replay and fail in production, and
 * nothing in the replay result would show it.
 *
 * # Two levels of policy
 *
 * A policy answers one question per decision round ({@link ExplorationPolicy.selectBatch})
 * and one question before a run starts ({@link ExplorationPolicy.planGrid}).
 * The second is easy to overlook and it is where a policy shapes the search
 * space itself rather than its route through it.
 * @module
 */

/** One node's outcome as a policy may observe it. */
export interface PrefixObservation {
  readonly nodeId: string
  readonly branch: number
  readonly attempt: number
  /** Completed turns this attempt consumed. */
  readonly turns: number
  readonly status: 'open' | 'scored' | 'failed'
  /** The realized evaluator score, when the attempt produced one. */
  readonly score?: number
}

/**
 * Reserved handle for the implicit initial workspace.
 *
 * The root of a discovery tree is a workspace state, not an attempt, so it has no
 * node. Selecting this handle opens the next recorded branch. It is a plain
 * string because it travels through policy code, so the name is reserved.
 */
export const IMPLICIT_ROOT = 'root'

/**
 * What a policy may ask the environment.
 *
 * The surface is deliberately narrow. Every method returns only revealed
 * information, so a policy cannot reach past its own prefix however it tries —
 * there is nothing to reach with.
 */
export interface PrefixQuestion {
  /** Revealed observations, keyed by node id. Only the revealed prefix. */
  observed(): Readonly<Record<string, PrefixObservation>>
  /** Nodes whose selection would reveal something: the legal batch members. */
  legalActions(): readonly string[]
  /** Branch heads not yet opened, in creation order. */
  legalRoots(): readonly string[]
  /** Branch heads already opened, in creation order. */
  openedBranches(): readonly string[]
  /** Decision rounds completed so far. */
  readonly roundCount: number
  /** The baseline score to compare against, when the task defines one. */
  readonly baselineScore: number | undefined
  /** How many continuations may run in one batch. */
  readonly maxParallelism: number
  /** Whether every recorded node has been revealed. */
  readonly exhausted: boolean
}

/**
 * One policy decision round.
 *
 * `requested` is what the policy asked for; `revealed` is what actually came
 * back. They differ when a selected node had no recorded continuation, and
 * keeping both is what lets a reviewer separate "the policy chose badly" from
 * "history had nothing there".
 */
export interface PolicyRound {
  readonly index: number
  readonly requested: readonly string[]
  readonly revealed: readonly string[]
}

/** Why a policy run stopped. */
export type StopReason = 'empty-batch' | 'round-limit' | 'exhausted'

/** The outcome of running one policy against one world. */
export interface PolicyRun {
  readonly rounds: readonly PolicyRound[]
  readonly revealedNodeIds: readonly string[]
  /** Revealed non-root nodes: the generation–evaluation requests the run represents. */
  readonly revealedNodeCount: number
  readonly roundCount: number
  /** Best realized score anywhere in the revealed subtree. */
  readonly bestScore: number | undefined
  readonly stopReason: StopReason
}

/**
 * The shape of the exploration grid a policy wants for its next online run.
 *
 * A policy that only chose batches would be choosing a route through a fixed
 * space. This lets it choose the space: how many independent branches to open,
 * and how many refinements each may take.
 */
export interface GridPlan {
  readonly branchCount: number
  readonly refineCount: number
}

/** What the environment can offer when a policy plans its grid. */
export interface GridPlanningContext {
  /** Hard ceiling on branches, from the deployment's real capacity. */
  readonly hardMaxBranchCount: number
  /** Hard ceiling on refinements, from the deployment's real capacity. */
  readonly hardMaxRefineCount: number
  /**
   * The shape used when the policy has no basis for a choice.
   *
   * Provided so a policy with no history can still return a defensible plan
   * instead of inventing one or deferring to a runner fallback.
   */
  readonly fallback: GridPlan
  /**
   * How many recorded runs the policy can learn from.
   *
   * Zero means this is the first run and the plan can only be a bootstrap.
   */
  readonly recordedRunCount: number
}

/**
 * One version of an exploration policy.
 *
 * `id` is stable so a run, a score, and a selection can all name the same
 * version; `label` is for humans. Nothing here describes *how* the policy is
 * implemented — a hand-written function, a generated program, and a model-driven
 * replan all satisfy this interface, which is what lets the dreaming loop treat
 * them alike.
 */
export interface ExplorationPolicy {
  readonly id: string
  readonly label?: string
  /**
   * The intensity scalar, fixed for the whole run.
   *
   * One knob rather than many, and fixed rather than adaptive within a run: a
   * policy that changed its own intensity based on what it saw would be
   * optimising during the run, which is what the offline phase is for. High means
   * wider, more patient, weaker pruning.
   */
  readonly beta: number
  /**
   * Choose the grid for the NEXT online run.
   *
   * Runs before any live attempt exists, so it must not inspect current outcomes.
   * It may use the recorded history's shape and the deployment's ceilings.
   * @param context - capacity ceilings, a fallback shape, and how much history exists.
   * @returns the requested grid, within the ceilings.
   */
  planGrid(context: GridPlanningContext): GridPlan
  /**
   * Choose the next batch of nodes to continue from.
   *
   * @param question - the prefix-only environment.
   * @returns node ids to select, or an empty array to stop.
   */
  selectBatch(question: PrefixQuestion): readonly string[]
}

/**
 * Clamp a requested grid to the deployment's ceilings.
 *
 * A policy is model-authored in the interesting case, so its arithmetic cannot be
 * trusted: it may ask for more branches than the deployment can run, or for zero
 * of something. Clamping with a reported reason beats both rejecting (which
 * loses a runnable policy) and honouring (which overruns capacity).
 * @param requested - what the policy asked for.
 * @param context - the ceilings to clamp against.
 * @returns the usable grid and whether anything was changed.
 */
export function clampGrid(
  requested: GridPlan,
  context: Pick<GridPlanningContext, 'hardMaxBranchCount' | 'hardMaxRefineCount'>,
): { readonly plan: GridPlan; readonly clamped: boolean; readonly reason?: string } {
  const branchCount = clampDimension(
    requested.branchCount,
    context.hardMaxBranchCount,
    'branchCount',
  )
  const refineCount = clampDimension(
    requested.refineCount,
    context.hardMaxRefineCount,
    'refineCount',
  )
  const clamped = branchCount.value !== requested.branchCount || refineCount.value !== requested.refineCount
  if (!clamped) return { plan: { branchCount: branchCount.value, refineCount: refineCount.value }, clamped: false }
  const reasons = [branchCount.reason, refineCount.reason].filter(
    (reason): reason is string => reason !== undefined,
  )
  return {
    plan: { branchCount: branchCount.value, refineCount: refineCount.value },
    clamped: true,
    reason: reasons.join('; '),
  }
}

function clampDimension(
  requested: number,
  ceiling: number,
  name: string,
): { readonly value: number; readonly reason?: string } {
  if (!Number.isInteger(requested) || requested < 1) {
    return { value: 1, reason: `${name} ${requested} is not a positive integer; using 1` }
  }
  if (requested > ceiling) {
    return { value: ceiling, reason: `${name} ${requested} exceeds the ceiling ${ceiling}; using ${ceiling}` }
  }
  return { value: requested }
}
