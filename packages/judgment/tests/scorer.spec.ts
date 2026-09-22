/**
 * The chunk scorer: what it will act on, and what it refuses to.
 *
 * The interesting cases are the refusals. A scorer that reduces content on a
 * verdict it was not confident about produces a silent quality regression that
 * surfaces far from its cause, so "kept and flagged" is the behaviour worth
 * pinning.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ChunkScorer,
  DEFAULT_CONFIDENCE_FLOOR,
  reducesContent,
  summariseVerdicts,
} from '../src/index.ts'
import type {
  Answers,
  JudgmentProvider,
  JudgmentRequest,
  ScoreableChunk,
} from '../src/index.ts'

/** A provider that answers from a script, so the scorer can be tested alone. */
function scriptedProvider(script: (request: JudgmentRequest) => Answers): JudgmentProvider {
  return { name: 'scripted', judge: (request) => Promise.resolve(script(request)) }
}

function choice(tier: string, confidence: number) {
  return {
    ok: true as const,
    answer: {
      type: 'choice' as const,
      choice: tier,
      probabilities: {},
      confidence,
    },
  }
}

const chunks: readonly ScoreableChunk[] = [
  { id: 'a', bytes: 10, kind: 'read' },
  { id: 'b', bytes: 10, kind: 'bash' },
]

describe('ChunkScorer', () => {
  it('applies a confident reduction', async () => {
    const scorer = new ChunkScorer({
      provider: scriptedProvider(() => ({ a: choice('gist', 0.95), b: choice('full', 0.9) })),
    })
    const verdicts = await scorer.score(chunks)

    expect(verdicts.map(v => v.tier)).toEqual(['gist', 'full'])
    expect(verdicts[0]!.actionable).toBe(true)
    expect(reducesContent(verdicts[0]!)).toBe(true)
    expect(reducesContent(verdicts[1]!)).toBe(false)
  })

  it('KEEPS content and flags escalation when confidence is below the floor', async () => {
    const scorer = new ChunkScorer({
      provider: scriptedProvider(() => ({ a: choice('none', 0.5), b: choice('full', 0.9) })),
      confidenceFloor: 0.8,
    })
    const verdicts = await scorer.score(chunks)

    // The dangerous case: a provider willing to drop the chunk, at a confidence
    // the scorer does not trust. Keeping costs tokens; hiding costs quality
    // silently, so this is not a close call.
    expect(verdicts[0]!.tier).toBe('full')
    expect(verdicts[0]!.actionable).toBe(false)
    expect(reducesContent(verdicts[0]!)).toBe(false)
    expect(verdicts[0]!.reason).toContain('below the 0.8 floor')
    expect(summariseVerdicts(verdicts).keptForEscalation).toBe(1)
  })

  it('overrules a provider that reduces a chunk the caller pinned', async () => {
    const scorer = new ChunkScorer({
      provider: scriptedProvider(() => ({ a: choice('none', 0.99), b: choice('full', 0.9) })),
    })
    const verdicts = await scorer.score([{ ...chunks[0]!, pinned: true }, chunks[1]!])

    // The caller's claim is direct evidence; the provider's is inferred from
    // structure it may not have seen.
    expect(verdicts[0]!.tier).toBe('full')
    expect(verdicts[0]!.reason).toContain('pinned')
  })

  it('keeps everything when the provider cannot answer', async () => {
    const scorer = new ChunkScorer({
      provider: scriptedProvider(() => ({
        a: { ok: false, reason: 'no basis for a truth claim' },
      })),
    })
    const verdicts = await scorer.score(chunks)

    // A missing answer is not a licence to guess, and a caller that received
    // fewer verdicts than chunks would mis-associate them.
    expect(verdicts).toHaveLength(2)
    expect(verdicts.every(v => v.tier === 'full')).toBe(true)
    expect(verdicts[0]!.reason).toContain('no basis for a truth claim')
  })

  it('can measure without acting, for evaluating a threshold offline', async () => {
    const scorer = new ChunkScorer({
      provider: scriptedProvider(() => ({ a: choice('none', 0.99), b: choice('none', 0.99) })),
      allowReduction: false,
    })
    const verdicts = await scorer.score(chunks)

    expect(verdicts.every(v => v.tier === 'full')).toBe(true)
    expect(verdicts[0]!.reason).toContain('reduction disabled')
  })

  it('asks ONE provider call for the whole batch', async () => {
    const judge = vi.fn(() => Promise.resolve({ a: choice('full', 1), b: choice('full', 1) }))
    const scorer = new ChunkScorer({ provider: { name: 'spy', judge } })
    await scorer.score(Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, bytes: 4 })))

    // One call for twenty chunks is the property that makes per-chunk scoring
    // affordable; one call per chunk reintroduces the linear cost.
    expect(judge).toHaveBeenCalledTimes(1)
  })

  it('sends chunk bodies in the state, never inside a question', async () => {
    let seen: JudgmentRequest | undefined
    const scorer = new ChunkScorer({
      provider: scriptedProvider(request => {
        seen = request
        return { a: choice('full', 1), b: choice('full', 1) }
      }),
    })
    await scorer.score([{ id: 'a', bytes: 4, text: 'SECRET BODY' }, { id: 'b', bytes: 4 }])

    // State and questions share one budget: a body inside an instruction
    // overruns the cap while each question still looks small.
    expect(JSON.stringify(seen!.state)).toContain('SECRET BODY')
    expect(JSON.stringify(seen!.questions)).not.toContain('SECRET BODY')
  })

  it('refuses a nonsensical floor at construction', () => {
    const provider = scriptedProvider(() => ({}))
    expect(() => new ChunkScorer({ provider, confidenceFloor: -0.1 })).toThrow(RangeError)
    expect(() => new ChunkScorer({ provider, confidenceFloor: 1.5 })).toThrow(RangeError)
  })

  it('has a conservative default floor', () => {
    expect(DEFAULT_CONFIDENCE_FLOOR).toBeGreaterThanOrEqual(0.8)
  })

  it('answers an empty batch without calling the provider', async () => {
    const judge = vi.fn(() => Promise.resolve({}))
    const scorer = new ChunkScorer({ provider: { name: 'spy', judge } })
    expect(await scorer.score([])).toEqual([])
    expect(judge).not.toHaveBeenCalled()
  })
})

describe('summariseVerdicts', () => {
  it('counts tiers and separates actionable reductions from escalations', async () => {
    const scorer = new ChunkScorer({
      provider: scriptedProvider(() => ({
        a: choice('gist', 0.95),
        b: choice('none', 0.4),
      })),
    })
    const summary = summariseVerdicts(await scorer.score(chunks))

    expect(summary.perTier.full).toBe(1) // b kept for escalation
    expect(summary.perTier.gist).toBe(1)
    expect(summary.actionableReductions).toBe(1)
    expect(summary.keptForEscalation).toBe(1)
  })
})
