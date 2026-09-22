import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import RsiTrace from '../src/index.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'

/**
 * Mount the real agent topology plus this package.
 *
 * Deliberately small: it mounts only what a discovery-node session needs, so the
 * tests exercise the package against production services rather than a stub.
 */
export async function harness(
  adapter: MockAdapter = new MockAdapter([textResponse('ok')]),
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: 'stable base' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(RsiTrace)
  return ctx
}

/** Resolve once the given agent has finished the work it was given. */
export function waitForIdle(ctx: Context, agent: { id: string }): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject.id === agent.id && status === 'idle') { dispose(); resolve() }
    })
  })
}
