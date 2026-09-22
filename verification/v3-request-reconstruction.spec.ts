/**
 * V3 of PHASE0-VERIFICATION.md — is a loop request reconstructable from the log?
 *
 * The claim under test (from `request-reconstruction.spec.ts`'s own header):
 * "every request the loop sends is a pure function of the session log". The
 * existing suite checks that successive requests prefix-extend each other; it
 * does NOT check that the DERIVED history reproduces what was actually sent.
 *
 * Here we assert exactly that: after a completed turn, `session.deriveMessages()`
 * must contain every recorded request's message list as a strict prefix, and the
 * tool schemas must fold back from the log's `request/header`.
 *
 * Why this matters: RSI-Harness's replay layer re-derives model input from the
 * durable log instead of storing requests. If derivation is lossy, "replay"
 * silently means something weaker than "what the model actually saw".
 */
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, foldRequestHeader } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

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
  ctx.tools.register(defineContentToolFixture({
    name: 'echo',
    description: 'echo back',
    parameters: { text: { type: 'string' } },
    async execute(args) { return [{ type: 'text', text: `echo: ${String(args.text)}` }] },
  }))
  return ctx
}

it('derives every recorded request back out of the session log', async () => {
  const adapter = new MockAdapter([
    toolCallResponse('c1', 'echo', { text: 'one' }, 'first'),
    textResponse('done'),
  ])
  const ctx = await mounted(adapter)
  const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)

  // Two model calls: the tool-call step, then the closing text step.
  expect(adapter.requests).toHaveLength(2)

  const derived = agent.session.deriveMessages()

  // 1. Each real request is reproduced by a prefix of the derived history.
  for (const [i, request] of adapter.requests.entries()) {
    expect(
      derived.slice(0, request.messages.length),
      `request ${i} messages must be a prefix of the derived history`,
    ).toEqual([...request.messages])
  }

  // 2. The derived history grows past every request by exactly the final answer,
  //    i.e. nothing beyond the requests is invented and nothing is dropped.
  const last = adapter.requests.at(-1)!
  expect(derived.length).toBe(last.messages.length + 1)
  expect(derived.at(-1)!.role).toBe('assistant')

  // 3. Tool schemas fold back from the log's header snapshot, not from memory.
  const header = foldRequestHeader(agent.session.snapshotEvents())
  expect(header?.tools?.length).toBe(1)
  for (const request of adapter.requests) {
    expect(request.tools?.length).toBe(header!.tools!.length)
  }

  // 4. A loop-built request leaves `system` undefined — the prompt travels as the
  //    leading system-role message of the derived history (dsh's documented rule).
  for (const request of adapter.requests) {
    expect(request.system).toBeUndefined()
    expect(request.messages[0]!.role).toBe('system')
  }

  await ctx.fiber.dispose()
})

it('reproduces requests across turns and after an injected context message', async () => {
  const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
  const ctx = await mounted(adapter)
  const agent = await ctx.agentLoop.create(SessionId('a2'), { provider: 'mock', model: 'mock' })

  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)

  // Inject context mid-session: the derived history must absorb it as a user-role
  // surface node, and the next request must still be a prefix of the derivation.
  agent.inject(createUserMessage({
    content: [{ type: 'text', text: '[injected context]' }],
    source: { kind: 'test' } as never,
  }))
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)

  expect(adapter.requests).toHaveLength(2)
  const derived = agent.session.deriveMessages()

  for (const [i, request] of adapter.requests.entries()) {
    expect(
      derived.slice(0, request.messages.length),
      `request ${i} must survive injection unchanged as a prefix`,
    ).toEqual([...request.messages])
  }

  // The injected text is present in the derived history (it entered the surface).
  const text = JSON.stringify(derived)
  expect(text).toContain('[injected context]')

  await ctx.fiber.dispose()
})

// The case L3 actually depends on: downgrading a chunk is a `surfaceOp.replace`.
// If derivation did not track replacements, the audit trail would diverge from
// what the model really saw — and Meta-attention could not be proven lossless.
it('derives the post-replacement request, so a downgrade stays auditable', async () => {
  const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
  const ctx = await mounted(adapter)
  const agent = await ctx.agentLoop.create(SessionId('a3'), { provider: 'mock', model: 'mock' })

  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'turn one' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)

  // Node 0 is the system prompt; replace the turn-1 user+assistant pair with a
  // debased summary — the exact operation a context downgrade performs.
  const nodes = agent.session.surface.nodes
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '[downgraded: 1 line]' }],
    source: { kind: 'test-compact' },
  }), {
    surfaceOp: { op: 'replace', startSeq: nodes[1]!, endSeq: nodes[2]! },
    sourceEventSeqs: [nodes[1]!, nodes[2]!],
  })

  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'turn two' }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)

  expect(adapter.requests).toHaveLength(2)
  const derived = agent.session.deriveMessages()

  // 1. The replacement is respected by the derivation AND by the real request.
  const rewritten = adapter.requests[1]!
  expect(JSON.stringify(rewritten.messages)).toContain('[downgraded: 1 line]')
  expect(JSON.stringify(rewritten.messages)).not.toContain('turn one')

  // 2. The post-replacement request is still exactly reproduced by the CURRENT
  //    derivation. NOTE the state dependence this pins down: `deriveMessages()`
  //    is the surface at log-end, so a request made BEFORE a replacement is not
  //    a prefix of the post-replacement derivation. Reproducing an arbitrary
  //    historical request therefore requires replaying the log up to that seq —
  //    which is precisely what the replay layer must do, and why only the
  //    post-replacement request is asserted here.
  expect(derived.slice(0, rewritten.messages.length)).toEqual([...rewritten.messages])

  // 3. The pre-replacement request is NOT a prefix of the post-replacement
  //    derivation. This is the negative control: it proves the assertion above
  //    is actually sensitive to replacement state rather than vacuously true.
  const stale = adapter.requests[0]!
  expect(derived.slice(0, stale.messages.length)).not.toEqual([...stale.messages])

  // 4. The shadowed originals survive in the log (replacements shadow, they do not
  //    delete), so the raw transcript is still recoverable for audit.
  expect(JSON.stringify(agent.session.snapshotEvents())).toContain('turn one')

  await ctx.fiber.dispose()
})
