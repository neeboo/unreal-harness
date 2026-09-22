/**
 * The replay engine: a deterministic walk over an already-recorded discovery
 * tree, plus the prefix-only question a policy answers.
 *
 * This is the whole of "dreaming". No model is called and no attempt is
 * executed: revealing a selected node returns the outcome history already
 * recorded for its child. Two invariants make that well defined.
 *
 * - **Determinism.** Replay returns recorded children rather than generating
 *   candidates, so the same policy over the same world always produces the same
 *   trajectory.
 * - **Prefix-only.** {@link PrefixQuestion.observed} exposes revealed nodes
 *   only, and {@link PrefixQuestion.probeBatch} is the single channel that
 *   reveals more. A policy therefore cannot read an unrevealed score, which is
 *   what makes evaluating it offline a valid prediction of running it online.
 *
 * The asymmetric child rule is history's, not this module's: it is how the
 * recorded tree was produced.
 * @module @deepseek-ai/dsh-rsi-trace/replay
 */

import type { DiscoveryNode } from './types.ts'
import type {
  NodeBatch,
  ReplayObservation,
  ReplayResult,
  ReplayRound,
  ReplayStopReason,
} from './replay-types.ts'

/**
 * Reserved handle for the implicit initial workspace.
 *
 * The root of a discovery tree is a workspace state, not an attempt, so it has
 * no node of its own: selecting this handle opens the next recorded branch.
 * Reserved because the handle travels through policy code as a plain string.
 */
export const IMPLICIT_ROOT = 'root'

/** Why a world cannot be interpreted as a replay world. */
export class ReplayWorldError extends Error {
  override readonly name = 'ReplayWorldError'

  constructor(
    readonly code: 'branching-node' | 'cycle' | 'unknown-node' | 'reserved-id',
    message: string,
  ) {
    super(message)
  }
}

/**
 * One recorded discovery tree, indexed for deterministic replay.
 *
 * Construct it from a session's folded nodes. The world is immutable: replaying
 * it never changes it, so many policies can be evaluated against the same
 * instance.
 */
export class ReplayWorld {
  private readonly byId: ReadonlyMap<string, DiscoveryNode>
  private readonly childrenOf: ReadonlyMap<string, readonly DiscoveryNode[]>
  /** Root node ids in creation order — the order branch-opening probes consume. */
  readonly rootIds: readonly string[]
  /** Total recorded nodes, roots included. */
  readonly size: number

  constructor(nodes: readonly DiscoveryNode[]) {
    const byId = new Map<string, DiscoveryNode>()
    for (const node of nodes) {
      if (node.nodeId === IMPLICIT_ROOT) {
        throw new ReplayWorldError(
          'reserved-id',
          `node id "${IMPLICIT_ROOT}" is reserved for the implicit initial workspace`,
        )
      }
      if (byId.has(node.nodeId)) {
        throw new ReplayWorldError('unknown-node', `duplicate node id: ${node.nodeId}`)
      }
      byId.set(node.nodeId, node)
    }

    const children = new Map<string, DiscoveryNode[]>()
    const roots: DiscoveryNode[] = []
    for (const node of nodes) {
      if (node.parent === undefined) {
        roots.push(node)
        continue
      }
      if (!byId.has(node.parent)) {
        throw new ReplayWorldError('unknown-node', `node ${node.nodeId} names absent parent ${node.parent}`)
      }
      const siblings = children.get(node.parent)
      if (siblings === undefined) children.set(node.parent, [node])
      else siblings.push(node)
    }

    // Children are ordered by the recorded sibling order, and a tie falls back to
    // creation position so the order is always total and deterministic.
    for (const siblings of children.values()) {
      siblings.sort((left, right) => left.siblingOrder - right.siblingOrder || left.seq - right.seq)
    }
    roots.sort((left, right) => left.siblingOrder - right.siblingOrder || left.seq - right.seq)

    // Non-root nodes must have at most one recorded child. Replay can only walk a
    // branch in its recorded parent–child order, so a branched internal node has
    // no defined deterministic successor; refusing loudly beats picking one and
    // silently evaluating a different world than the log describes.
    // Each recorded attempt produces exactly one child, so EVERY node — roots
    // included — has at most one. A branched node has no deterministic
    // successor, and picking one would silently replay a different world than
    // the log describes.
    for (const [parentId, siblings] of children) {
      if (siblings.length > 1) {
        throw new ReplayWorldError(
          'branching-node',
          `node ${parentId} has ${siblings.length} recorded children; replay needs at most one per parent`,
        )
      }
    }

    this.byId = byId
    this.rootIds = roots.map(node => node.nodeId)
    this.childrenOf = children
    this.size = nodes.length
  }

  /** Look up a recorded node. */
  node(nodeId: string): DiscoveryNode | undefined {
    return this.byId.get(nodeId)
  }

  /** Recorded children of a node, in recorded order. */
  children(nodeId: string): readonly DiscoveryNode[] {
    return this.childrenOf.get(nodeId) ?? []
  }

  /** Whether a node is a root (no parent). */
  isRoot(nodeId: string): boolean {
    return this.byId.get(nodeId)?.parent === undefined
  }
}

function observe(node: DiscoveryNode): ReplayObservation {
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
 * The prefix-only question one policy answers against one world.
 *
 * One instance per policy–world evaluation. It carries the revealed set, so a
 * policy's decisions can only ever follow what that instance has revealed:
 * there is no accessor that returns an unrevealed observation.
 */
export class PrefixQuestion {
  private readonly revealedIds = new Set<string>()
  private readonly revealedOrder: string[] = []
  /** Decision rounds completed — one per accepted non-empty batch. */
  private completedRounds = 0

  constructor(
    private readonly world: ReplayWorld,
    /** Round limit. `undefined` means no limit beyond exhaustion. */
    private readonly roundLimit?: number,
  ) {}

  /** Revealed observations, keyed by node id. Only the revealed prefix. */
  observed(): Readonly<Record<string, ReplayObservation>> {
    const out: Record<string, ReplayObservation> = {}
    for (const nodeId of this.revealedOrder) {
      const node = this.world.node(nodeId)
      if (node !== undefined) out[nodeId] = observe(node)
    }
    return out
  }

  /** Revealed node ids in reveal order. */
  revealed(): readonly string[] {
    return [...this.revealedOrder]
  }

  /**
   * Nodes a policy may legally select this round: every revealed node whose
   * recorded continuation is still unrevealed, plus any root not yet opened.
   */
  /**
   * Nodes a policy may legally select this round: exactly those whose selection
   * would reveal a node.
   *
   * Defining it that way — rather than as "plausible-looking" nodes — is what
   * guarantees a non-empty batch always makes progress, so a policy that keeps
   * selecting legal actions terminates instead of stalling.
   */
  legalActions(): readonly string[] {
    const legal: string[] = []
    // The implicit root, while some recorded branch still has an unrevealed node.
    // Pure query: the handle is consumed by probing it, not by asking whether it
    // is available.
    if (this.nextRootChild() !== undefined) legal.push(IMPLICIT_ROOT)
    // Every revealed node — branch heads included — while its own recorded
    // continuation is still unrevealed. In the observed tree these are exactly
    // the leaves, plus the implicit root handled above.
    for (const nodeId of this.revealedOrder) {
      const child = this.world.children(nodeId)[0]
      if (child !== undefined && !this.revealedIds.has(child.nodeId)) legal.push(nodeId)
    }
    return [...new Set(legal)]
  }

  /**
   * Branch heads not yet opened — the implicit root's recorded children in
   * creation order.
   */
  legalRoots(): readonly string[] {
    return this.world.rootIds.filter(rootId => !this.branchOpened(rootId))
  }

  /** Branch heads opened so far, in creation order. */
  openedBranches(): readonly string[] {
    return this.world.rootIds.filter(rootId => this.branchOpened(rootId))
  }

  /** A branch is open once its head or any of its descendants is revealed. */
  private branchOpened(rootId: string): boolean {
    return this.revealedIds.has(rootId)
      || this.world.children(rootId).some(child => this.revealedIds.has(child.nodeId))
  }

  /** Completed decision rounds. */
  get roundCount(): number {
    return this.completedRounds
  }

  /** Every recorded node has been revealed. */
  get exhausted(): boolean {
    return this.revealedIds.size >= this.world.size
  }

  /**
   * Reveal the recorded outcomes of a selected batch.
   *
   * A selected node contributes its child per the recorded rule: a non-root node
   * contributes its single recorded child, and a root contributes the
   * earliest-created branch not yet opened. A node with no remaining recorded
   * continuation contributes nothing — history had nothing there, which is a
   * fact about the world rather than a policy failure.
   *
   * @param batch - node ids to continue from.
   * @returns the observations revealed by this call, in batch order.
   * @throws when the batch is illegal under {@link legalActions} or exceeds one round.
   */
  probeBatch(batch: NodeBatch): readonly ReplayObservation[] {
    if (batch.length === 0) return []

    const legal = new Set(this.legalActions())
    const seen = new Set<string>()
    for (const nodeId of batch) {
      // A repeated entry would reveal one node twice and silently shrink the
      // trajectory's cost, so a batch must name distinct nodes.
      if (seen.has(nodeId)) {
        throw new ReplayWorldError('unknown-node', `duplicate batch entry: ${nodeId}`)
      }
      seen.add(nodeId)
      if (!legal.has(nodeId)) {
        throw new ReplayWorldError('unknown-node', `illegal batch entry: ${nodeId}`)
      }
    }

    const revealed: ReplayObservation[] = []
    for (const nodeId of batch) {
      const child = this.childFor(nodeId)
      if (child === undefined) continue
      this.revealedIds.add(child.nodeId)
      this.revealedOrder.push(child.nodeId)
      revealed.push(observe(child))
    }
    this.completedRounds += 1
    return revealed
  }

  /** Whether the round limit has been reached. */
  get roundLimitReached(): boolean {
    return this.roundLimit !== undefined && this.completedRounds >= this.roundLimit
  }

  /**
   * The earliest-created root child still unrevealed, or `undefined` when every
   * recorded branch is open.
   */
  private nextRootChild(): DiscoveryNode | undefined {
    // A branch "counts as opened" once ANY of its nodes is revealed. Deepening an
    // opened branch is a different action — selecting that branch's frontier —
    // so the implicit root's job is strictly to open the next untouched branch,
    // in creation order.
    // A branch counts as OPEN once the head itself or any of its descendants is
    // revealed. Deepening an opened branch is a different action — selecting that
    // branch's frontier — so the implicit root's job is strictly to open the next
    // untouched branch, in creation order.
    const nextRoot = this.world.rootIds.find(rootId => !this.branchOpened(rootId))
    return nextRoot === undefined ? undefined : this.world.node(nextRoot)
  }

  private childFor(nodeId: string): DiscoveryNode | undefined {
    // ONLY the reserved handle opens a branch. A revealed branch head is an
    // ordinary node: its continuation is its own recorded child, and its parent
    // is the implicit workspace — not itself a branch-opening action.
    if (nodeId === IMPLICIT_ROOT) {
      // Opening a branch consumes the earliest-created untouched branch, in
      // creation order — never score order. The handle stays available for as
      // long as any branch is untouched, and availability ends on its own when
      // none is: there is no separate "already opened" flag to keep in step.
      return this.nextRootChild()
    }
    const child = this.world.children(nodeId)[0]
    if (child === undefined || this.revealedIds.has(child.nodeId)) return undefined
    return child
  }
}

/**
 * Evaluate one policy against one world.
 *
 * The policy is a function from the prefix-only question to a batch per round.
 * It is called until it returns an empty batch, the round limit is reached, or
 * every recorded node has been revealed.
 *
 * @param world - the recorded tree to replay.
 * @param policy - the policy under evaluation.
 * @param options - optional round limit.
 * @returns the trajectory and its derived measurements.
 */
export function replay(
  world: ReplayWorld,
  policy: (question: PrefixQuestion) => NodeBatch,
  options: { roundLimit?: number } = {},
): ReplayResult {
  const question = new PrefixQuestion(world, options.roundLimit)
  const rounds: ReplayRound[] = []
  let stopReason: ReplayStopReason = 'exhausted'

  for (;;) {
    if (question.exhausted) { stopReason = 'exhausted'; break }
    if (question.roundLimitReached) { stopReason = 'round-limit'; break }
    const requested = policy(question)
    if (requested.length === 0) { stopReason = 'empty-batch'; break }
    const revealed = question.probeBatch(requested)
    rounds.push({
      index: rounds.length,
      requested: [...requested],
      revealed: revealed.map(observation => observation.nodeId),
    })
    // A round that revealed nothing ends the rollout. Selecting an already
    // consumed branch is a legal, well-formed decision that simply has no
    // recorded continuation, and replay must not loop on it: the paper's stop
    // condition is an empty decision, and a no-progress round IS empty in the
    // only sense replay can observe.
    if (revealed.length === 0) { stopReason = 'empty-batch'; break }
  }

  const revealedNodeIds = question.revealed()
  let bestScore: number | undefined
  for (const nodeId of revealedNodeIds) {
    const score = world.node(nodeId)?.score
    if (score === undefined) continue
    if (bestScore === undefined || score > bestScore) bestScore = score
  }

  // Every revealed id is a real attempt; the implicit root is not an id.
  const revealedNodeCount = revealedNodeIds.length

  return {
    rounds,
    revealedNodeIds,
    revealedNodeCount,
    roundCount: question.roundCount,
    bestScore,
    stopReason,
  }
}

/**
 * The paper's replay score: quality, minus attempted work, plus a parallelism
 * bonus.
 *
 * `V = bestScore − β₁·N + β₂·N / max(1, rounds)`, where `N` is the count of
 * revealed non-root nodes — the generation-evaluation requests the trajectory
 * represents. The third term rewards batching useful continuations rather than
 * running them one per round.
 * @param result - a replay trajectory.
 * @param beta - cost and parallelism coefficients.
 * @returns the replay score, or `undefined` when the trajectory scored nothing.
 */
export function replayScore(
  result: ReplayResult,
  beta: { cost: number; parallelism: number },
): number | undefined {
  if (result.bestScore === undefined) return undefined
  const n = result.revealedNodeCount
  const rounds = Math.max(1, result.roundCount)
  return result.bestScore - beta.cost * n + beta.parallelism * (n / rounds)
}

/**
 * Build a replay world from a flat node list.
 * @param nodes - every node of the tree, branch heads included.
 * @returns an immutable world indexed for deterministic replay.
 */
export function replayWorldFromNodes(nodes: readonly DiscoveryNode[]): ReplayWorld {
  return new ReplayWorld(nodes)
}

/**
 * Build a replay world from a tree that includes the hosting session's marker.
 *
 * A run records its own root marker: the first attempt continues the initial
 * workspace, which in dsh IS the session hosting the run. That marker is a node
 * in the log, but the implicit workspace is a handle in replay, so this adapter
 * drops the marker and promotes its direct children to branch heads.
 *
 * The translation lives here rather than in each caller because the mapping is a
 * modelling decision about what a recorded tree MEANS. A caller that gets it
 * wrong still produces a well-formed world, which then replays the wrong tree
 * with no error at all.
 * @param hostSessionId - node id of the hosting session's own marker.
 * @param nodes - every node recorded for the run, marker included.
 * @returns an immutable world indexed for deterministic replay.
 */
export function replayWorldFromTree(
  hostSessionId: string,
  nodes: readonly DiscoveryNode[],
): ReplayWorld {
  const translated: DiscoveryNode[] = []
  for (const node of nodes) {
    if (node.nodeId === hostSessionId) continue
    if (node.parent !== hostSessionId) { translated.push(node); continue }
    // `exactOptionalPropertyTypes`: an absent parent is an omitted key.
    const { parent: _host, ...head } = node
    translated.push(head)
  }
  return new ReplayWorld(translated)
}
