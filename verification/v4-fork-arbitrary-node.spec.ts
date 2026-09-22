/**
 * V4 of PHASE0-VERIFICATION.md — can a discovery node fork from an ARBITRARY
 * recorded ancestor, not just from the session tail?
 *
 * Why it matters: Dream-RSI's discovery tree resumes a parent node's saved
 * workspace + accumulated history to produce a new attempt. The in-tree fork
 * subagent only ever slices the LAST `turn/end` (`completedTurnPrefix()` in
 * `subagent-fork-in-process`). A tree needs to branch at any recorded node.
 *
 * The claim under test: `ctx.agents.create({ seed, inheritedEventCount, meta })`
 * accepts an arbitrary balanced prefix, marks it inherited, and keeps the
 * child's own work strictly separate from the borrowed prefix — including
 * proving the parent's LATER turns never leak into the child.
 */
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, buildForkSeed } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionLogOffset } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse } from './mock-adapter.ts'

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
  return ctx
}

/** Seq of the turn/end closing turn `turn`. */
function endOfTurn(events: readonly SessionEvent[], turn: number): number {
  const seq = events.findIndex(event =>
    event.type === 'turn/end' && event.data.turn === turn)
  expect(seq, `turn ${turn} must have completed`).toBeGreaterThanOrEqual(0)
  return seq
}

it('forks from an arbitrary earlier turn and keeps the parent tail out of the child', async () => {
  const adapter = new MockAdapter([textResponse('PARENT_ONE'), textResponse('PARENT_TWO')])
  const ctx = await mounted(adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })

  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'p1' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, parent)
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'p2' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, parent)

  const parentEvents = parent.session.snapshotEvents()
  const firstTurnEnd = endOfTurn(parentEvents, 1)
  const lastTurnEnd = endOfTurn(parentEvents, 2)
  expect(firstTurnEnd).toBeLessThan(lastTurnEnd)

  // Fork at the FIRST turn — not at the tail, which is all the built-in provider does.
  const seed = buildForkSeed(parentEvents, firstTurnEnd as SessionLogOffset)

  // `buildForkSeed` already appends the `{ inherited: true }` marker at
  // `boundary + 1`, so the inherited count must name THAT marker, not the event
  // after it. Passing `seed.length` overshoots the cut, and the constructor then
  // appends a second marker (verified: totalEvents 13 vs 12, markers 2 vs 1).
  const inheritedCount = seed.length - 1
  expect(seed[inheritedCount]!.type).toBe('session/end-seed')

  // NOTE: `ctx.agentLoop.create(id, agentOptions, meta)` is the simple test
  // helper and does NOT accept a seed; the seeding entry point is the registry's
  // `ctx.agents.create(CreateAgentOptions)`.
  const handle = await ctx.agents.create({
    sessionId: SessionId('child'),
    parentAgent: parent,
    agentOptions: { provider: 'mock', model: 'mock' },
    meta: { parentSession: SessionId('parent'), isSeeded: true },
    inheritedEventCount: inheritedCount as SessionLogOffset,
    seed,
  })
  const child = handle.agent

  // 1. The fork lineage is durable session metadata, not adapter state.
  expect(child.session.header.isSeeded).toBe(true)
  expect(child.session.header.parentSession).toBe('parent')

  // 2. The inherited count matches the seed exactly, and child-owned work starts there.
  // `inheritedEventCount` is documented as STORAGE metadata paired with the
  // header for every body read — it lives on the Session, not inside the header.
  expect(child.session.inheritedEventCount).toBe(inheritedCount)

  // 3. Exactly ONE inherited marker exists at the cut — the seed's own.
  const childEvents = child.session.snapshotEvents()
  const markers = childEvents.filter(
    event => event.type === 'session/end-seed' && event.data.inherited === true)
  expect(markers).toHaveLength(1)
  expect(childEvents.indexOf(markers[0]!)).toBe(inheritedCount)

  // 4. The child sees turn 1 but NOT the parent's later turn — this is the whole
  //    point of forking at an arbitrary node rather than at the tail.
  const inheritedText = JSON.stringify(childEvents.slice(0, inheritedCount + 1))
  expect(inheritedText).toContain('p1')
  expect(inheritedText).not.toContain('p2')
  expect(inheritedText).not.toContain('PARENT_TWO')

  // 5. The child is not just a copy: it owns history after the cut.
  expect(childEvents.length).toBeGreaterThanOrEqual(seed.length)

  await ctx.fiber.dispose()
})

it('rejects a seed that is not contiguous from seq 0 or lacks an inherited count', async () => {
  const adapter = new MockAdapter([textResponse('PARENT_ONE')])
  const ctx = await mounted(adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent2'), { provider: 'mock', model: 'mock' })
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'p1' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, parent)

  const parentEvents = parent.session.snapshotEvents()
  const cut = endOfTurn(parentEvents, 1)

  // A non-contiguous seed (dropping the head) must be refused loudly.
  await expect(ctx.agents.create({
    sessionId: SessionId('bad-head'),
    agentOptions: { provider: 'mock', model: 'mock' },
    meta: { isSeeded: true },
    inheritedEventCount: (cut + 1) as SessionLogOffset,
    seed: parentEvents.slice(2, cut + 2),
  })).rejects.toThrow(/contiguous from 0|seq/)

  // A seeded header without an inherited count must be refused loudly: dsh does
  // not guess the fork cut.
  await expect(ctx.agents.create({
    sessionId: SessionId('no-count'),
    agentOptions: { provider: 'mock', model: 'mock' },
    meta: { isSeeded: true },
    seed: buildForkSeed(parentEvents, cut as SessionLogOffset),
  })).rejects.toThrow(/inherited event count/)

  await ctx.fiber.dispose()
})
