/**
 * Discovery-tree tracing for RSI-style exploration harnesses.
 *
 * A discovery node is one attempt in a tree of attempts. This package does not
 * add storage: it declares the durable `rsi/node` event, registers a
 * `ctx.sessionProjections` unit that folds the session log into the tree, and
 * exposes `ctx.rsiTrace` for readers.
 *
 * Two properties are load-bearing and are what the package exists to guarantee:
 *
 * - **The tree is derived, never authoritative.** Reading goes through dsh's
 *   projection registry, so the index is rebuildable from the append-only log
 *   (`rebuildDiscoveryTree`) and a lost index is a cache miss, not data loss.
 * - **A fork child's tree is scoped to its own attempts.** Lineage and the fork
 *   cut are read from immutable session metadata in `init`, and the fold skips
 *   everything before `inheritedEventCount`, so an inherited prefix never
 *   restates itself as child work.
 *
 * This package is the trace/read half. A replay engine, a policy runtime, and a
 * workspace-snapshot store are separate concerns that consume it.
 * @module @deepseek-ai/dsh-rsi-trace
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection/types'
import type { Session } from '@deepseek-ai/dsh-session'
import { discoveryTreeProjection } from './projection.ts'
import type { DiscoveryNode, DiscoveryTreeState } from './types.ts'

export type {
  DiscoveryNode,
  DiscoveryNodeStatus,
  DiscoveryTreeState,
} from './types.ts'
export {
  NO_NODES,
  foldDiscoveryTree,
  initDiscoveryTree,
  rebuildDiscoveryTree,
} from './types.ts'
export { discoveryTreeProjection, DISCOVERY_NODE_STATUSES } from './projection.ts'
export {
  IMPLICIT_ROOT,
  PrefixQuestion,
  ReplayWorld,
  ReplayWorldError,
  replay,
  replayScore,
  replayWorldFromNodes,
  replayWorldFromTree,
} from './replay.ts'
export type {
  NodeBatch,
  ReplayObservation,
  ReplayResult,
  ReplayRound,
  ReplayStopReason,
} from './replay-types.ts'

export const name = 'rsi-trace'
export const inject = ['sessionProjections']

declare module '@deepseek-ai/cordis' {
  interface Context {
    rsiTrace: RsiTrace
  }
}

/**
 * Reader over the `rsi/discoveryTree` projection.
 *
 * Every method takes the target session explicitly. dsh's projection registry
 * already scopes a fold per session, so the service is stateless: it holds no
 * per-session map and therefore needs no per-session instantiation.
 */
export class RsiTrace extends Service {
  static inject = ['sessionProjections']

  constructor(ctx: Context) {
    super(ctx, 'rsiTrace')
    // Register the fold from the service constructor: this class requires
    // `sessionProjections`, so the service exists by the time it is built, and
    // the fiber that owns this registration is the service's own. Registering it
    // from a sibling `ctx.inject` callback instead would tie the fold's lifetime
    // to a fiber that settles after this plugin finishes loading.
    ctx.effect(() => ctx.sessionProjections.register(discoveryTreeProjection))
  }

  /**
   * Current folded tree for one session.
   * @param session - the session whose discovery tree is read.
   * @returns the tree, or `undefined` when this session has no tree state yet.
   */
  tree(session: Session): DiscoveryTreeState | undefined {
    return this.ctx.sessionProjections.stateOf(session, 'rsi/discoveryTree')
  }

  /**
   * Owned nodes in creation order — the youngest-first input a replay engine's
   * `Child(r)` rule needs.
   * @param session - the session whose discovery tree is read.
   * @returns owned nodes in creation order; empty when none are recorded.
   */
  nodes(session: Session): readonly DiscoveryNode[] {
    const state = this.tree(session)
    if (state === undefined) return []
    return state.order.flatMap(nodeId => {
      const node = state.nodes[nodeId]
      return node === undefined ? [] : [node]
    })
  }

  /**
   * Children of one node, in creation order.
   * @param session - the session whose discovery tree is read.
   * @param parentId - node whose children are listed.
   * @returns the matching nodes in creation order.
   */
  childrenOf(session: Session, parentId: string): readonly DiscoveryNode[] {
    return this.nodes(session).filter(node => node.parent === parentId)
  }

  /**
   * The node a session currently represents, once it has recorded one.
   * @param session - the session whose discovery tree is read.
   * @returns the current node, or `undefined` before any record exists.
   */
  current(session: Session): DiscoveryNode | undefined {
    const state = this.tree(session)
    if (state?.nodeId === undefined) return undefined
    return state.nodes[state.nodeId]
  }
}

/**
 * Mount the discovery-tree projection and the reader service.
 *
 * The projection registration lives in the service constructor, so a single
 * plugin load always yields both the fold and the reader. Anchor the bundle at
 * this plugin and neither can be present without the other.
 * @param ctx - the context mounting this plugin.
 */
export function apply(ctx: Context): void {
  ctx.plugin(RsiTrace)
}

export default RsiTrace
