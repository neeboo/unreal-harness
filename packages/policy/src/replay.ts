/**
 * The replay runner: evaluate a policy against a recorded world without
 * executing anything.
 *
 * This is the mechanism that makes exploration improvable at all. One expensive
 * online run produces a tree of recorded attempts; because every outcome is
 * already in the tree, a *different* strategy for allocating effort can be
 * scored by walking that tree — no model call, no attempt, no evaluator. The
 * history becomes a simulator.
 *
 * # The rules that make replay well defined
 *
 * - **Selection reveals; it never generates.** A selected non-root node yields
 *   its single recorded child; the implicit root yields the earliest-created
 *   untouched branch. Nothing outside the recorded tree is reachable, which is
 *   also the honest limit of the method.
 * - **Legal actions are exactly those whose selection reveals something.** Defined
 *   that way, a non-empty batch always makes progress, so a policy that keeps
 *   selecting legal actions terminates instead of stalling.
 * - **A batch is validated against the round's starting state**, so it cannot
 *   depend on what the same round reveals.
 * - **Every node has at most one recorded child.** A branched node has no
 *   deterministic successor, so the world refuses it rather than replaying a
 *   different tree than the log describes.
 * @module
 */

import type {
  ExplorationPolicy,
  PolicyRun,
  PrefixObservation,
  PrefixQuestion,
  StopReason,
} from './types.ts'
import { IMPLICIT_ROOT } from './types.ts'

/** One node of a recorded discovery tree. */
export interface RecordedNode {
  readonly nodeId: string
  /** Parent node id, absent for a branch head. */
  readonly parent?: string
  readonly branch: number
  readonly attempt: number
  /**
   * Creation order among siblings.
   *
   * The replay rule opens branches in CREATION order, never score order, so this
   * is load-bearing rather than cosmetic.
   */
  readonly siblingOrder: number
  readonly turns: number
  readonly status: 'open' | 'scored' | 'failed'
  readonly score?: number
}

/** Why a recorded tree cannot be replayed. */
export class ReplayWorldError extends Error {
  override readonly name = 'ReplayWorldError'

  constructor(
    readonly code: 'branching-node' | 'unknown-parent' | 'duplicate-id' | 'reserved-id',
    message: string,
  ) {
    super(message)
  }
}

/**
 * A recorded discovery tree, indexed for deterministic replay.
 *
 * Immutable once built, so many policies can be scored against one instance —
 * which is the economics of the whole method.
 */
export class ReplayWorld {
  private readonly byId: ReadonlyMap<string, RecordedNode>
  private readonly children: ReadonlyMap<string, readonly RecordedNode[]>
  /** Branch heads in creation order. */
  readonly rootIds: readonly string[]
  readonly size: number
  /**
   * The highest score recorded anywhere in the tree.
   *
   * This is the ceiling a replay can reach: no strategy over this history can
   * reveal a score that was never recorded. `replayScore` measures an
   * allocation against its own revealed best, so comparing the two answers the
   * question a benchmark actually asks — did this strategy find what the
   * history already contained?
   */
  readonly bestScore: number | undefined

  constructor(nodes: readonly RecordedNode[]) {
    const byId = new Map<string, RecordedNode>()
    for (const node of nodes) {
      if (node.nodeId === IMPLICIT_ROOT) {
        throw new ReplayWorldError(
          'reserved-id',
          `node id "${IMPLICIT_ROOT}" is reserved for the implicit initial workspace`,
        )
      }
      if (byId.has(node.nodeId)) {
        throw new ReplayWorldError('duplicate-id', `duplicate node id: ${node.nodeId}`)
      }
      byId.set(node.nodeId, node)
    }

    const children = new Map<string, RecordedNode[]>()
    const roots: RecordedNode[] = []
    for (const node of nodes) {
      if (node.parent === undefined) {
        roots.push(node)
        continue
      }
      if (!byId.has(node.parent)) {
        throw new ReplayWorldError(
          'unknown-parent',
          `node ${node.nodeId} names absent parent ${node.parent}`,
        )
      }
      const siblings = children.get(node.parent)
      if (siblings === undefined) children.set(node.parent, [node])
      else siblings.push(node)
    }

    for (const siblings of children.values()) {
      siblings.sort((left, right) => left.siblingOrder - right.siblingOrder)
    }
    roots.sort((left, right) => left.siblingOrder - right.siblingOrder)

    // Each recorded attempt produces exactly one child, so EVERY node — branch
    // heads included — has at most one. A branched node has no deterministic
    // successor, and picking one would silently replay a different tree than the
    // log describes.
    for (const [parentId, siblings] of children) {
      if (siblings.length > 1) {
        throw new ReplayWorldError(
          'branching-node',
          `node ${parentId} has ${siblings.length} recorded children; replay needs at most one per parent`,
        )
      }
    }

    this.byId = byId
    this.children = children
    this.rootIds = roots.map(node => node.nodeId)
    this.size = nodes.length

    let ceiling: number | undefined
    for (const node of nodes) {
      if (node.score === undefined) continue
      if (ceiling === undefined || node.score > ceiling) ceiling = node.score
    }
    this.bestScore = ceiling
  }

  /** Look up a recorded node. */
  node(nodeId: string): RecordedNode | undefined {
    return this.byId.get(nodeId)
  }

  /** Recorded children of a node, in recorded order. */
  childrenOf(nodeId: string): readonly RecordedNode[] {
    return this.children.get(nodeId) ?? []
  }

  /** Whether a node is a branch head. */
  isRoot(nodeId: string): boolean {
    return this.byId.get(nodeId)?.parent === undefined
  }
}

/** How one replay is bounded. */
export interface ReplayOptions {
  /** Maximum decision rounds. Unlimited by default. */
  readonly roundLimit?: number
  /** Continuations allowed per batch. Unlimited by default. */
  readonly maxParallelism?: number
  /** Baseline score the task defines, if any. */
  readonly baselineScore?: number
}

/**
 * The prefix-only environment one policy answers.
 *
 * Carries the revealed set, so a policy's decisions can only follow what this
 * instance revealed. There is no accessor for an unrevealed observation, which is
 * what makes the offline score a valid prediction rather than a privileged peek.
 */
class PrefixOnlyQuestion implements PrefixQuestion {
  private readonly revealedIds = new Set<string>()
  private readonly revealedOrder: string[] = []
  private rounds = 0

  constructor(
    private readonly world: ReplayWorld,
    readonly maxParallelism: number,
    readonly baselineScore: number | undefined,
  ) {}

  observed(): Readonly<Record<string, PrefixObservation>> {
    const out: Record<string, PrefixObservation> = {}
    for (const nodeId of this.revealedOrder) {
      const node = this.world.node(nodeId)
      if (node !== undefined) out[nodeId] = observe(node)
    }
    return out
  }

  legalActions(): readonly string[] {
    const legal: string[] = []
    if (this.nextRootChild() !== undefined) legal.push(IMPLICIT_ROOT)
    for (const nodeId of this.revealedOrder) {
      const child = this.world.childrenOf(nodeId)[0]
      if (child !== undefined && !this.revealedIds.has(child.nodeId)) legal.push(nodeId)
    }
    return [...new Set(legal)]
  }

  legalRoots(): readonly string[] {
    return this.world.rootIds.filter(rootId => !this.branchOpened(rootId))
  }

  openedBranches(): readonly string[] {
    return this.world.rootIds.filter(rootId => this.branchOpened(rootId))
  }

  get roundCount(): number {
    return this.rounds
  }

  get exhausted(): boolean {
    return this.revealedIds.size >= this.world.size
  }

  /** Revealed node ids in reveal order. */
  revealed(): readonly string[] {
    return [...this.revealedOrder]
  }

  /** A branch is open once its head or any descendant is revealed. */
  private branchOpened(rootId: string): boolean {
    return this.revealedIds.has(rootId)
      || this.world.childrenOf(rootId).some(child => this.revealedIds.has(child.nodeId))
  }

  private nextRootChild(): RecordedNode | undefined {
    // A branch counts as open once the head itself or any descendant is
    // revealed. Deepening an opened branch is a different action, so the
    // implicit root's job is strictly to open the next untouched branch, in
    // creation order.
    const nextRoot = this.world.rootIds.find(rootId => !this.branchOpened(rootId))
    return nextRoot === undefined ? undefined : this.world.node(nextRoot)
  }

  /**
   * Reveal the recorded outcomes of a selected batch.
   *
   * @param batch - node ids to continue from.
   * @returns the observations revealed, in batch order.
   * @throws {ReplayWorldError} when the batch is illegal, unknown, or repeated.
   */
  probe(batch: readonly string[]): readonly PrefixObservation[] {
    if (batch.length === 0) return []

    if (this.maxParallelism !== Number.POSITIVE_INFINITY && batch.length > this.maxParallelism) {
      throw new ReplayWorldError(
        'branching-node',
        `batch of ${batch.length} exceeds the parallelism limit ${this.maxParallelism}`,
      )
    }

    const legal = new Set(this.legalActions())
    const seen = new Set<string>()
    for (const nodeId of batch) {
      if (seen.has(nodeId)) {
        throw new ReplayWorldError('duplicate-id', `duplicate batch entry: ${nodeId}`)
      }
      seen.add(nodeId)
      if (!legal.has(nodeId)) {
        throw new ReplayWorldError('unknown-parent', `illegal batch entry: ${nodeId}`)
      }
    }

    const revealed: PrefixObservation[] = []
    for (const nodeId of batch) {
      const child = this.childFor(nodeId)
      if (child === undefined) continue
      this.revealedIds.add(child.nodeId)
      this.revealedOrder.push(child.nodeId)
      revealed.push(observe(child))
    }
    this.rounds += 1
    return revealed
  }

  private childFor(nodeId: string): RecordedNode | undefined {
    // ONLY the reserved handle opens a branch. A revealed branch head is an
    // ordinary node: its continuation is its own recorded child.
    if (nodeId === IMPLICIT_ROOT) return this.nextRootChild()
    const child = this.world.childrenOf(nodeId)[0]
    if (child === undefined || this.revealedIds.has(child.nodeId)) return undefined
    return child
  }
}

function observe(node: RecordedNode): PrefixObservation {
  return {
    nodeId: node.nodeId,
    branch: node.branch,
    attempt: node.attempt,
    turns: node.turns,
    status: node.status,
    ...node.score === undefined ? {} : { score: node.score },
  }
}

/**
 * Run one policy against one world.
 *
 * The policy is called until it asks for an empty batch, the round limit is
 * reached, or every recorded node has been revealed. A round that reveals
 * nothing also ends the run: selecting an already-consumed continuation is a
 * well-formed decision with nothing behind it, and looping on it would hang.
 * @param world - the recorded tree to replay.
 * @param policy - the policy under evaluation.
 * @param options - round and parallelism limits, and a baseline.
 * @returns the trajectory and its derived measurements.
 */
export function runPolicy(
  world: ReplayWorld,
  policy: ExplorationPolicy,
  options: ReplayOptions = {},
): PolicyRun {
  const maxParallelism = options.maxParallelism ?? Number.POSITIVE_INFINITY
  const question = new PrefixOnlyQuestion(world, maxParallelism, options.baselineScore)
  const rounds: PolicyRun['rounds'][number][] = []
  let stopReason: StopReason = 'exhausted'

  for (;;) {
    if (question.exhausted) { stopReason = 'exhausted'; break }
    if (options.roundLimit !== undefined && question.roundCount >= options.roundLimit) {
      stopReason = 'round-limit'
      break
    }
    const requested = policy.selectBatch(question)
    if (requested.length === 0) { stopReason = 'empty-batch'; break }
    const revealed = question.probe(requested)
    rounds.push({
      index: rounds.length,
      requested: [...requested],
      revealed: revealed.map(observation => observation.nodeId),
    })
    if (revealed.length === 0) { stopReason = 'empty-batch'; break }
  }

  const revealedNodeIds = question.revealed()
  let bestScore: number | undefined
  for (const nodeId of revealedNodeIds) {
    const score = world.node(nodeId)?.score
    if (score === undefined) continue
    if (bestScore === undefined || score > bestScore) bestScore = score
  }

  return {
    rounds,
    revealedNodeIds,
    revealedNodeCount: revealedNodeIds.length,
    roundCount: rounds.length,
    bestScore,
    stopReason,
  }
}

/**
 * The replay score: quality, minus attempted work, plus a parallelism bonus.
 *
 * `V = bestScore − β₁·N + β₂·N / max(1, rounds)`, where `N` is the number of
 * revealed non-root nodes — the generation–evaluation requests the trajectory
 * represents. Replay executes nothing, so `N` is a proxy for what the trajectory
 * would have cost online, and it is the only honest denominator for comparing
 * two allocations of effort.
 *
 * The third term is why batching matters: the same revealed work in fewer rounds
 * scores higher.
 * @param run - a replay trajectory.
 * @param beta - cost and parallelism coefficients.
 * @returns the score, or `undefined` when the trajectory produced no score.
 */
export function replayScore(
  run: PolicyRun,
  beta: { readonly cost: number; readonly parallelism: number },
): number | undefined {
  if (run.bestScore === undefined) return undefined
  const n = run.revealedNodeCount
  const rounds = Math.max(1, run.roundCount)
  return run.bestScore - beta.cost * n + beta.parallelism * (n / rounds)
}
