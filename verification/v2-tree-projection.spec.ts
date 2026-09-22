/**
 * V2 of PHASE0-VERIFICATION.md — can the discovery tree live as a rebuildable
 * PROJECTION of the session log, with no new storage and no dsh changes?
 *
 * The RSI-Harness plan stores the discovery-tree index outside the transcript
 * (so it does not eat context) while keeping the append-only log as the single
 * source of truth. This test proves that claim end to end:
 *
 *  1. a plugin can extend `SessionEventMap` and append its own event type,
 *  2. a `ProjectionDefinition` folds a tree out of ordinary session events —
 *     crucially reading `header.parentSession` in `init` (lineage) and skipping
 *     everything before `inheritedEventCount` (the fork cut),
 *  3. the folded state is EXACTLY reproducible by re-folding the raw log, which
 *     is what makes the index disposable rather than authoritative.
 */
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionLogOffset, buildForkSeed } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionLogOffset as SessionLogOffsetType } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse } from './mock-adapter.ts'

// ---- The out-of-tree plugin's vocabulary -------------------------------
// A plugin may extend the durable log vocabulary by declaration merging; dsh's
// persistence catalog generator discovers these members from source.
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** RSI-Harness's own record on a discovery node. Log-only, never model-visible. */
    'rsi/node': {
      /** Stable node identity (its own session id for a fork child). */
      nodeId: string
      /** Branch index within the parent, or -1 for the root. */
      branch: number
      /** Attempt index along that branch, or -1 for the root. */
      attempt: number
      /** Parent node id, absent on the root. */
      parent?: string
      /** Creation order among siblings — the order `Child(r)` must respect. */
      siblingOrder: number
      status: 'open' | 'scored' | 'failed'
      /** Realized evaluator score, when one exists. */
      score?: number
    }
  }

  interface SessionProjectionStateMap {
    'rsi/discoveryTree': DiscoveryTreeState
  }
}

// ---- The projection ----------------------------------------------------
interface DiscoveryNode {
  readonly nodeId: string
  readonly parent?: string
  readonly branch: number
  readonly attempt: number
  readonly siblingOrder: number
  /** Log index of the `rsi/node` event that created it (creation order). */
  readonly seq: number
  /** Turn count of the node's OWN (post-fork) history. */
  readonly turns: number
  readonly status: 'open' | 'scored' | 'failed'
  readonly score?: number
}

interface DiscoveryTreeState {
  /** Immutable fork cut: events before it are inherited, not owned. */
  readonly inheritedEventCount: number
  /** Lineage read off the session header — the durable tree edge. */
  readonly parentSession?: string
  readonly isSeeded: boolean
  /** Live (child-owned) node id this session represents. */
  readonly nodeId?: string
  readonly nodes: Readonly<Record<string, DiscoveryNode>>
  /** Creation order of live nodes, for the `Child(r)` earliest-first rule. */
  readonly order: readonly string[]
}

const EMPTY_NODES: Readonly<Record<string, DiscoveryNode>> = Object.freeze({})

/** Fold one committed event into the tree. Pure; same reference when uninterested. */
function foldNode(state: DiscoveryTreeState, event: SessionEvent): DiscoveryTreeState {
  // Inherited events belong to an ancestor's tree, not this node's.
  if (event.seq < state.inheritedEventCount) return state

  if (event.type === 'rsi/node') {
    const data = event.data
    // A later record for the same node UPDATES it. `seq` and `turns` are
    // create-only fields: seq must stay the creation position that `Child(r)`'s
    // earliest-first rule reads, and turns must not be reset by an update.
    const previous = state.nodes[data.nodeId]
    const node: DiscoveryNode = Object.freeze({
      nodeId: data.nodeId,
      ...data.parent === undefined ? {} : { parent: data.parent },
      branch: data.branch,
      attempt: data.attempt,
      siblingOrder: data.siblingOrder,
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

const discoveryTreeStateSchema = z.object({
  inheritedEventCount: z.number().int().nonnegative(),
  parentSession: z.string().optional(),
  isSeeded: z.boolean(),
  nodeId: z.string().optional(),
  nodes: z.record(z.string(), z.object({
    nodeId: z.string(),
    parent: z.string().optional(),
    branch: z.number().int(),
    attempt: z.number().int(),
    siblingOrder: z.number().int(),
    seq: z.number().int().nonnegative(),
    turns: z.number().int().nonnegative(),
    status: z.enum(['open', 'scored', 'failed']),
    score: z.number().optional(),
  })),
  order: z.array(z.string()),
}) as unknown as z.ZodType<DiscoveryTreeState>

const discoveryTreeProjection = {
  key: 'rsi/discoveryTree',
  stateSchema: discoveryTreeStateSchema,
  init: (header: SessionHeader, inheritedEventCount: SessionLogOffsetType): DiscoveryTreeState => ({
    inheritedEventCount,
    ...header.parentSession === undefined ? {} : { parentSession: header.parentSession },
    isSeeded: header.isSeeded,
    nodes: EMPTY_NODES,
    order: [],
  }),
  apply: foldNode,
  stateVersion: 1,
} satisfies ProjectionDefinition<'rsi/discoveryTree', DiscoveryTreeState>

// ---- Harness -----------------------------------------------------------
function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

async function mounted(adapter: MockAdapter) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: 'stable base' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.sessionProjections.register(discoveryTreeProjection)
  return ctx
}

it('folds a discovery tree out of the log, and re-folding the raw log reproduces it exactly', async () => {
  const adapter = new MockAdapter([textResponse('root did work')])
  const ctx = await mounted(adapter)
  const root = await ctx.agentLoop.create(SessionId('tree-root'), { provider: 'mock', model: 'mock' })

  // The plugin records its own node on the session. Log-only: no projection
  // registration in SessionEventMap's surface types means it cannot reach the model.
  root.session.append('rsi/node', {
    nodeId: 'n0', branch: -1, attempt: -1, siblingOrder: 0, status: 'open',
  })
  root.followup(createUserMessage({ content: [{ type: 'text', text: 'explore' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, root)

  // Mark the root scored, as an evaluator would.
  root.session.append('rsi/node', {
    nodeId: 'n0', branch: -1, attempt: -1, siblingOrder: 0, status: 'scored', score: 0.42,
  })

  const live = ctx.sessionProjections.stateOf(root.session, 'rsi/discoveryTree')
  expect(live).toBeDefined()

  // 1. The fold saw the child-owned turn.
  expect(live!.nodeId).toBe('n0')
  expect(live!.nodes['n0']!.turns).toBe(1)
  expect(live!.order).toEqual(['n0'])
  // 2. A re-appended event for the same node REPLACES it rather than duplicating:
  //    the latest record is what the fold keeps, and order lists it once.
  expect(live!.nodes['n0']!.status).toBe('scored')
  expect(live!.nodes['n0']!.score).toBe(0.42)
  // 3. The root's `seq` points at the FIRST `rsi/node` event (creation order),
  //    not the later update — creation order is what `Child(r)` needs.
  const firstNodeSeq = root.session.snapshotEvents()
    .findIndex(event => event.type === 'rsi/node')
  expect(live!.nodes['n0']!.seq).toBe(firstNodeSeq)

  // 4. THE CORE CLAIM: the folded state is exactly reproducible from the raw log.
  //    Fold the same events through the same pure transition and compare.
  const replay = root.session.snapshotEvents().reduce<DiscoveryTreeState>(
    (state, event) => foldNode(state, event),
    discoveryTreeProjection.init(root.session.header, root.session.inheritedEventCount),
  )
  expect(replay).toEqual(live)
  expect(Object.isFrozen(live!.nodes)).toBe(true)

  await ctx.fiber.dispose()
})

it('scopes the fold to the fork cut, so a child owns only its post-fork tree', async () => {
  const adapter = new MockAdapter([textResponse('A'), textResponse('B')])
  const ctx = await mounted(adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })

  parent.session.append('rsi/node', {
    nodeId: 'root', branch: -1, attempt: -1, siblingOrder: 0, status: 'scored', score: 0.1,
  })
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'p1' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, parent)
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'p2' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, parent)

  const parentEvents = parent.session.snapshotEvents()
  const cut = parentEvents.findIndex(event => event.type === 'turn/end')
  const seed = buildForkSeed(parentEvents, SessionLogOffset(cut))
  // `buildForkSeed` appends the inherited marker itself, so the count names it.
  const inheritedCount = seed.length - 1

  const handle = await ctx.agents.create({
    sessionId: SessionId('child'),
    parentAgent: parent,
    agentOptions: { provider: 'mock', model: 'mock' },
    meta: { parentSession: SessionId('parent'), isSeeded: true },
    inheritedEventCount: inheritedCount as SessionLogOffsetType,
    seed,
  })
  const child = handle.agent

  // The child records its own node as a branch off the root.
  child.session.append('rsi/node', {
    nodeId: 'root/b0', parent: 'root', branch: 0, attempt: 0, siblingOrder: 0, status: 'open',
  })

  const tree = ctx.sessionProjections.stateOf(child.session, 'rsi/discoveryTree')
  expect(tree).toBeDefined()

  // 1. Lineage came off the immutable header, in `init` — not from an event.
  expect(tree!.parentSession).toBe('parent')
  expect(tree!.isSeeded).toBe(true)
  expect(tree!.inheritedEventCount).toBe(inheritedCount)

  // 2. The inherited prefix is IN the child's log but NOT in the child's tree:
  //    the parent's `root` node and its turn are excluded by the fork cut.
  expect(child.session.snapshotEvents().some(event => event.type === 'rsi/node')).toBe(true)
  expect(tree!.nodes['root']).toBeUndefined()
  expect(Object.keys(tree!.nodes)).toEqual(['root/b0'])
  expect(tree!.order).toEqual(['root/b0'])
  expect(tree!.nodes['root/b0']!.turns).toBe(0)

  // 3. Reproducible from the raw log, fork cut and all.
  const replay = child.session.snapshotEvents().reduce<DiscoveryTreeState>(
    (state, event) => foldNode(state, event),
    discoveryTreeProjection.init(child.session.header, child.session.inheritedEventCount),
  )
  expect(replay).toEqual(tree)

  await ctx.fiber.dispose()
})
