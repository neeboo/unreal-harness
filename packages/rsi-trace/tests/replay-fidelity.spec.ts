/**
 * Phase 1 acceptance: does replaying a recorded tree reproduce what actually
 * happened, and does it discriminate against a different policy?
 *
 * Fidelity is the whole claim of the design. Replay executes nothing, so if it
 * did not reproduce the trajectory the run actually took, its scores would be
 * fiction. The tree here is built by an ONLINE run — a root session and forked
 * child sessions, each recording its own `rsi/node` — and the online decision
 * sequence is then handed back to the engine.
 *
 * The negative control matters as much as the positive one: a replay that
 * reproduced every trajectory regardless of policy would pass a naive fidelity
 * check while being useless.
 */
import { expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq, buildForkSeed } from '@deepseek-ai/dsh-session'
import type { SessionLogOffset as SessionLogOffsetType } from '@deepseek-ai/dsh-session'
import { IMPLICIT_ROOT, replay, replayWorldFromTree } from '../src/index.ts'
import type { DiscoveryNode, NodeBatch } from '../src/index.ts'
import { harness, waitForIdle } from './harness.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'

/**
 * One online exploration step: the batch of frontier nodes the policy selected,
 * and the child sessions those selections produced.
 */
interface OnlineRound {
  readonly requested: NodeBatch
  readonly opened: { readonly nodeId: string; readonly branch: number }[]
}

/** Node ids are recorded per session, so collect the tree the run produced. */
async function collectNodes(
  ctx: Awaited<ReturnType<typeof harness>>,
  sessionIds: readonly string[],
): Promise<DiscoveryNode[]> {
  const nodes: DiscoveryNode[] = []
  for (const [index, sessionId] of sessionIds.entries()) {
    const session = ctx.sessions.get(SessionId(sessionId))
    expect(session, `session ${sessionId} must exist`).toBeDefined()
    for (const node of ctx.rsiTrace.nodes(session!)) {
      // `seq` is only unique within a session, but the world orders siblings by
      // `siblingOrder` and falls back to seq, so carry global recency instead.
      nodes.push({ ...node, seq: index })
    }
  }
  return nodes
}

it('reproduces the online trajectory from the recorded tree, and discriminates', async () => {
  // Enough scripted responses for the root plus one per branch.
  const adapter = new MockAdapter([
    textResponse('root attempt'),
    textResponse('b0 attempt'),
    textResponse('b1 attempt'),
    textResponse('b0/a0 attempt'),
  ])
  const ctx = await harness(adapter)

  // ---- The online run ----------------------------------------------------
  const root = await ctx.agentLoop.create(SessionId('root'), { provider: 'mock', model: 'mock' })
  root.session.append('rsi/node', {
    nodeId: 'root', branch: -1, attempt: -1, siblingOrder: 0, status: 'scored', score: 0.2,
  })
  root.followup(createUserMessage({ content: [{ type: 'text', text: 'explore' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, root)

  const rootEvents = root.session.snapshotEvents()
  const cut = SessionSeq(rootEvents.findIndex(event => event.type === 'turn/end'))
  const seed = buildForkSeed(rootEvents, cut)
  const inheritedCount = seed.length - 1

  /** Fork one child session and record its own node, exactly as a harness would. */
  const openChild = async (
    nodeId: string,
    parentId: string,
    branch: number,
    attempt: number,
    siblingOrder: number,
    score: number,
  ) => {
    const handle = await ctx.agents.create({
      sessionId: SessionId(nodeId),
      parentAgent: root,
      agentOptions: { provider: 'mock', model: 'mock' },
      meta: { parentSession: SessionId('root'), isSeeded: true },
      inheritedEventCount: inheritedCount as SessionLogOffsetType,
      seed,
    })
    const child = handle.agent
    child.session.append('rsi/node', {
      nodeId, parent: parentId, branch, attempt, siblingOrder, status: 'scored', score,
    })
    child.followup(createUserMessage({ content: [{ type: 'text', text: nodeId }], source: { kind: 'user' } }))
    await waitForIdle(ctx, child)
    return child
  }

  // Round 1: open branch b0 (the implicit root's earliest recorded child).
  await openChild('b0', 'root', 0, 0, 0, 0.3)
  // Round 2: open branch b1, and deepen b0 in the same round.
  await openChild('b1', 'root', 1, 0, 1, 0.9)
  await openChild('b0/a0', 'b0', 0, 1, 0, 0.55)

  // The decision sequence the ONLINE run actually followed. `siblingOrder`
  // preserves which branch was created first within each round.
  const onlineRounds: OnlineRound[] = [
    { requested: [IMPLICIT_ROOT], opened: [{ nodeId: 'b0', branch: 0 }] },
    { requested: [IMPLICIT_ROOT, 'b0'], opened: [{ nodeId: 'b1', branch: 1 }, { nodeId: 'b0/a0', branch: 0 }] },
  ]
  const onlineRevealed = onlineRounds.flatMap(round => round.opened.map(opened => opened.nodeId))

  // ---- The tree the run recorded ----------------------------------------
  const nodes = await collectNodes(ctx, ['root', 'b0', 'b1', 'b0/a0'])
  expect(nodes.map(node => node.nodeId).sort()).toEqual(['b0', 'b0/a0', 'b1', 'root'])

  // The recorded parentage is what the online run meant: b0 and b1 continue the
  // implicit workspace, b0/a0 continues b0.
  expect(nodes.find(node => node.nodeId === 'b0')!.parent).toBe('root')
  expect(nodes.find(node => node.nodeId === 'b0/a0')!.parent).toBe('b0')

  // The hosting session's own marker becomes the implicit workspace, so its
  // direct children are branch heads. `replayWorldFromTree` owns that mapping.
  const world = replayWorldFromTree('root', nodes)

  // ---- Fidelity: replay the online decisions -----------------------------
  let step = 0
  const replayed = replay(world, () => {
    const batch = onlineRounds[step]?.requested
    step += 1
    return batch === undefined ? [] : batch
  })

  // The same nodes, revealed in the same per-round grouping.
  expect(replayed.rounds.map(round => round.revealed)).toEqual(
    onlineRounds.map(round => round.opened.map(opened => opened.nodeId)),
  )
  expect([...replayed.revealedNodeIds].sort()).toEqual([...onlineRevealed].sort())
  // Round count matches the run's decision rounds.
  expect(replayed.roundCount).toBe(onlineRounds.length)
  // And the quality signal is the best recorded score in that subtree.
  expect(replayed.bestScore).toBe(0.9)

  // ---- Negative control: a different policy diverges ---------------------
  // Greedy-by-recorded-score is a legitimate alternative that the run did NOT
  // take, and it must produce a different trajectory — otherwise "fidelity"
  // above would be vacuously true of any policy.
  const greedy = replay(world, question => {
    if (question.roundCount === 0) return [IMPLICIT_ROOT]
    // b1 scores highest, so deepen it instead of b0.
    const legal = question.legalActions().filter(action => action !== IMPLICIT_ROOT)
    return legal.includes('b1') ? ['b1'] : []
  })

  expect(greedy.revealedNodeIds).not.toEqual(replayed.revealedNodeIds)

  await ctx.fiber.dispose()
})
