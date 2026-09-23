/**
 * Context policy for dsh: score the surface, price the reductions, and hand the
 * work to whatever compaction engine is already mounted.
 *
 * This is the adapter between the pure decision layer
 * (`@unreal-harness/judgment`) and a live session. It deliberately does
 * NOT register its own `CompactionEngine`: `ctx.compaction` is a single service,
 * so a second registration would collide with `compaction-basic`, and replacing
 * it would take over summarisation — a different and much larger job than
 * deciding what is worth reducing.
 *
 * Instead this service *advises*. It reads the session's surface, scores each
 * node, asks the cache model whether acting is worth the break, and reports what
 * it would do and why. `apply()` then hands the selected ranges to the mounted
 * engine, which keeps dsh's own compaction semantics — balanced tool pairing,
 * the durable marker pair, token accounting — as the single implementation.
 *
 * Keeping the two apart is what makes the scoring testable without a provider
 * and the compaction unchanged for every deployment that does not opt in.
 * @module
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
// Type-only: brings the `ctx.compaction` declaration into scope. A runtime import
// would make this package depend on a specific engine.
import type { CompactionAgentContext } from '@deepseek-ai/dsh-compaction'
import {
  ChunkScorer,
  HeuristicJudgmentProvider,
  planRebuild,
  summariseVerdicts,
  type ChunkVerdict,
  type JudgmentProvider,
  type RebuildPlan,
  type ScoreableChunk,
  type TokenPrices,
} from '@unreal-harness/judgment'

/**
 * Off-peak DeepSeek rates, per million tokens.
 *
 * The default so that a config-free mount prices reductions instead of crashing.
 * `harbor/tools/pricing.py` holds the full peak/off-peak table; these are the
 * off-peak figures, the cheaper and therefore more conservative pair for a
 * decision about whether breaking the cache is worth it.
 */
export const DEFAULT_PRICES: TokenPrices = Object.freeze({
  cacheMissPerMillion: 0.15,
  cacheHitPerMillion: 0.003,
})

export const name = 'rsi-context'
export const inject = ['sessionProjections', 'compaction']

declare module '@deepseek-ai/cordis' {
  interface Context {
    rsiContext: RsiContext
  }
}

/** One surface node presented for scoring. */
export interface SurfaceCandidate {
  /** Durable seq of the surface node — the span's identity for an engine call. */
  readonly seq: SessionSeq
  /** Request-pressure tokens this node currently costs. */
  readonly tokens: number
  /** A caller-supplied kind hint, such as the producing tool's name. */
  readonly kind?: string
}

/** What the policy would do, with the arithmetic that produced it. */
export interface ContextRecommendation {
  readonly verdicts: readonly ChunkVerdict[]
  readonly plan: RebuildPlan
  /** Ranges worth reducing, as inclusive seq spans, for the mounted engine. */
  readonly spans: readonly { readonly start: SessionSeq; readonly end: SessionSeq }[]
  /** Totals for a cost report, so a caller need not re-derive them. */
  readonly totals: {
    readonly perTier: Readonly<Record<string, number>>
    readonly actionableReductions: number
    readonly keptForEscalation: number
    readonly tokensSavedPerRequest: number
    readonly estimatedCacheBreakCost: number
    readonly saves: boolean
  }
}

/** How the policy is configured. */
export interface RsiContextConfig {
  /**
   * Where the judgments come from.
   *
   * Defaults to the zero-cost structural provider, so mounting this plugin
   * without a config works. An earlier revision required it, and the effect was
   * that the plugin mounted, threw `Cannot read properties of undefined (reading
   * 'provider')` during construction, and produced no context at all -- the same
   * silent-inertness failure this layer exists to avoid. A deployment that wants
   * model-backed judgment passes one explicitly; a test passes a scripted one.
   */
  readonly provider?: JudgmentProvider
  /**
   * Provider prices, used to decide whether a reduction is worth its cache break.
   *
   * Defaults to the off-peak DeepSeek rate card, which is what the benchmark in
   * this repository measures against. A deployment on a different rate card
   * passes its own rather than inheriting a wrong one silently.
   */
  readonly prices?: TokenPrices
  /**
   * How many further requests this context is expected to serve.
   *
   * The multiplier on a saving. Defaults to one, the conservative reading, because
   * a caller that does not know its reuse should not be credited with it.
   */
  readonly expectedReuses?: number
  /** Minimum confidence for a reduction to be actionable. */
  readonly confidenceFloor?: number
  /** Index in the surface up to which the prefix is cached, exclusive. */
  readonly cachedUpTo?: number
}

/**
 * Read-only advisory service over the session surface.
 *
 * Stateless per call: every method takes the session it reads, because dsh's
 * projection registry is already per-session and a per-session instance would add
 * a lifetime to manage for no benefit.
 */
export class RsiContext extends Service {
  private readonly scorer: ChunkScorer
  private readonly config: RsiContextConfig

  constructor(ctx: Context, config: RsiContextConfig = {}) {
    super(ctx, 'rsiContext')
    this.config = config
    this.scorer = new ChunkScorer({
      provider: config.provider ?? new HeuristicJudgmentProvider(),
      ...config.confidenceFloor === undefined ? {} : { confidenceFloor: config.confidenceFloor },
    })
  }

  /**
   * Score surface nodes and price the reductions.
   *
   * Reads only: nothing is appended and no engine is called, so a caller can run
   * this on live traffic to see what the policy WOULD do before trusting it. The
   * candidates arrive from the caller rather than being read here, because only
   * the caller knows which session's surface it wants scored and how to map the
   * surface onto node identities.
   * @param candidates - the surface nodes to consider, in surface order.
   * @param signal - cancellation for the judgment call.
   * @returns the verdicts, the priced plan, and the spans to hand to an engine.
   */
  async recommend(
    candidates: readonly SurfaceCandidate[],
    signal?: AbortSignal,
  ): Promise<ContextRecommendation> {
    const chunks: ScoreableChunk[] = candidates.map(candidate => ({
      id: String(candidate.seq),
      bytes: candidate.tokens,
      ...candidate.kind === undefined ? {} : { kind: candidate.kind },
    }))

    const verdicts = await this.scorer.score(chunks, signal)

    // Every node is a candidate for reduction, and the reduced size is modelled as
    // a fraction of the original. A real summary length is the engine's business;
    // pricing a plausible one is what lets the cache decision be made BEFORE the
    // summarisation is paid for.
    const reducedFraction = 0.1
    const rebuildCandidates = candidates.map((candidate, index) => ({
      id: String(candidate.seq),
      tokens: candidate.tokens,
      reducedTokens: Math.floor(candidate.tokens * reducedFraction),
      verdict: verdicts[index]!,
    }))

    const plan = planRebuild(
      rebuildCandidates,
      {
        order: candidates.map(candidate => String(candidate.seq)),
        cachedUpTo: this.config.cachedUpTo ?? 0,
        ...this.config.expectedReuses === undefined ? {} : { expectedReuses: this.config.expectedReuses },
      },
      this.config.prices ?? DEFAULT_PRICES,
    )

    const bySeq = new Map(candidates.map(candidate => [String(candidate.seq), candidate.seq]))
    const spans = plan.decisions
      .filter(decision => decision.apply)
      .flatMap(decision => {
        const seq = bySeq.get(decision.id)
        // A span is a single node here. Widening it to a range would be an
        // engine-level decision about tool pairing, which this layer does not own.
        return seq === undefined ? [] : [{ start: seq, end: seq }]
      })

    const summary = summariseVerdicts(verdicts)
    return {
      verdicts,
      plan,
      spans,
      totals: {
        perTier: summary.perTier,
        actionableReductions: summary.actionableReductions,
        keptForEscalation: summary.keptForEscalation,
        tokensSavedPerRequest: plan.tokensSavedPerRequest,
        estimatedCacheBreakCost: plan.estimatedCacheBreakCost,
        saves: plan.saves,
      },
    }
  }

  /**
   * Hand selected spans to the mounted compaction engine.
   *
   * The engine owns balanced tool pairing, the durable marker pair, and token
   * accounting; this method only chooses which spans to pass. A span the engine
   * refuses rejects here rather than being silently dropped, so a caller learns
   * that its recommendation was not honoured.
   * @param recommendation - a value from {@link RsiContext.recommend}.
   * @param agent - the agent context the engine requires.
   * @param signal - cancellation forwarded to the engine.
   * @returns how many spans were compacted, and those the engine refused.
   */
  async apply(
    recommendation: ContextRecommendation,
    agent: CompactionAgentContext,
    signal?: AbortSignal,
  ): Promise<{ readonly compacted: number; readonly refused: readonly string[] }> {
    let compacted = 0
    const refused: string[] = []
    for (const span of recommendation.spans) {
      try {
        await this.ctx.compaction.compactRegion(span.start, span.end, agent, signal)
        compacted += 1
      } catch (error) {
        // Reported rather than thrown: one span the engine declines (an unbalanced
        // tool pair, say) should not abandon the rest of the recommendation.
        refused.push(`${String(span.start)}: ${error instanceof Error ? error.message : 'refused'}`)
      }
    }
    return { compacted, refused }
  }
}

/**
 * Mount the advisory service.
 * @param ctx - the mounting context.
 * @param config - the provider, prices, and policy knobs.
 */
export function apply(ctx: Context, config: RsiContextConfig = {}): void {
  ctx.plugin(RsiContext, config)
}

export default RsiContext
