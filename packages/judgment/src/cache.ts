/**
 * Cache-aware rebuilding: decide whether a downgrade is worth its cache break.
 *
 * A context reduction is not free even when the model call is. Downgrading a
 * chunk means replacing a surface range, which invalidates the cached prefix
 * from that point on — so the saving is measured in tokens *not sent*, and the
 * cost is measured in tokens *re-prefilled*. On a cache-hit path the second
 * number dwarfs the first, and a scorer that ignored this would confidently make
 * the bill worse.
 *
 * That is why this module exists separately from {@link ChunkScorer}: the scorer
 * answers "does the task need this", and this answers "is acting on that worth
 * it". The two have different inputs — one has the content, the other has the
 * cache geometry and the price — and different failure modes.
 *
 * # The model is deliberately simple and explicit
 *
 * No learned weights and no hidden constants: a saving is compared against a
 * cost with prices the caller supplies. A caller that disagrees with the numbers
 * changes them, and a decision is reproducible from the plan it produced.
 * @module
 */

import { reducesContent } from './scorer.ts'
import type { ChunkVerdict } from './scorer.ts'

/** What the provider actually charges, per million tokens. */
export interface TokenPrices {
  /** Price of input tokens that miss the cache. */
  readonly cacheMissPerMillion: number
  /** Price of input tokens that hit the cache. */
  readonly cacheHitPerMillion: number
}

/**
 * Where the cache stands for the request being rebuilt.
 *
 * `cachedUpTo` is the position through which the provider can reuse its prefix.
 * A replacement at or before that position breaks the cache; one after it does
 * not, because the prefix it would invalidate was never cached.
 */
export interface CacheGeometry {
  /**
   * Ordered chunk ids as the provider sees them, earliest first.
   *
   * Order matters because a cache break is positional: replacing an early chunk
   * invalidates everything after it, while replacing a late one invalidates
   * nothing that was still reusable.
   */
  readonly order: readonly string[]
  /** Index into `order` up to which the prefix is cached, exclusive. `0` means nothing. */
  readonly cachedUpTo: number
  /**
   * How many further requests this context is expected to serve before it
   * changes again.
   *
   * The multiplier on the saving. One further request makes a reduction barely
   * worth it; twenty make it decisive. A caller that does not know should pass
   * `1`, which is the conservative reading.
   */
  readonly expectedReuses?: number
}

/** One chunk's measured size and verdict, as the rebuild sees it. */
export interface RebuildCandidate {
  readonly id: string
  /** Tokens this chunk currently occupies in the request. */
  readonly tokens: number
  /** Tokens it would occupy after the reduction. */
  readonly reducedTokens: number
  readonly verdict: ChunkVerdict
}

/** What the rebuild decided to do with one chunk. */
export interface RebuildDecision {
  readonly id: string
  /** Whether the reduction should be applied. */
  readonly apply: boolean
  /** Tokens saved per request when applied. */
  readonly tokensSaved: number
  /** Why, in a form an audit can read. */
  readonly reason: string
}

/** The complete plan, with the arithmetic that produced it. */
export interface RebuildPlan {
  readonly decisions: readonly RebuildDecision[]
  /** Total tokens saved per request across applied reductions. */
  readonly tokensSavedPerRequest: number
  /** Estimated cost of the cache invalidation the applied reductions cause, in currency units. */
  readonly estimatedCacheBreakCost: number
  /** Whether the rebuild is a net saving under the supplied prices. */
  readonly saves: boolean
}

/** Default reuse assumption: conservative, one further request. */
const DEFAULT_REUSES = 1

/**
 * Decide which reductions to apply, given the cache geometry and prices.
 *
 * Each candidate is evaluated on its own arithmetic, and the plan reports the
 * total so a caller can see whether the batch as a whole was worth it — a set of
 * individually marginal reductions can still be a clear win or a clear loss
 * together, and only the caller knows which side it is on.
 * @param candidates - chunks with their sizes and verdicts.
 * @param geometry - where the cache stands.
 * @param prices - what the provider charges.
 * @returns the plan, including the reductions it declined and why.
 */
export function planRebuild(
  candidates: readonly RebuildCandidate[],
  geometry: CacheGeometry,
  prices: TokenPrices,
): RebuildPlan {
  const reuses = geometry.expectedReuses ?? DEFAULT_REUSES
  if (reuses < 1) {
    throw new RangeError(`expectedReuses must be at least 1, received ${reuses}`)
  }
  if (geometry.cachedUpTo < 0 || geometry.cachedUpTo > geometry.order.length) {
    throw new RangeError(
      `cachedUpTo must be within [0, ${geometry.order.length}], received ${geometry.cachedUpTo}`,
    )
  }

  const position = new Map(geometry.order.map((id, index) => [id, index]))
  const decisions: RebuildDecision[] = []
  let tokensSavedPerRequest = 0
  let estimatedCacheBreakCost = 0

  for (const candidate of candidates) {
    const saved = candidate.tokens - candidate.reducedTokens
    const requested = reducesContent(candidate.verdict) && candidate.verdict.actionable

    if (!requested) {
      decisions.push({
        id: candidate.id,
        apply: false,
        tokensSaved: 0,
        reason: `no actionable reduction: ${candidate.verdict.reason}`,
      })
      continue
    }
    if (saved <= 0) {
      decisions.push({
        id: candidate.id,
        apply: false,
        tokensSaved: 0,
        reason: 'the reduction would not save any tokens',
      })
      continue
    }

    const index = position.get(candidate.id)
    if (index === undefined) {
      // A candidate the geometry does not place cannot be priced, and guessing
      // its position would misprice the break. Refusing is the honest answer.
      decisions.push({
        id: candidate.id,
        apply: false,
        tokensSaved: 0,
        reason: 'the cache geometry does not place this chunk, so its break cannot be priced',
      })
      continue
    }

    if (index >= geometry.cachedUpTo) {
      // The reduction lands after the cached prefix, so nothing reusable is
      // invalidated: this is the free case, and the reason a scorer should
      // prefer reducing recent context over old context.
      decisions.push({
        id: candidate.id,
        apply: true,
        tokensSaved: saved,
        reason: `saves ${saved} tokens per request with no cache break (position ${index} is beyond the cached prefix)`,
      })
      tokensSavedPerRequest += saved
      continue
    }

    // The reduction breaks the cache. Everything from the replacement to the end
    // of the cached prefix must be re-prefilled on the NEXT request; later
    // requests reuse the new, shorter prefix.
    const invalidated = tokensFrom(candidates, geometry.order, index, geometry.cachedUpTo)
    const breakCost = (invalidated * prices.cacheMissPerMillion) / 1_000_000
    const savingOverReuses = (saved * reuses * prices.cacheHitPerMillion) / 1_000_000

    const worthIt = savingOverReuses > breakCost
    decisions.push({
      id: candidate.id,
      apply: worthIt,
      tokensSaved: worthIt ? saved : 0,
      reason: worthIt
        ? `saves ${saved} tokens per request over ${reuses} reuse(s) for ${breakCost.toFixed(6)} of re-prefill, which is cheaper`
        : `declined: breaks ${invalidated} cached tokens for ${breakCost.toFixed(6)}, more than the ${savingOverReuses.toFixed(6)} saved over ${reuses} reuse(s)`,
    })
    if (worthIt) {
      tokensSavedPerRequest += saved
      estimatedCacheBreakCost += breakCost
    }
  }

  const totalSaving = (tokensSavedPerRequest * reuses * prices.cacheHitPerMillion) / 1_000_000
  return {
    decisions,
    tokensSavedPerRequest,
    estimatedCacheBreakCost,
    saves: totalSaving > estimatedCacheBreakCost,
  }
}

/** Sum the tokens of the chunks in `order` between two positions. */
function tokensFrom(
  candidates: readonly RebuildCandidate[],
  order: readonly string[],
  from: number,
  to: number,
): number {
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]))
  let total = 0
  for (let index = from; index < to; index += 1) {
    const id = order[index]
    if (id === undefined) continue
    total += byId.get(id)?.tokens ?? 0
  }
  return total
}

/**
 * The break-even reuse count for one reduction, or `undefined` when a break can
 * never pay for itself at the supplied prices.
 *
 * Exposed because it is the number a caller actually reasons about: "how many
 * more requests must reuse this context before hiding this chunk is worth
 * re-prefilling?" A result of `undefined` means cache-hit pricing is not cheaper
 * than cache-miss pricing, in which case no amount of reuse justifies a break.
 * @param savedTokens - tokens saved per request.
 * @param invalidatedTokens - cached tokens the break would force to be re-prefilled.
 * @param prices - what the provider charges.
 * @returns the minimum reuse count, or `undefined` when it can never break even.
 */
export function breakEvenReuses(
  savedTokens: number,
  invalidatedTokens: number,
  prices: TokenPrices,
): number | undefined {
  if (savedTokens <= 0) return undefined
  const perReuseSaving = (savedTokens * prices.cacheHitPerMillion) / 1_000_000
  if (perReuseSaving <= 0) return undefined
  const breakCost = (invalidatedTokens * prices.cacheMissPerMillion) / 1_000_000
  return Math.ceil(breakCost / perReuseSaving)
}
