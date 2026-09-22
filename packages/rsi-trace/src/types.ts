/**
 * Discovery-tree vocabulary for RSI-style exploration harnesses.
 *
 * A discovery node is ONE attempt in a tree of attempts. The tree is not a new
 * store: it is a projection of the session event log, and a node's identity is
 * the session that produced it. This module owns the durable event type, the
 * folded tree state, and the pure fold that turns committed events into it.
 * @module @deepseek-ai/dsh-rsi-trace/types
 */

import type { SessionEvent, SessionHeader, SessionLogOffset } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One record about a discovery node on this session. Log-only: it is never
     * model-visible and never produces a surface node.
     *
     * A session may append several records for the same `nodeId` over time — an
     * `open` record when the attempt starts, a later `scored` record when its
     * evaluator returns. Later records UPDATE the node; they never create a
     * second one.
     */
    'rsi/node': {
      /** Stable node identity. For a fork child this is normally its own session id. */
      nodeId: string
      /** Branch index within the parent, or `-1` for a root node. */
      branch: number
      /** Attempt index along that branch, or `-1` for a root node. */
      attempt: number
      /** Parent node id. Absent on a root node. */
      parent?: string
      /**
       * Creation order among the parent's children. This is the order the
       * youngest-first `Child(r)` replay rule must respect, so it is recorded
       * explicitly rather than inferred from session id or the filesystem.
       */
      siblingOrder: number
      /** Lifecycle state of the attempt. */
      status: 'open' | 'scored' | 'failed'
      /** Realized evaluator score, once one exists. */
      score?: number
    }
  }

}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'rsi/discoveryTree': DiscoveryTreeState
  }
}

/** Lifecycle state of one discovery attempt. */
export type DiscoveryNodeStatus = 'open' | 'scored' | 'failed'

/** One folded node of the discovery tree. */
export interface DiscoveryNode {
  readonly nodeId: string
  readonly parent?: string
  readonly branch: number
  readonly attempt: number
  readonly siblingOrder: number
  /**
   * Log position of the FIRST record that created this node. Create-only: a
   * later record for the same node must not move it, because creation order is
   * what the youngest-first replay rule reads.
   */
  readonly seq: number
  /**
   * Completed turns of this node's OWN post-fork history. Create-only in the
   * same sense as {@link DiscoveryNode.seq}.
   */
  readonly turns: number
  readonly status: DiscoveryNodeStatus
  readonly score?: number
}

/**
 * Folded discovery tree for one session. Immutable: every transition returns a
 * new state, so a projection consumer never observes a partially applied event.
 */
export interface DiscoveryTreeState {
  /** Immutable fork cut. Events before it belong to an ancestor's tree, not this one. */
  readonly inheritedEventCount: SessionLogOffset
  /** Durable tree edge, read from the session header rather than from an event. */
  readonly parentSession?: string
  /** Whether this session is a fork child. */
  readonly isSeeded: boolean
  /** Node this session currently represents, once it has recorded one. */
  readonly nodeId?: string
  /** Nodes owned by this session's post-fork history, keyed by node id. */
  readonly nodes: Readonly<Record<string, DiscoveryNode>>
  /** Creation order of the owned nodes — the youngest-first rule's input. */
  readonly order: readonly string[]
}

/** Shared empty node map, so an uninvolved fold keeps its state reference. */
export const NO_NODES: Readonly<Record<string, DiscoveryNode>> = Object.freeze({})

/**
 * Initial state for one session. Lineage and the fork cut come from the
 * immutable header and the stored inherited count, never from an event: dsh
 * records a fork as session metadata, so the tree edge is free.
 * @param header - immutable metadata of the session being projected.
 * @param inheritedEventCount - exact fork-inherited prefix length.
 * @returns the empty tree for this session.
 */
export function initDiscoveryTree(
  header: SessionHeader,
  inheritedEventCount: SessionLogOffset,
): DiscoveryTreeState {
  return {
    inheritedEventCount,
    ...header.parentSession === undefined ? {} : { parentSession: header.parentSession },
    isSeeded: header.isSeeded,
    nodes: NO_NODES,
    order: [],
  }
}

/**
 * Pure transition: previous tree plus one committed event.
 *
 * A unit that is not interested in an event MUST return the SAME state
 * reference, so an unchanged fold produces zero downstream work.
 * @param state - tree covering every prior event.
 * @param event - the next committed session event.
 * @returns the next tree, or `state` when this event does not change it.
 */
export function foldDiscoveryTree(state: DiscoveryTreeState, event: SessionEvent): DiscoveryTreeState {
  // Inherited events belong to an ancestor's tree. This is what keeps a fork
  // child's tree scoped to its own attempts instead of restating its lineage.
  if (event.seq < state.inheritedEventCount) return state

  if (event.type === 'rsi/node') {
    const data = event.data
    const previous = state.nodes[data.nodeId]
    const node: DiscoveryNode = Object.freeze({
      nodeId: data.nodeId,
      ...data.parent === undefined ? {} : { parent: data.parent },
      branch: data.branch,
      attempt: data.attempt,
      siblingOrder: data.siblingOrder,
      // Create-only fields keep their first-recorded value.
      seq: previous?.seq ?? event.seq,
      turns: previous?.turns ?? 0,
      status: data.status,
      ...data.score === undefined ? {} : { score: data.score },
    })
    return Object.freeze({
      ...state,
      nodeId: data.nodeId,
      nodes: Object.freeze({ ...state.nodes, [data.nodeId]: node }),
      order: previous === undefined ? Object.freeze([...state.order, data.nodeId]) : state.order,
    })
  }

  if (event.type === 'turn/end' && state.nodeId !== undefined) {
    const current = state.nodes[state.nodeId]
    if (current === undefined) return state
    return Object.freeze({
      ...state,
      nodes: Object.freeze({
        ...state.nodes,
        [state.nodeId]: Object.freeze({ ...current, turns: current.turns + 1 }),
      }),
    })
  }

  return state
}

/**
 * Rebuild a tree by folding a raw event log from scratch.
 *
 * This is the property the whole design rests on: the projection is disposable,
 * so a corrupt or missing index is always recoverable from the durable log. Any
 * consumer that can read events can reproduce the state a live projection holds.
 * @param header - immutable metadata of the session.
 * @param inheritedEventCount - exact fork-inherited prefix length.
 * @param events - the session's events, in log order.
 * @returns the tree state those events fold to.
 */
export function rebuildDiscoveryTree(
  header: SessionHeader,
  inheritedEventCount: SessionLogOffset,
  events: readonly SessionEvent[],
): DiscoveryTreeState {
  return events.reduce(foldDiscoveryTree, initDiscoveryTree(header, inheritedEventCount))
}
