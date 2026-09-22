/**
 * The A/B driver: run one exploration policy against the real task using
 * DeepSeek, and measure what it cost and what it reached.
 *
 * # The two arms
 *
 * - **`fixed`** — the hand-written baseline this repository compares against. It
 *   opens every branch and refines greedily, the same policy every round, which is
 *   what the Dream-RSI paper calls Recursive Fixed Exploration and what a plain
 *   harness does when nobody is improving the strategy.
 * - **`dream`** — the same task, the same model, the same per-round budget, but
 *   between rounds it *dreams*: candidate policies are scored by replaying the
 *   recorded attempts and the best is deployed. It calls no model for this, so the
 *   dreaming costs no agent calls.
 *
 * Equal budget is the whole experiment. Both arms execute exactly
 * `branchCount × (refineCount + 1)` attempts per round, so a difference in quality
 * is a difference the policy caused, and a difference in cost can only come from
 * token usage — never from one arm quietly doing more work.
 *
 * # What is real here, and what is bounded
 *
 * Real: the model, the generated code, the out-of-process evaluator, the token
 * accounting, the replay scoring, the selection, and the deployment.
 *
 * Bounded, and stated rather than glossed: the candidate policies in the dream arm's
 * pool are **hand-written strategy variants**, not code rewritten by a model. The
 * loop, the replay-based evaluation, the selection rule, and the monotonicity it
 * guarantees are all exercised; what is not exercised is a proposer that invents
 * new strategies. A later round can supply one — `dream()` takes any proposer —
 * but a benchmark must not claim an experiment it did not run.
 * @module
 */

import {
  IMPLICIT_ROOT,
  PolicyStore,
  ReplayWorld,
  dream,
  evaluatePolicy,
  type ExplorationPolicy,
  type PolicyEvaluation,
  type PrefixObservation,
  type PrefixQuestion,
  type RecordedNode,
} from '@neeboo/unreal-harness-policy'
import type { DeepSeekClient } from './deepseek.ts'
import { evaluateCandidate, type EvaluationResult } from './evaluator.ts'
import {
  DEV_INSTANCES,
  HELD_OUT_INSTANCES,
  SEED_SOURCE,
  attemptPrompt,
  extractSource,
  referenceOutputs,
} from './task-optimize.ts'

/** One executed attempt. */
export interface AttemptOutcome {
  readonly nodeId: string
  readonly parent?: string
  readonly branch: number
  readonly attempt: number
  /** Whether the attempt produced code that ran correctly. */
  readonly correct: boolean
  /** Median held-out runtime, when the attempt was correct. */
  readonly medianMs?: number
  /** Speedup over the seed, when both were measured. */
  readonly speedup?: number
  /** `NOCHANGE`, a parse failure, or the evaluator's reason. */
  readonly failure?: string
  readonly promptTokens: number
  readonly completionTokens: number
  readonly cachedPromptTokens: number
  /** Whether the attempt actually called the model. */
  readonly modelCalled: boolean
}

/** One round's result. */
export interface ArmRound {
  readonly round: number
  readonly policyId: string
  readonly attempts: readonly AttemptOutcome[]
  /** Best speedup anywhere in the tree after this round. */
  readonly bestSpeedup?: number
  readonly agentCalls: number
  readonly providerCalls: number
  readonly promptTokens: number
  readonly completionTokens: number
  readonly wallMs: number
  /** The policy's decision rounds, which is what batching compresses. */
  readonly decisionRounds: number
}

/** One arm's full result. */
export interface ArmResult {
  readonly armId: string
  readonly model: string
  readonly rounds: readonly ArmRound[]
  /** The best speedup reached across every round, or `undefined` if nothing ran correctly. */
  readonly bestSpeedup?: number
  readonly agentCalls: number
  readonly providerCalls: number
  readonly promptTokens: number
  readonly completionTokens: number
  readonly cachedPromptTokens: number
  /** Every recorded node across every round, for the dream arm to replay. */
  readonly nodes: readonly RecordedNode[]
  /** The policy deployed in each round, so a reader can see the selection change. */
  readonly deployed: readonly { readonly round: number; readonly policyId: string; readonly score?: number }[]
}

/** How an arm is configured. */
export interface ArmOptions {
  readonly armId: string
  readonly client: DeepSeekClient
  readonly policy: ExplorationPolicy
  readonly rounds: number
  readonly branchCount: number
  readonly refineCount: number
  /**
   * Attempts allowed to run at once.
   *
   * The paper's W. In the real task this is a genuine parallelism knob — attempts
   * are independent model calls — so raising it shortens wall-clock without
   * changing the attempt count.
   */
  readonly maxParallelism: number
  /** Decision rounds allowed inside one round's tree. */
  readonly decisionRoundLimit?: number
  /** Called after each round with the tree that round produced, for dreaming. */
  readonly onRound?: (round: ArmRound, nodes: readonly RecordedNode[]) => void
  /** Choose the policy for the next round. Defaults to keeping `policy`. */
  readonly selectPolicy?: (round: number, history: readonly ReplayWorld[]) => Promise<ExplorationPolicy>
}

/**
 * Run one arm.
 *
 * Each round builds a fresh tree from the seed source; the policy chooses which
 * node to continue from, and every attempt is a real model call plus a real
 * out-of-process evaluation.
 * @param options - the arm's client, policy, budget, and hooks.
 * @returns the arm's measurements.
 */
export async function runArm(options: ArmOptions): Promise<ArmResult> {
  const reference = referenceOutputs(HELD_OUT_INSTANCES)
  const heldOut = HELD_OUT_INSTANCES.map((instance, index) => ({
    instance,
    expected: reference[index] ?? [],
  }))

  const rounds: ArmRound[] = []
  const allNodes: RecordedNode[] = []
  const deployed: ArmResult['deployed'][number][] = []
  let bestSpeedup: number | undefined
  let promptTokens = 0
  let completionTokens = 0
  let cachedPromptTokens = 0
  let providerCalls = 0
  let agentCalls = 0

  /** Per-node facts the tree does not carry: the code, its parent, and its score. */
  const sourceOf = new Map<string, string>()
  const parentOf = new Map<string, string | undefined>()
  const triedOf = new Map<string, readonly string[]>()
  const scoreOf = new Map<string, number>()

  const worlds: ReplayWorld[] = []
  let policy = options.policy

  for (let round = 1; round <= options.rounds; round += 1) {
    if (options.selectPolicy !== undefined) {
      policy = await options.selectPolicy(round, worlds)
    }
    deployed.push({ round, policyId: policy.id, ...policy.beta === undefined ? {} : {} })

    const roundStarted = Date.now()
    const nodes: RecordedNode[] = []
    const attempts: AttemptOutcome[] = []
    const siblings = new Map<string, number>()
    let counter = 0

    const grid = policy.planGrid({
      hardMaxBranchCount: options.branchCount,
      hardMaxRefineCount: options.refineCount,
      fallback: { branchCount: options.branchCount, refineCount: options.refineCount },
      recordedRunCount: worlds.length,
    })

    /** Execute one attempt: prompt, model, evaluate, record. */
    const attempt = async (
      parentId: string | undefined,
      branch: number,
      attemptIndex: number,
    ): Promise<{ readonly outcome: AttemptOutcome; readonly node: RecordedNode }> => {
      const nodeId = `${options.armId}-r${round}-n${counter++}`
      const currentSource = parentId === undefined ? SEED_SOURCE : sourceOf.get(parentId) ?? SEED_SOURCE
      const tried = parentId === undefined ? [] : triedOf.get(parentId) ?? []

      const reply = await options.client.complete([
        { role: 'user', content: attemptPrompt({ currentSource, triedMutations: tried, devInstances: DEV_INSTANCES }) },
      ])
      providerCalls += 1
      promptTokens += reply.usage.promptTokens
      completionTokens += reply.usage.completionTokens
      cachedPromptTokens += reply.usage.cachedPromptTokens

      const outcomeBase = {
        nodeId,
        ...parentId === undefined ? {} : { parent: parentId },
        branch,
        attempt: attemptIndex,
        promptTokens: reply.usage.promptTokens,
        completionTokens: reply.usage.completionTokens,
        cachedPromptTokens: reply.usage.cachedPromptTokens,
        modelCalled: true,
      } as const

      if (/^\s*NOCHANGE\s*$/i.test(reply.text)) {
        // A model that declines is a real outcome, and it is recorded as a failed
        // attempt rather than silently retried: the cost was paid either way.
        const outcome: AttemptOutcome = { ...outcomeBase, correct: false, failure: 'NOCHANGE' }
        return { outcome, node: toNode(nodeId, parentId, branch, attemptIndex, nextSibling(siblings, parentId), outcome) }
      }

      const source = extractSource(reply.text)
      if (source === undefined) {
        const outcome: AttemptOutcome = { ...outcomeBase, correct: false, failure: 'no code block in the reply' }
        return { outcome, node: toNode(nodeId, parentId, branch, attemptIndex, nextSibling(siblings, parentId), outcome) }
      }

      const evaluation: EvaluationResult = await evaluateCandidate(source, {
        instances: heldOut.map(entry => entry.instance),
        reference: heldOut.map(entry => entry.expected),
        seedSource: SEED_SOURCE,
      })

      const outcome: AttemptOutcome = {
        ...outcomeBase,
        correct: evaluation.correct,
        ...evaluation.medianMs === undefined ? {} : { medianMs: evaluation.medianMs },
        ...evaluation.speedup === undefined ? {} : { speedup: evaluation.speedup },
        ...evaluation.failure === undefined ? {} : { failure: evaluation.failure },
      }
      sourceOf.set(nodeId, source)
      parentOf.set(nodeId, parentId)
      // The label a future attempt sees is the failure or the measured speedup —
      // never a guess about what the code did.
      triedOf.set(nodeId, [
        ...tried,
        evaluation.correct
          ? `speedup ${(evaluation.speedup ?? 0).toFixed(2)}x`
          : `failed: ${evaluation.failure ?? 'unknown'}`,
      ])
      // The policy maximizes, so a failure is scored at the seed's own speedup of 1
      // and a success at its measured speedup.
      scoreOf.set(nodeId, evaluation.speedup ?? 1)
      return { outcome, node: toNode(nodeId, parentId, branch, attemptIndex, nextSibling(siblings, parentId), outcome) }
    }

    // Drive the policy over a tree it can only see as it is revealed. The policy
    // selects node ids; this driver executes them and extends the tree.
    // The budget both arms obey, expressed once: every branch is opened and
    // refined the same number of times, so a quality difference is the policy's.
    const attemptBudget = grid.branchCount * (grid.refineCount + 1)
    const run = await policyRun(policy, {
      roundLimit: options.decisionRoundLimit ?? 64,
      maxParallelism: options.maxParallelism,
      grid,
      budgetExhausted: question => question.revealedCount >= attemptBudget,
      execute: async (selected: readonly string[]) => {
        // The implicit root means "open a new branch"; anything else continues an
        // existing node. Both become attempts, which is what the budget counts.
        const work = selected.map(selectedId => {
          if (selectedId === IMPLICIT_ROOT) {
            const branch = siblings.size
            void branch
            return { parentId: undefined as string | undefined }
          }
          return { parentId: selectedId as string | undefined }
        })
        const created: RecordedNode[] = []
        for (let index = 0; index < work.length; index += 1) {
          const entry = work[index]!
          const parentId = entry.parentId
          const branch = parentId === undefined
            ? nodes.filter(node => node.parent === undefined).length + index
            : nodes.find(node => node.nodeId === parentId)?.branch ?? 0
          const done = await attempt(parentId, branch, index)
          nodes.push(done.node)
          attempts.push(done.outcome)
          created.push(done.node)
        }
        return created.map(node => node.nodeId)
      },
    })

    const roundBest = attempts.reduce<number | undefined>(
      (best, entry) => entry.speedup === undefined ? best : Math.max(best ?? 0, entry.speedup),
      undefined,
    )
    if (roundBest !== undefined) bestSpeedup = Math.max(bestSpeedup ?? 0, roundBest)

    const roundRecord: ArmRound = {
      round,
      policyId: policy.id,
      attempts,
      ...roundBest === undefined ? {} : { bestSpeedup: roundBest },
      agentCalls: attempts.length,
      providerCalls: attempts.filter(entry => entry.modelCalled).length,
      promptTokens: attempts.reduce((sum, entry) => sum + entry.promptTokens, 0),
      completionTokens: attempts.reduce((sum, entry) => sum + entry.completionTokens, 0),
      wallMs: Date.now() - roundStarted,
      decisionRounds: run.roundCount,
    }
    rounds.push(roundRecord)
    allNodes.push(...nodes)
    agentCalls += attempts.length
    worlds.push(new ReplayWorld(nodes.map(node => ({
      ...node,
      // The policy's score axis is speedup; a failed attempt is 1, the seed's own.
      score: scoreOf.get(node.nodeId) ?? 1,
      status: scoreOf.get(node.nodeId) === undefined ? 'failed' : node.status,
    }))))

    // Report which policies were in play this round, with the score they hold.
    deployed[deployed.length - 1] = {
      round,
      policyId: policy.id,
      ...(scoreOf.size === 0 ? {} : { score: [...scoreOf.values()].reduce((a, b) => Math.max(a, b), 0) }),
    }
    options.onRound?.(roundRecord, nodes)
  }

  return {
    armId: options.armId,
    model: options.client.model,
    rounds,
    ...bestSpeedup === undefined ? {} : { bestSpeedup },
    agentCalls,
    providerCalls,
    promptTokens,
    completionTokens,
    cachedPromptTokens,
    nodes: allNodes,
    deployed,
  }
}

/** Allocate the next sibling index for a parent. */
function nextSibling(siblings: Map<string, number>, parentId: string | undefined): number {
  const key = parentId ?? 'root'
  const value = siblings.get(key) ?? 0
  siblings.set(key, value + 1)
  return value
}

/** Build a recorded node from an attempt's outcome. */
function toNode(
  nodeId: string,
  parentId: string | undefined,
  branch: number,
  attemptIndex: number,
  siblingOrder: number,
  outcome: AttemptOutcome,
): RecordedNode {
  return {
    nodeId,
    ...parentId === undefined ? {} : { parent: parentId },
    branch,
    attempt: attemptIndex,
    siblingOrder,
    turns: 1,
    status: outcome.correct ? 'scored' : 'failed',
    ...outcome.speedup === undefined ? {} : { score: outcome.speedup },
  }
}

/**
 * The online prefix question: the policy's view of a tree that does not exist yet.
 *
 * The policy package's own question is built over a *recorded* world, which is the
 * right shape for offline replay: the whole tree is known and revealing it is a
 * matter of walking it. An online round is the other direction — each selection has
 * to be executed before the next decision — so the revealed set grows as attempts
 * finish.
 *
 * The prefix-only rule is identical either way, which is the point: a policy cannot
 * tell the two apart, so a policy that behaves well offline behaves the same online.
 * This class enforces that by exposing no accessor for an unrevealed node.
 */
class OnlinePrefixQuestion implements PrefixQuestion {
  private readonly revealedIds = new Set<string>()
  private readonly revealedOrder: string[] = []
  private decisionRounds = 0

  constructor(
    private readonly budget: { readonly branchCount: number; readonly refineCount: number },
    readonly maxParallelism: number,
    readonly baselineScore: number | undefined,
  ) {}

  /** Nodes whose selection would produce an attempt this round. */
  legalActions(): readonly string[] {
    const legal: string[] = []
    // The implicit root is selectable while the grid still has an unopened branch.
    if (this.revealedOrder.length < this.budget.branchCount) legal.push(IMPLICIT_ROOT)
    // Every revealed node may be continued: its child does not exist yet, which is
    // exactly the online case.
    legal.push(...this.revealedOrder)
    return [...new Set(legal)]
  }

  legalRoots(): readonly string[] {
    return this.revealedOrder.length < this.budget.branchCount ? ['root'] : []
  }

  openedBranches(): readonly string[] {
    return this.revealedOrder.slice(0, this.budget.branchCount)
  }

  get roundCount(): number {
    return this.decisionRounds
  }

  get exhausted(): boolean {
    // An online tree is never exhausted: a node can always be continued. The budget,
    // not exhaustion, ends an online round.
    return false
  }

  observed(): Readonly<Record<string, PrefixObservation>> {
    const out: Record<string, PrefixObservation> = {}
    for (const nodeId of this.revealedOrder) {
      out[nodeId] = {
        nodeId,
        branch: 0,
        attempt: 0,
        turns: 1,
        status: 'scored',
      }
    }
    return out
  }

  /** Record the nodes an executed batch produced, and count the decision round. */
  reveal(nodeIds: readonly string[]): void {
    this.decisionRounds += 1
    for (const nodeId of nodeIds) this.revealedIds.add(nodeId)
    this.revealedOrder.push(...nodeIds)
  }

  /** Whether a node has been revealed to this question. */
  hasRevealed(nodeId: string): boolean {
    return this.revealedIds.has(nodeId)
  }

  /** How many nodes the policy's own decisions have revealed. */
  get revealedCount(): number {
    return this.revealedOrder.length
  }
}

/**
 * Run a policy over a tree that is revealed as its selections execute.
 *
 * The policy package's own `runPolicy` replays a *recorded* world. An online round
 * cannot, so this drives the loop with the same prefix-only question semantics:
 * the policy selects node ids, the driver executes them, and the revealed set grows.
 * @param policy - the policy under test.
 * @param options - the budget, the parallelism cap, and the executor.
 * @returns how many decision rounds the policy took.
 */
async function policyRun(
  policy: ExplorationPolicy,
  options: {
    readonly roundLimit: number
    readonly maxParallelism: number
    readonly grid: { readonly branchCount: number; readonly refineCount: number }
    readonly execute: (selected: readonly string[]) => Promise<readonly string[]>
    /** Stop early when the round's attempt budget is spent. */
    readonly budgetExhausted?: (question: OnlinePrefixQuestion) => boolean
  },
): Promise<{ readonly roundCount: number }> {
  const question = new OnlinePrefixQuestion(options.grid, options.maxParallelism, 1)
  let rounds = 0
  for (; rounds < options.roundLimit; rounds += 1) {
    const selected = policy.selectBatch(question)
    if (selected.length === 0) break
    const created = await options.execute(selected)
    if (created.length === 0) break
    question.reveal(created)
    if (options.budgetExhausted?.(question) === true) break
  }
  return { roundCount: question.roundCount }
}

/**
 * The dream arm's policy selection: score every candidate by replay and deploy the
 * best.
 *
 * Exported so a report can show the selection reasoning, and so the experiment can
 * run this step without the rest of the arm.
 * @param worlds - every tree recorded so far.
 * @param candidates - the policies to choose among.
 * @param beta - replay score coefficients.
 * @returns the winning policy and every evaluation, best first.
 */
export function selectByDreaming(
  worlds: readonly ReplayWorld[],
  candidates: readonly ExplorationPolicy[],
  beta: { readonly cost: number; readonly parallelism: number },
): { readonly selected: ExplorationPolicy; readonly evaluations: readonly PolicyEvaluation[] } {
  if (worlds.length === 0 || candidates.length === 0) {
    const fallback = candidates[0]
    if (fallback === undefined) throw new Error('the dream arm needs at least one candidate policy')
    return { selected: fallback, evaluations: [] }
  }
  const evaluations = candidates.map(candidate =>
    evaluatePolicy(worlds, candidate, beta, { roundLimit: 64 }))
  // `dream`'s selection rule, applied to a fixed candidate pool: the pool includes
  // the incumbent, so the deployed policy is never worse on the recorded history.
  const best = evaluations.reduce((left, right) =>
    (right.meanScore ?? -Infinity) > (left.meanScore ?? -Infinity) ? right : left)
  const selected = candidates.find(candidate => candidate.id === best.policyId) ?? candidates[0]!
  return { selected, evaluations }
}

export { PolicyStore, dream }
