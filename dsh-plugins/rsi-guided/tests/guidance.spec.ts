/**
 * Does the guidance actually reach the model?
 *
 * This is the only question that matters about an advisory layer, and it is not
 * answerable by unit-testing the fold: a ledger can be correct, the projection
 * can be registered, and the text can still never appear in a prompt because the
 * contribution was wired to the wrong service, the wrong order, or an assembly
 * path that never runs.
 *
 * So the test mounts the real agent topology, drives a tool call that fails, and
 * then reads what the *model* was sent. That is the artifact under test.
 *
 * @module
 */

import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import RsiGuided from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

/** Mount the real agent topology plus this package. */
async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: 'stable base' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(RsiGuided)
  return ctx
}

/** Resolve once the given agent is idle. */
function waitForIdle(ctx: Context, agent: { id: string }): Promise<void> {
  return new Promise(resolve => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject.id === agent.id && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

/** All text the model was shown, across every section and context it received. */
function promptTextOf(request: unknown): string {
  const parts: string[] = []
  const system = (request as { system?: unknown }).system
  if (typeof system === 'string') parts.push(system)
  const messages = (request as { messages?: unknown }).messages
  if (Array.isArray(messages)) {
    for (const message of messages) {
      const content = (message as { content?: unknown }).content
      if (typeof content === 'string') parts.push(content)
      else if (Array.isArray(content)) {
        for (const block of content) {
          const text = (block as { text?: unknown }).text
          if (typeof text === 'string') parts.push(text)
        }
      }
    }
  }
  return parts.join('\n')
}

it('records a failed attempt and shows it to the model on the next request', async () => {
  const adapter = new MockAdapter([
    // Turn 1: the model asks for a command that will fail.
    toolCallResponse('call_1', 'bash', { command: 'cat /nonexistent-file' }),
    // Turn 2: the model answers, and this is the request we inspect.
    textResponse('done'),
  ])
  const ctx = await harness(adapter)
  const agent = await ctx.agentLoop.create(SessionId('guided'), {
    provider: 'mock',
    model: 'mock',
  })

  agent.followup(
    createUserMessage({ content: [{ type: 'text', text: 'try it' }], source: { kind: 'user' } }),
  )
  await waitForIdle(ctx, agent)

  expect(adapter.requests.length).toBeGreaterThanOrEqual(2)
  const secondRequest = promptTextOf(adapter.requests[1])

  // The ledger must have recorded the failure...
  const attempts = ctx.rsiGuided.attempts(agent.session)
  expect(attempts.length).toBeGreaterThan(0)
  expect(attempts.some(attempt => attempt.outcome === 'failed')).toBe(true)

  // ...and the model must have been told about it. Both halves are asserted,
  // because a fold that works and a prompt that never carries it would pass a
  // ledger-only test while leaving the feature inert -- which is exactly the bug
  // this test was written after finding in a real container.
  expect(secondRequest).toContain('recorded attempt')
  expect(secondRequest).toContain('nonexistent-file')
})

it('contributes nothing before any attempt has been made', async () => {
  const adapter = new MockAdapter([textResponse('ok')])
  const ctx = await harness(adapter)
  const agent = await ctx.agentLoop.create(SessionId('quiet'), {
    provider: 'mock',
    model: 'mock',
  })
  agent.followup(
    createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }),
  )
  await waitForIdle(ctx, agent)

  // A first prompt carrying "0 attempts" would be noise in every session, and
  // worse, it would make the feature look active when it had nothing to say.
  expect(promptTextOf(adapter.requests[0])).not.toContain('recorded attempt')
})
