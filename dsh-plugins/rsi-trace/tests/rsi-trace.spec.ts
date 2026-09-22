/**
 * The two load-bearing properties of `@deepseek-ai/dsh-rsi-trace`:
 *
 *  1. the discovery tree is DERIVED — reading rebuilds from the append-only log,
 *     so a lost index is a cache miss rather than data loss;
 *  2. a fork child's tree is SCOPED to its own attempts — inherited events never
 *     restate themselves as child work.
 */
import { expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, SessionSeq, buildForkSeed } from '@deepseek-ai/dsh-session'
import { harness, waitForIdle } from './harness.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'
import { rebuildDiscoveryTree } from '../src/index.ts'

it('folds owned nodes in creation order and reads them back through the service', async () => {
  const adapter = new MockAdapter([textResponse('root did work'), textResponse('child did work')])
  const ctx = await harness(adapter)
  const agent = await ctx.agentLoop.create(SessionId('n0'), { provider: 'mock', model: 'mock' })

  agent.session.append('rsi/node', {
    nodeId: 'n0', branch: -1, attempt: -1, siblingOrder: 0, status: 'open',
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'explore' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)

  // A later record UPDATES the node; it must not create a second one, and it must
  // not move the create-only `seq`/`turns` fields.
  agent.session.append('rsi/node', {
    nodeId: 'n0', branch: -1, attempt: -1, siblingOrder: 0, status: 'scored', score: 0.42,
  })

  const current = ctx.rsiTrace.current(agent.session)
  expect(current).toBeDefined()
  expect(current!.status).toBe('scored')
  expect(current!.score).toBe(0.42)
  expect(current!.turns).toBe(1)

  // Creation order is exactly the recorded node set, each named once.
  const nodes = ctx.rsiTrace.nodes(agent.session)
  expect(nodes.map(node => node.nodeId)).toEqual(['n0'])
  expect(nodes[0]!.seq).toBe(
    agent.session.snapshotEvents().findIndex(event => event.type === 'rsi/node'),
  )

  // THE CORE PROPERTY: the live projection equals a from-scratch fold of the log.
  const rebuilt = rebuildDiscoveryTree(
    agent.session.header,
    agent.session.inheritedEventCount,
    agent.session.snapshotEvents(),
  )
  expect(rebuilt).toEqual(ctx.rsiTrace.tree(agent.session))

  // Children are addressed by parent id, in creation order.
  expect(ctx.rsiTrace.childrenOf(agent.session, 'n0')).toEqual([])

  await ctx.fiber.dispose()
})

it('scopes a fork child to its own attempts, taking lineage from session metadata', async () => {
  const adapter = new MockAdapter([textResponse('a'), textResponse('b')])
  const ctx = await harness(adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })

  parent.session.append('rsi/node', {
    nodeId: 'root', branch: -1, attempt: -1, siblingOrder: 0, status: 'scored', score: 0.1,
  })
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'p1' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, parent)
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'p2' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, parent)

  const parentEvents = parent.session.snapshotEvents()
  const cut = SessionSeq(parentEvents.findIndex(event => event.type === 'turn/end'))
  // `buildForkSeed` takes a surface SEQ (a log position), not a log OFFSET — the
  // two are distinct branded types, so this conversion is the writer's to make.
  const seed = buildForkSeed(parentEvents, cut)
  // `buildForkSeed` appends the inherited marker itself, so the count names it.
  const inheritedCount = seed.length - 1

  const handle = await ctx.agents.create({
    sessionId: SessionId('child'),
    parentAgent: parent,
    agentOptions: { provider: 'mock', model: 'mock' },
    meta: { parentSession: SessionId('parent'), isSeeded: true },
    inheritedEventCount: SessionLogOffset(inheritedCount),
    seed,
  })
  const child = handle.agent

  // Two branches off the root, recorded youngest-last.
  child.session.append('rsi/node', {
    nodeId: 'root/b0', parent: 'root', branch: 0, attempt: 0, siblingOrder: 0, status: 'open',
  })
  child.session.append('rsi/node', {
    nodeId: 'root/b1', parent: 'root', branch: 1, attempt: 0, siblingOrder: 1, status: 'open',
  })

  const tree = ctx.rsiTrace.tree(child.session)
  expect(tree).toBeDefined()

  // Lineage and the cut come from immutable metadata, not from an event.
  expect(tree!.parentSession).toBe('parent')
  expect(tree!.isSeeded).toBe(true)
  expect(tree!.inheritedEventCount).toBe(inheritedCount)

  // The parent's events are physically present in the child's log…
  expect(child.session.snapshotEvents().some(event => event.type === 'rsi/node')).toBe(true)
  // …but the parent's node is NOT part of the child's tree, and the child's own
  // turns counter is unaffected by the inherited prefix.
  expect(tree!.nodes['root']).toBeUndefined()
  expect(Object.keys(tree!.nodes).sort()).toEqual(['root/b0', 'root/b1'])
  expect(tree!.nodes['root/b0']!.turns).toBe(0)

  // Creation order is what a youngest-first replay rule reads.
  expect(ctx.rsiTrace.childrenOf(child.session, 'root').map(node => node.nodeId))
    .toEqual(['root/b0', 'root/b1'])

  // Derived, not authoritative — rebuild agrees with the live fold.
  expect(rebuildDiscoveryTree(
    child.session.header,
    child.session.inheritedEventCount,
    child.session.snapshotEvents(),
  )).toEqual(tree)

  await ctx.fiber.dispose()
})

it('keeps the fold inert for unrelated events by reusing the state reference', async () => {
  const adapter = new MockAdapter([textResponse('a')])
  const ctx = await harness(adapter)
  const agent = await ctx.agentLoop.create(SessionId('inert'), { provider: 'mock', model: 'mock' })

  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)

  // A session with no `rsi/node` record has no current node, and its tree still
  // exposes the lineage facts the fold read in `init`.
  const tree = ctx.rsiTrace.tree(agent.session)
  expect(tree).toBeDefined()
  expect(tree!.nodeId).toBeUndefined()
  expect(tree!.nodes).toEqual({})
  expect(tree!.order).toEqual([])
  expect(ctx.rsiTrace.current(agent.session)).toBeUndefined()
  expect(ctx.rsiTrace.nodes(agent.session)).toEqual([])

  await ctx.fiber.dispose()
})
