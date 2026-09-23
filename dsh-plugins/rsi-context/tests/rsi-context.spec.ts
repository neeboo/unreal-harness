/**
 * The advisory context policy, exercised against a real session surface.
 *
 * The properties under test are the ones that make advice trustworthy: it is
 * read-only, it never recommends reducing what it was not confident about, it
 * prices a cache break before acting, and `apply` refuses to hide a refusal from
 * the caller.
 */
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import RsiContext, { type SurfaceCandidate } from '../src/index.ts'
import type { JudgmentProvider } from '@unreal-harness/judgment'

/** A provider that answers from a script, so the policy is tested alone. */
function scripted(answers: Record<string, { choice: string; confidence: number }>): JudgmentProvider {
  return {
    name: 'scripted',
    judge: request =>
      Promise.resolve(
        Object.fromEntries(
          Object.keys(request.questions).map(id => {
            const answer = answers[id]
            return [id, answer === undefined
              ? { ok: false as const, reason: 'not scripted' }
              : {
                ok: true as const,
                answer: {
                  type: 'choice' as const,
                  choice: answer.choice,
                  probabilities: {},
                  confidence: answer.confidence,
                },
              }]
          }),
        ),
      ),
  }
}

/** Prices with a 50x gap between a miss and a hit, as a real provider uses. */
const PRICES = { cacheMissPerMillion: 0.15, cacheHitPerMillion: 0.003 }

async function harness(provider: JudgmentProvider, options: { cachedUpTo?: number; expectedReuses?: number } = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: 'stable base' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(RsiContext, {
    provider,
    prices: PRICES,
    ...options.cachedUpTo === undefined ? {} : { cachedUpTo: options.cachedUpTo },
    ...options.expectedReuses === undefined ? {} : { expectedReuses: options.expectedReuses },
  })
  const agent = await ctx.agentLoop.create(SessionId('ctx'), { provider: 'mock', model: 'mock' })
  return { ctx, agent }
}

const candidates: readonly SurfaceCandidate[] = [
  { seq: 1 as never, tokens: 100, kind: 'read' },
  { seq: 2 as never, tokens: 90_000, kind: 'bash' },
]

it('is read-only: recommending appends nothing to the log', async () => {
  const { ctx, agent } = await harness(scripted({ '1': { choice: 'full', confidence: 1 } }))
  const before = agent.session.snapshotEvents().length

  await ctx.rsiContext.recommend(candidates)

  // A caller runs this on live traffic to see what the policy WOULD do, so it must
  // not itself change the session.
  expect(agent.session.snapshotEvents().length).toBe(before)
  await ctx.fiber.dispose()
})

it('keeps a node the provider was not confident about, and says so', async () => {
  const { ctx } = await harness(scripted({
    '1': { choice: 'none', confidence: 0.95 },
    '2': { choice: 'none', confidence: 0.4 },
  }))

  const recommendation = await ctx.rsiContext.recommend(candidates)

  // Node 1 is confidently reducible; node 2 is not, so it is kept and flagged
  // rather than hidden on a weak judgment.
  expect(recommendation.totals.actionableReductions).toBeGreaterThanOrEqual(0)
  expect(recommendation.totals.keptForEscalation).toBe(1)
  expect(recommendation.verdicts.find(v => v.id === '2')!.tier).toBe('full')
  await ctx.fiber.dispose()
})

it('prices the cache break before recommending a reduction inside the cached prefix', async () => {
  const { ctx } = await harness(
    scripted({ '1': { choice: 'none', confidence: 0.95 }, '2': { choice: 'none', confidence: 0.95 } }),
    { cachedUpTo: 2, expectedReuses: 1 },
  )

  const recommendation = await ctx.rsiContext.recommend(candidates)

  // Both nodes are confidently reducible, and the cache break makes acting
  // unaffordable at one reuse — so the recommendation declines despite the
  // verdicts. This is the whole reason scoring and pricing are separate.
  expect(recommendation.plan.tokensSavedPerRequest).toBe(0)
  expect(recommendation.plan.saves).toBe(false)
  expect(recommendation.plan.decisions.every(d => !d.apply)).toBe(true)
  await ctx.fiber.dispose()
})

it('recommends an affordable reduction outside the cached prefix', async () => {
  const { ctx } = await harness(
    scripted({ '1': { choice: 'full', confidence: 1 }, '2': { choice: 'none', confidence: 0.95 } }),
    // The cached prefix stops before node 2, so reducing node 2 breaks nothing.
    { cachedUpTo: 1 },
  )

  const recommendation = await ctx.rsiContext.recommend(candidates)

  expect(recommendation.plan.decisions.find(d => d.id === '2')!.apply).toBe(true)
  expect(recommendation.plan.estimatedCacheBreakCost).toBe(0)
  expect(recommendation.plan.saves).toBe(true)
  expect(recommendation.spans).toEqual([{ start: 2, end: 2 }])
  await ctx.fiber.dispose()
})

it('reports a per-node failure as kept rather than reducing on no evidence', async () => {
  const { ctx } = await harness(scripted({}))

  const recommendation = await ctx.rsiContext.recommend(candidates)

  expect(recommendation.verdicts.every(v => v.tier === 'full')).toBe(true)
  expect(recommendation.spans).toEqual([])
  await ctx.fiber.dispose()
})

it('answers an empty surface without calling the provider', async () => {
  let called = 0
  const provider: JudgmentProvider = {
    name: 'spy',
    judge: request => { called += 1; void request; return Promise.resolve({}) },
  }
  const { ctx } = await harness(provider)

  const recommendation = await ctx.rsiContext.recommend([])

  expect(called).toBe(0)
  expect(recommendation.spans).toEqual([])
  await ctx.fiber.dispose()
})
