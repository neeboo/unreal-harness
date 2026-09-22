/**
 * The chunk scorer: decide how much of each piece of context the task needs.
 *
 * This is the layer that turns "the context is too long" into a per-chunk
 * decision with a reason. It sits between two hard constraints and is shaped by
 * both:
 *
 * - **Model input is expensive, and cache reuse is what makes it cheap.** A
 *   downgrade is a `replace`, which invalidates the cached prefix from that
 *   point. So the scorer produces a *verdict*, and cost is decided afterwards by
 *   a caller that knows the cache geometry. Scoring and pricing are separate
 *   because they have different inputs and different failure modes.
 * - **A confident wrong hiding is worse than an expensive context.** Dropping the
 *   one chunk that mattered is a silent quality regression that surfaces far from
 *   its cause, so a verdict below the confidence floor never hides content — it
 *   is marked for escalation instead.
 *
 * The escalation path is the point of using a cheap provider first: structural
 * answers are free and settle most chunks, and only the genuinely undecided
 * middle needs to cost anything.
 * @module
 */

import { mayAct } from './types.ts'
import type { AnswerOrFailure, ChoiceAnswer, JudgmentProvider } from './types.ts'
import { TIER_CRITERIA } from './wire.ts'
import type { JevTier } from './wire.ts'

/** One piece of context presented for scoring. */
export interface ScoreableChunk {
  /** Stable identity, used as the `source` of any replacement. */
  readonly id: string
  /** Content length in bytes, used by structural providers. */
  readonly bytes: number
  /** A caller-supplied kind hint, such as a tool name. */
  readonly kind?: string
  /**
   * The chunk's text, sent as part of the judged state.
   *
   * Optional so a caller can score by structure alone without paying to send
   * content — the cheap path. A provider needs it only for the escalation.
   */
  readonly text?: string
  /** The caller already knows this matters, so no rule may reduce it. */
  readonly pinned?: boolean
}

/** What the scorer decided about one chunk. */
export interface ChunkVerdict {
  readonly id: string
  /** The tier selected: least to most complete. */
  readonly tier: JevTier
  /** The provider's confidence in that tier, in `[0, 1]`. */
  readonly confidence: number
  /**
   * Whether the verdict is trustworthy enough to act on.
   *
   * `false` means the caller must not reduce this chunk on this verdict alone.
   * It is a first-class field rather than something a caller re-derives, because
   * the threshold is the scorer's policy and re-deriving it invites drift.
   */
  readonly actionable: boolean
  /** Which provider answered, so a cost report can attribute the spend. */
  readonly provider: string
  /** Why, in a form an audit can read later. */
  readonly reason: string
}

/** How the scorer is configured. */
export interface ChunkScorerOptions {
  /** The provider asked about the uncertain chunks. */
  readonly provider: JudgmentProvider
  /**
   * Minimum confidence for a reduction to be actionable.
   *
   * The single most consequential number here. Below it the scorer keeps content
   * and marks the verdict for escalation; a caller that lowers it trades context
   * length for silent quality loss.
   */
  readonly confidenceFloor?: number
  /**
   * Whether a verdict may reduce content at all.
   *
   * Set `false` for a pure measurement pass — useful for evaluating a threshold
   * against recorded traffic before trusting it with a live context.
   */
  readonly allowReduction?: boolean
}

/** Default floor. Deliberately conservative: hiding needs to be earned. */
export const DEFAULT_CONFIDENCE_FLOOR = 0.8

/** The most complete tier, which is also "keep everything". */
const FULL_TIER: JevTier = 'full'

/**
 * Score chunks and decide which reductions are safe to apply.
 *
 * Chunks and their verdicts are matched by id. Every input chunk gets a verdict:
 * a chunk the provider failed to answer is reported as non-actionable rather
 * than omitted, because a caller that receives fewer verdicts than chunks will
 * mis-associate them.
 */
export class ChunkScorer {
  private readonly floor: number
  private readonly allowReduction: boolean

  constructor(private readonly options: ChunkScorerOptions) {
    this.floor = options.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR
    if (!(this.floor >= 0 && this.floor <= 1)) {
      throw new RangeError(`confidenceFloor must be in [0, 1], received ${this.floor}`)
    }
    this.allowReduction = options.allowReduction ?? true
  }

  /**
   * Score one batch of chunks.
   *
   * One provider call for the whole batch, not one per chunk: that is what keeps
   * per-chunk scoring affordable, and a caller with more chunks than one call
   * allows should split before calling this rather than calling it per chunk.
   * @param chunks - the chunks to score.
   * @param signal - cancellation for the whole batch.
   * @returns one verdict per chunk, in input order.
   */
  async score(
    chunks: readonly ScoreableChunk[],
    signal?: AbortSignal,
  ): Promise<readonly ChunkVerdict[]> {
    if (chunks.length === 0) return []

    const questions: Record<string, { type: 'choice'; instructions: string; criteria: Readonly<Record<JevTier, string>> }> = {}
    const features: Record<string, { id: string; bytes: number; kind?: string; pinned?: boolean }> = {}
    for (const chunk of chunks) {
      questions[chunk.id] = {
        type: 'choice',
        instructions: 'How much of this output does the task need?',
        criteria: TIER_CRITERIA,
      }
      features[chunk.id] = {
        id: chunk.id,
        bytes: chunk.bytes,
        ...chunk.kind === undefined ? {} : { kind: chunk.kind },
        ...chunk.pinned === undefined ? {} : { pinned: chunk.pinned },
      }
    }

    const answers = await this.options.provider.judge(
      {
        // The chunk bodies live in `state`, never in `instructions`: state and
        // questions share one budget, so putting content in the question would
        // overrun the cap while each question looked small.
        state: { chunks: chunks.map(chunk => ({
          id: chunk.id,
          ...chunk.kind === undefined ? {} : { kind: chunk.kind },
          ...chunk.text === undefined ? {} : { text: chunk.text },
        })) },
        questions,
      },
      signal,
    )

    return chunks.map(chunk => this.verdictFor(chunk, answers[chunk.id]))
  }

  private verdictFor(
    chunk: ScoreableChunk,
    answer: AnswerOrFailure | undefined,
  ): ChunkVerdict {
    if (answer === undefined || !answer.ok) {
      // No answer is not a licence to guess: keep everything and say so.
      return this.keep(chunk, `no usable judgment: ${answer?.ok === false ? answer.reason : 'missing'}`)
    }

    const choice = answer.answer as ChoiceAnswer<JevTier>
    if (chunk.pinned === true && choice.choice !== FULL_TIER) {
      // A pinned chunk outranks a provider: the caller's claim is direct
      // evidence and the provider's is inferred from structure it may not have.
      return {
        ...this.keep(chunk, 'pinned by the caller; the provider is overruled'),
        confidence: choice.confidence,
      }
    }

    if (!this.allowReduction && choice.choice !== FULL_TIER) {
      return this.keep(chunk, 'reduction disabled for this pass')
    }

    const actionable = mayAct(answer as AnswerOrFailure<ChoiceAnswer<JevTier>>, choice.choice, this.floor)
    if (choice.choice !== FULL_TIER && !actionable) {
      // The dangerous case, handled explicitly: a reduction the provider was not
      // confident about is NOT applied. Keeping the content costs tokens; hiding
      // it costs quality silently.
      return {
        id: chunk.id,
        tier: FULL_TIER,
        confidence: choice.confidence,
        actionable: false,
        provider: this.options.provider.name,
        reason: `would reduce to "${choice.choice}" at confidence ${choice.confidence.toFixed(2)}, below the ${this.floor} floor; kept and flagged for escalation`,
      }
    }

    return {
      id: chunk.id,
      tier: choice.choice,
      confidence: choice.confidence,
      actionable,
      provider: this.options.provider.name,
      reason: actionable
        ? `provider judged "${choice.choice}" at confidence ${choice.confidence.toFixed(2)}`
        : `kept whole by provider judgment`,
    }
  }

  private keep(chunk: ScoreableChunk, reason: string): ChunkVerdict {
    return {
      id: chunk.id,
      tier: FULL_TIER,
      confidence: 1,
      actionable: true,
      provider: this.options.provider.name,
      reason,
    }
  }
}

/**
 * Whether a verdict asks for the content to be reduced.
 * @param verdict - the verdict to inspect.
 * @returns whether content would be dropped or shortened.
 */
export function reducesContent(verdict: ChunkVerdict): boolean {
  return verdict.tier !== FULL_TIER
}

/**
 * A one-line summary of what a batch of verdicts would do, for a cost report.
 * @param verdicts - the verdicts to summarise.
 * @returns counts per tier plus how many reductions are actionable.
 */
export function summariseVerdicts(verdicts: readonly ChunkVerdict[]): {
  readonly perTier: Readonly<Record<JevTier, number>>
  readonly actionableReductions: number
  readonly keptForEscalation: number
} {
  const perTier: Record<JevTier, number> = { none: 0, gist: 0, key: 0, full: 0 }
  let actionableReductions = 0
  let keptForEscalation = 0
  for (const verdict of verdicts) {
    perTier[verdict.tier] += 1
    if (reducesContent(verdict) && verdict.actionable) actionableReductions += 1
    if (!verdict.actionable) keptForEscalation += 1
  }
  return { perTier, actionableReductions, keptForEscalation }
}
