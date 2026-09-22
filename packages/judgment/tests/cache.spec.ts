/**
 * Cache-aware rebuilding: the arithmetic that decides whether hiding is worth a
 * cache break.
 *
 * The counter-intuitive case is the point of the module. Reducing a chunk that
 * sits INSIDE the cached prefix forces the rest of that prefix to be
 * re-prefilled, and on cache-hit pricing the re-prefill can dwarf the tokens
 * saved. A scorer that ignored this would confidently make the bill worse, so
 * the declined case has to be pinned.
 */
import { describe, expect, it } from 'vitest'
import { breakEvenReuses, planRebuild } from '../src/index.ts'
import type { CacheGeometry, ChunkVerdict, RebuildCandidate, TokenPrices } from '../src/index.ts'

/** Prices in the shape a real provider uses: a hit is ~50x cheaper than a miss. */
const PRICES: TokenPrices = { cacheMissPerMillion: 0.15, cacheHitPerMillion: 0.003 }

function verdict(id: string, tier: ChunkVerdict['tier'], actionable = true): ChunkVerdict {
  return { id, tier, confidence: 0.95, actionable, provider: 'test', reason: 'test verdict' }
}

function candidate(id: string, tokens: number, reducedTokens: number, tier: ChunkVerdict['tier']): RebuildCandidate {
  return { id, tokens, reducedTokens, verdict: verdict(id, tier) }
}

/** Four chunks the provider sees in order, with the first two cached. */
const geometry: CacheGeometry = { order: ['a', 'b', 'c', 'd'], cachedUpTo: 2 }

describe('planRebuild', () => {
  it('applies a reduction beyond the cached prefix for free', () => {
    // `c` sits after the cached prefix, so replacing it invalidates nothing.
    const plan = planRebuild([candidate('c', 10_000, 1_000, 'gist')], geometry, PRICES)

    expect(plan.decisions[0]!.apply).toBe(true)
    expect(plan.tokensSavedPerRequest).toBe(9_000)
    // The free case, and the reason a scorer should prefer reducing recent
    // context over old context.
    expect(plan.estimatedCacheBreakCost).toBe(0)
    expect(plan.saves).toBe(true)
  })

  it('declines a reduction INSIDE the cached prefix when the break costs more', () => {
    // `a` is cached, so reducing it forces the whole cached prefix (20k tokens)
    // to be re-prefilled. The reduction saves only 9k per request, and at one
    // expected reuse 9k at hit price cannot pay for 20k at miss price.
    const plan = planRebuild(
      [candidate('a', 10_000, 1_000, 'gist')],
      { ...geometry, expectedReuses: 1 },
      PRICES,
    )

    expect(plan.decisions[0]!.apply).toBe(false)
    expect(plan.decisions[0]!.reason).toContain('declined')
    expect(plan.saves).toBe(false)
    expect(plan.tokensSavedPerRequest).toBe(0)
  })

  it('accepts a reduction inside a SMALL cached prefix', () => {
    // Same prices and one expected reuse. The cached prefix here is one 1k chunk
    // rather than 110k, so a 6k saving clears the 1k re-prefill with room to
    // spare. The size of the break relative to the saving is what decides it.
    const small: CacheGeometry = { order: ['a', 'b'], cachedUpTo: 1, expectedReuses: 1 }
    const plan = planRebuild(
      [
        { id: 'a', tokens: 1_000, reducedTokens: 1_000, verdict: verdict('a', 'gist') },
        { id: 'b', tokens: 7_000, reducedTokens: 1_000, verdict: verdict('b', 'none') },
      ],
      small,
      PRICES,
    )

    const forB = plan.decisions.find(d => d.id === 'b')!
    expect(forB.apply).toBe(true)
    expect(forB.tokensSaved).toBe(6_000)
    expect(plan.saves).toBe(true)
  })

  it('shows that hiding inside a LARGE cached prefix is all but unaffordable', () => {
    // The honest conclusion, asserted so it cannot be forgotten: with a 50x
    // gap between miss and hit pricing, 9k saved against a 110k cached prefix
    // needs 612 reuses to pay for itself. Any policy that reduces old context
    // casually is a policy that raises the bill.
    expect(breakEvenReuses(9_000, 110_000, PRICES)).toBe(612)
    const plan = planRebuild(
      [candidate('a', 10_000, 1_000, 'gist')],
      { ...geometry, expectedReuses: 1 },
      PRICES,
    )
    expect(plan.decisions[0]!.apply).toBe(false)
  })

  it('accepts the same reduction once enough requests reuse the shorter context', () => {
    // The same 9k-for-20k trade, with reuse as the only change: this is what the
    // `expectedReuses` multiplier is for, and why a caller that does not know its
    // reuse should pass the conservative 1.
    const plan = planRebuild(
      [candidate('a', 10_000, 1_000, 'gist')],
      { ...geometry, expectedReuses: 200 },
      PRICES,
    )

    expect(plan.decisions[0]!.apply).toBe(true)
    expect(plan.tokensSavedPerRequest).toBe(9_000)
    expect(plan.saves).toBe(true)
    expect(plan.estimatedCacheBreakCost).toBeGreaterThan(0)
  })

  it('exposes the trap: a small reduction inside a cached prefix rarely pays', () => {
    // This is the case that makes a naive scorer make the bill WORSE, so it is
    // asserted rather than left to a comment. With a 50x gap between miss and hit
    // pricing, 9k saved cannot pay for 110k of re-prefill until the context is
    // reused 612 times — which is the honest answer, and the reason the design
    // refuses to hide old context casually.
    expect(breakEvenReuses(9_000, 110_000, PRICES)).toBe(612)

    // And the same reduction placed after the cached prefix is free — which is
    // why a scorer should prefer reducing recent context over old context.
    const free = planRebuild([candidate('c', 10_000, 1_000, 'gist')], geometry, PRICES)
    expect(free.decisions[0]!.apply).toBe(true)
    expect(free.estimatedCacheBreakCost).toBe(0)
  })

  it('does not apply a reduction the scorer did not find actionable', () => {
    const notActionable: RebuildCandidate = {
      id: 'c',
      tokens: 10_000,
      reducedTokens: 0,
      verdict: verdict('c', 'none', false),
    }
    const plan = planRebuild([notActionable], geometry, PRICES)

    expect(plan.decisions[0]!.apply).toBe(false)
    expect(plan.decisions[0]!.reason).toContain('no actionable reduction')
  })

  it('does not apply a reduction that saves nothing', () => {
    const plan = planRebuild([candidate('c', 500, 500, 'gist')], geometry, PRICES)
    expect(plan.decisions[0]!.apply).toBe(false)
    expect(plan.decisions[0]!.reason).toContain('would not save any tokens')
  })

  it('refuses to price a chunk the geometry does not place', () => {
    const plan = planRebuild([candidate('zzz', 9_000, 100, 'gist')], geometry, PRICES)

    // Guessing the position would misprice the break, and a wrong price is worse
    // than a declined reduction.
    expect(plan.decisions[0]!.apply).toBe(false)
    expect(plan.decisions[0]!.reason).toContain('does not place this chunk')
  })

  it('treats an empty cached prefix as the free case', () => {
    const cold: CacheGeometry = { order: ['a', 'b'], cachedUpTo: 0 }
    const plan = planRebuild([candidate('a', 5_000, 500, 'gist')], cold, PRICES)

    // Nothing was cached, so nothing can be invalidated.
    expect(plan.decisions[0]!.apply).toBe(true)
    expect(plan.estimatedCacheBreakCost).toBe(0)
  })

  it('totals the batch so a caller can judge it as a whole', () => {
    const plan = planRebuild(
      [candidate('c', 10_000, 1_000, 'gist'), candidate('d', 10_000, 1_000, 'none')],
      geometry,
      PRICES,
    )

    expect(plan.decisions.every(d => d.apply)).toBe(true)
    expect(plan.tokensSavedPerRequest).toBe(18_000)
    expect(plan.saves).toBe(true)
  })

  it('rejects an impossible reuse count rather than silently clamping it', () => {
    expect(() => planRebuild([], { ...geometry, expectedReuses: 0 }, PRICES)).toThrow(RangeError)
    expect(() => planRebuild([], { ...geometry, cachedUpTo: 99 }, PRICES)).toThrow(RangeError)
  })
})

describe('breakEvenReuses', () => {
  it('reports the exact number of reuses a cache break needs', () => {
    expect(breakEvenReuses(9_000, 110_000, PRICES)).toBe(612)

    // Monotone in both directions: saving more helps, breaking more hurts.
    expect(breakEvenReuses(18_000, 110_000, PRICES)!).toBeLessThan(612)
    expect(breakEvenReuses(9_000, 220_000, PRICES)!).toBeGreaterThan(612)
  })

  it('is undefined when a reduction saves nothing, or cache hits are not cheaper', () => {
    expect(breakEvenReuses(0, 1_000, PRICES)).toBeUndefined()
    expect(breakEvenReuses(-5, 1_000, PRICES)).toBeUndefined()
    // A provider that charges nothing for a hit can never be paid back by reuse.
    expect(
      breakEvenReuses(1_000, 1_000, { cacheMissPerMillion: 1, cacheHitPerMillion: 0 }),
    ).toBeUndefined()
  })
})
