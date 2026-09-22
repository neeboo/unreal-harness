/**
 * Replay vocabulary: the decision interface an exploration policy sees, and the
 * deterministic world it is evaluated against.
 *
 * The interface is deliberately the policy's whole world. A policy batch names
 * nodes to continue from; the world answers with the outcomes ALREADY RECORDED
 * for those nodes' children. Nothing is generated, so an evaluation costs no
 * discovery work — and, just as important, nothing outside the recorded
 * subtree is reachable, so a policy can only be dreamt where history went.
 * @module @deepseek-ai/dsh-rsi-trace/replay-types
 */

import type { DiscoveryNode } from './types.ts'

/**
 * One node's outcome as an exploration policy may observe it.
 *
 * Every field is a settled fact from the recorded tree. A policy that reaches
 * this value has already been granted the reveal — the world never hands out an
 * observation for an unrevealed node.
 */
export interface ReplayObservation {
  readonly nodeId: string
  /** Branch index within the parent, or `-1` for a root. */
  readonly branch: number
  /** Attempt index along that branch, or `-1` for a root. */
  readonly attempt: number
  /** Completed turns the attempt consumed. */
  readonly turns: number
  readonly status: DiscoveryNode['status']
  /** Realized evaluator score, when the node produced one. */
  readonly score?: number
}

/** A policy's decision for one round: which nodes to continue from. */
export type NodeBatch = readonly string[]

/**
 * One policy decision round, recorded for feedback.
 *
 * `requested` names the batch the policy asked for; `revealed` names the nodes
 * actually revealed, which differ when a requested node has no recorded
 * continuation. Keeping both is what lets a reviewer tell "the policy chose
 * badly" from "history had nothing there".
 */
export interface ReplayRound {
  readonly index: number
  readonly requested: NodeBatch
  readonly revealed: readonly string[]
}

/** Why a replay stopped. */
export type ReplayStopReason =
  /** The policy selected an empty batch. */
  | 'empty-batch'
  /** The round limit was reached. */
  | 'round-limit'
  /** Every recorded node has been revealed. */
  | 'exhausted'

/**
 * The result of evaluating one policy against one world.
 *
 * `revealedNodeCount` is the trajectory's cost proxy: replay executes nothing,
 * so the number of generation-evaluation requests the trajectory REPRESENTS is
 * the only honest denominator for comparing policies.
 */
export interface ReplayResult {
  readonly rounds: readonly ReplayRound[]
  readonly revealedNodeIds: readonly string[]
  /** Revealed non-root nodes — the cost proxy. */
  readonly revealedNodeCount: number
  /** Completed decision rounds. */
  readonly roundCount: number
  /** Best realized score anywhere in the revealed subtree. */
  readonly bestScore: number | undefined
  readonly stopReason: ReplayStopReason
}
