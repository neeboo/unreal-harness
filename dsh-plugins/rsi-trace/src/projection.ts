/**
 * The `rsi/discoveryTree` projection unit: a validated, versioned fold of the
 * session log into the discovery tree.
 *
 * Registered on `ctx.sessionProjections`, so dsh owns the fold's caching,
 * invalidation (`stateVersion`), persisted-state validation (`stateSchema`), and
 * rebuild-from-log behavior. This package contributes the definition, not a
 * storage mechanism.
 * @module @deepseek-ai/dsh-rsi-trace/projection
 */

import { z } from 'zod'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection/types'
import { foldDiscoveryTree, initDiscoveryTree } from './types.ts'
import type { DiscoveryNodeStatus, DiscoveryTreeState } from './types.ts'

/** Every status a discovery node may carry, for schema validation. */
const STATUSES = ['open', 'scored', 'failed'] as const

const discoveryNodeSchema = z.object({
  nodeId: z.string().min(1),
  parent: z.string().min(1).optional(),
  branch: z.number().int(),
  attempt: z.number().int(),
  siblingOrder: z.number().int(),
  seq: z.number().int().nonnegative(),
  turns: z.number().int().nonnegative(),
  status: z.enum(STATUSES),
  score: z.number().optional(),
}).strict()

const discoveryTreeStateSchema = z.object({
  inheritedEventCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionLogOffset),
  parentSession: z.string().min(1).optional(),
  isSeeded: z.boolean(),
  nodeId: z.string().min(1).optional(),
  nodes: z.record(z.string(), discoveryNodeSchema),
  order: z.array(z.string()),
}).strict().superRefine((state, context) => {
  // `order` is the youngest-first input, so it must name each owned node exactly
  // once and agree with the node map. A divergence means a write path skipped
  // the fold rather than a legitimate intermediate state.
  const seen = new Set(state.order)
  if (seen.size !== state.order.length) {
    context.addIssue({ code: 'custom', message: 'discovery tree order must not repeat a node' })
  }
  for (const nodeId of state.order) {
    if (state.nodes[nodeId] === undefined) {
      context.addIssue({ code: 'custom', message: `discovery tree order names an unknown node: ${nodeId}` })
    }
  }
  for (const nodeId of Object.keys(state.nodes)) {
    if (!seen.has(nodeId)) {
      context.addIssue({ code: 'custom', message: `discovery tree node is missing from order: ${nodeId}` })
    }
  }
  if (state.nodeId !== undefined && state.nodes[state.nodeId] === undefined) {
    context.addIssue({ code: 'custom', message: `discovery tree current node is unknown: ${state.nodeId}` })
  }
}) as unknown as z.ZodType<DiscoveryTreeState>

/**
 * The projection unit this package owns. `stateVersion` must be bumped whenever
 * the serialized fields or the fold semantics change, so persisted rows from an
 * older unit are discarded instead of forward-applied into garbage.
 */
export const discoveryTreeProjection = {
  key: 'rsi/discoveryTree',
  stateSchema: discoveryTreeStateSchema,
  init: initDiscoveryTree,
  apply: foldDiscoveryTree,
  stateVersion: 1,
} satisfies ProjectionDefinition<'rsi/discoveryTree', DiscoveryTreeState>

/** Node statuses, exported for consumer-side narrowing without re-declaring them. */
export const DISCOVERY_NODE_STATUSES: readonly DiscoveryNodeStatus[] = STATUSES
