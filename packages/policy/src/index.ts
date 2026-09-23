/**
 * # @unreal-harness/policy
 *
 * The dreaming loop: improve how an agent explores, offline, from what it
 * already recorded.
 *
 * A policy decides where to spend search effort — which recorded branch to
 * continue, how many at once, when to open a new direction, when to stop. It
 * does **not** solve the task, which is what lets the strategy be improved
 * without touching the agent.
 *
 * ## Why history is enough
 *
 * Judging a strategy normally costs a full rollout, because you have to see how
 * it shapes an entire discovery process. But a completed rollout already recorded
 * every attempt and its outcome, so a different strategy can be scored by walking
 * that record — no model call, no attempt, no evaluator. One expensive run
 * becomes a simulator many candidates can be judged against.
 *
 * ## What the loop promises, and what it does not
 *
 * Because the candidate set includes the incumbent, the selected policy is never
 * worse than the incumbent **on the recorded history**. That is a real guarantee
 * and a bounded one: replay traverses outcomes that already happened, so a policy
 * that looks better offline may still be worse on a world it has never seen. The
 * loop raises the floor, not the ceiling.
 *
 * ## No model in here
 *
 * {@link DreamingLoopOptions.propose} is the seam where intelligence plugs in — an
 * LLM revising policy code, a search, a human. Keeping the orchestration
 * model-free means the loop is testable without a provider and the way policies
 * are invented can change without touching the way they are judged.
 *
 * @example
 * ```ts
 * import { ReplayWorld, dream, PolicyStore } from '@unreal-harness/policy'
 *
 * const worlds = [new ReplayWorld(recordedNodes)]
 * const outcome = await dream(worlds, incumbent, {
 *   revisions: 3,
 *   beta: { cost: 0.1, parallelism: 0.2 },
 *   propose: async ({ bestScore, triedIds }) => nextCandidateOrUndefined(bestScore, triedIds),
 * })
 *
 * outcome.selected    // never worse than `incumbent` on this history
 * outcome.monotone    // whether that comparison was even possible
 * ```
 * @module
 */

export {
  IMPLICIT_ROOT,
  clampGrid,
} from './types.ts'
export type {
  ExplorationPolicy,
  GridPlan,
  GridPlanningContext,
  PolicyRound,
  PolicyRun,
  PrefixObservation,
  PrefixQuestion,
  StopReason,
} from './types.ts'

export {
  ReplayWorld,
  ReplayWorldError,
  replayScore,
  runPolicy,
} from './replay.ts'
export type { RecordedNode, ReplayOptions } from './replay.ts'

export {
  bestEvaluation,
  dream,
  evaluatePolicy,
  sweepBeta,
  sweepIsInformative,
} from './dream.ts'
export type {
  DreamOutcome,
  DreamStopReason,
  DreamingLoopOptions,
  PolicyEvaluation,
  ProposalContext,
  WorldScore,
} from './dream.ts'

export {
  POOL,
  depthPolicy,
  runReplayExperiment,
  statFor,
} from './replay-experiment.ts'
export type { PolicyStat } from './replay-experiment.ts'

export {
  makeRandom,
  syntheticCorpus,
  syntheticWorld,
} from './synthetic.ts'
export type {
  SyntheticCorpus,
  SyntheticWorld,
  SyntheticWorldOptions,
} from './synthetic.ts'

export {
  PROPOSAL_SYSTEM_PROMPT,
  ProposalCompileError,
  compileProposal,
  parseProposal,
  proposalUserMessage,
} from './propose.ts'
export type {
  CompiledProposal,
  PolicyRule,
  ProposedPolicy,
  RuleAction,
  RuleCondition,
} from './propose.ts'

export { PolicyStore, PolicyStoreError } from './store.ts'
export type { PolicyRecord } from './store.ts'

export {
  WetForkError,
  actionabilityGaps,
  recordForkAsNodes,
  wetFork,
} from './wetfork.ts'
export type {
  ArmSummary,
  AttemptRequest,
  AttemptResult,
  ComparisonOutcome,
  ForkArm,
  ForkCondition,
  WetForkOptions,
  WetForkResult,
} from './wetfork.ts'
