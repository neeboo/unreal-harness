/**
 * A zero-model-cost judgment provider.
 *
 * Every call to a model costs money, and a per-chunk scorer that calls one for
 * every chunk reintroduces exactly the linear cost that made scoring look
 * unattractive. This provider answers from structure alone — length, kind, and
 * the caller's own signal — so the cheap decisions never reach a model.
 *
 * It is the first provider the design calls for, not a placeholder for one. A
 * caller should reach for {@link HeuristicJudgmentProvider} by default and treat
 * a model-backed provider as the escalation for the uncertain middle.
 * @module
 */

import type {
  AnswerOrFailure,
  Answers,
  JudgmentProvider,
  JudgmentRequest,
  Question,
} from './types.ts'

/** A structural feature the heuristic reads from a chunk. */
export interface ChunkFeature {
  /** Stable chunk identity, matching the question id. */
  readonly id: string
  /**
   * Content length in bytes.
   *
   * Byte length rather than token count so a caller needs no tokeniser: the
   * judgement is about order of magnitude, and bytes give that for free.
   */
  readonly bytes: number
  /**
   * A caller-supplied kind hint, such as a tool name.
   *
   * Free-form on purpose. The heuristic only looks for the few kinds it knows,
   * and an unknown kind falls through to the length rule rather than failing.
   */
  readonly kind?: string
  /**
   * Whether the caller's own logic already decided this chunk matters.
   *
   * A caller that knows a chunk is load-bearing should not have to out-argue a
   * length rule. This is the escape hatch, and it is explicit so that "the
   * heuristic dropped something important" always traces to a caller that did
   * not mark it.
   */
  readonly pinned?: boolean
}

/** Length thresholds, in bytes, that separate the tiers. */
export interface HeuristicThresholds {
  /** At or below this, content is small enough to keep whole without thinking. */
  readonly small: number
  /** Above this, content is large enough that its size alone argues for cutting. */
  readonly large: number
}

/** Conservative defaults: keep more rather than less. */
export const DEFAULT_THRESHOLDS: HeuristicThresholds = Object.freeze({
  small: 2_048,
  large: 32_768,
})

/**
 * Kinds whose content is almost never useful in full.
 *
 * Kept tiny and obvious. Every entry here is a claim that a caller can check
 * against its own traffic, unlike a learned weight.
 */
const NOISY_KINDS: ReadonlySet<string> = new Set([
  'bash',
  'shell',
  'terminal',
  'test',
  'build',
])

/**
 * Kinds whose content is usually load-bearing.
 */
const SUBSTANTIVE_KINDS: ReadonlySet<string> = new Set([
  'read',
  'fs_read',
  'edit',
  'write',
  'diff',
  'patch',
])

/** The features this provider was asked about, for one call. */
export interface HeuristicRequest extends JudgmentRequest {
  /** Features for each question id. A missing feature falls back to length-only. */
  readonly features?: Readonly<Record<string, ChunkFeature>>
}

/**
 * Answer a four-tier "how much of this is needed" choice from structure alone.
 *
 * The question id is expected to be a chunk id, and the chosen option is one of
 * the caller's `criteria` keys. The provider does not know what those keys mean
 * beyond the convention that the LAST key is the most complete tier — which is
 * why {@link HeuristicJudgmentProvider} reports the tier order it assumed, so a
 * caller with a different convention finds out immediately instead of silently
 * getting reversed verdicts.
 */
export class HeuristicJudgmentProvider implements JudgmentProvider {
  readonly name = 'heuristic'

  constructor(
    private readonly thresholds: HeuristicThresholds = DEFAULT_THRESHOLDS,
  ) {
    if (thresholds.small < 0 || thresholds.large < thresholds.small) {
      throw new RangeError(
        `thresholds must satisfy 0 <= small <= large, received ${thresholds.small}/${thresholds.large}`,
      )
    }
  }

  /**
   * Answer every question structurally.
   *
   * Never rejects and never returns `ok: false`: a structural rule either
   * applies or does not, and "I cannot tell" is expressed as the most complete
   * tier plus low confidence rather than as a failure. That keeps the escalation
   * decision with the caller, which is where the cost trade-off lives.
   * @param request - state, questions, and optional per-id features.
   * @param _signal - unused; structural answers are synchronous.
   * @returns one answer per question id.
   */
  judge(request: JudgmentRequest, _signal?: AbortSignal): Promise<Answers> {
    const features = (request as HeuristicRequest).features ?? {}
    const answers: Record<string, AnswerOrFailure> = {}
    for (const [id, question] of Object.entries(request.questions)) {
      answers[id] = this.answerOne(id, question, features[id])
    }
    return Promise.resolve(answers)
  }

  private answerOne(
    id: string,
    question: Question,
    feature: ChunkFeature | undefined,
  ): AnswerOrFailure {
    if (question.type === 'noul') {
      // A structural provider has no basis for a truth claim about content, and
      // guessing one would be worse than refusing.
      return { ok: false, reason: 'the heuristic provider does not answer noul questions' }
    }

    if (question.type === 'score') {
      // Position on an ordered rubric is a content judgement, not a structural
      // one. Refusing keeps the provider's claims honest.
      return { ok: false, reason: 'the heuristic provider does not answer score questions' }
    }

    const options = Object.keys(question.criteria)
    if (options.length === 0) {
      return { ok: false, reason: `question ${id} declares no options` }
    }
    const tier = this.tierFor(feature)
    const index = Math.min(tier, options.length - 1)
    const choice = options[index]!
    const confidence = this.confidenceFor(feature)

    // A structural answer is a point mass: the provider is certain about the
    // rule it applied, and reports the confidence of the RULE, not of a model.
    const probabilities: Record<string, number> = {}
    for (const option of options) probabilities[option] = option === choice ? 1 : 0

    return { ok: true, answer: { type: 'choice', choice, probabilities, confidence } }
  }

  /**
   * The tier index this chunk falls in, counted from least to most complete.
   * @param feature - the chunk's structural features, when known.
   * @returns an index into the caller's option list.
   */
  private tierFor(feature: ChunkFeature | undefined): number {
    if (feature === undefined) return 1
    // A pinned chunk is the caller's explicit claim and outranks every rule.
    if (feature.pinned === true) return Number.MAX_SAFE_INTEGER
    // Then SIZE, before kind. A 100 KB `read` result is still 100 KB: the kind
    // says the content is usually load-bearing, not that all of it is. Letting a
    // kind hint outrank an extreme length is how a scorer ends up shipping an
    // oversized context while reporting a confident verdict.
    if (feature.bytes <= this.thresholds.small) return 1
    if (feature.bytes > this.thresholds.large) return 0
    // In the middle band, kind is the only extra evidence there is.
    if (feature.kind !== undefined && SUBSTANTIVE_KINDS.has(feature.kind)) return 1
    if (feature.kind !== undefined && NOISY_KINDS.has(feature.kind)) return 0
    return 2
  }

  /**
   * How much to trust the structural answer.
   *
   * Certain when the rule is decisive — a tiny chunk, a pinned chunk, an
   * enormous one — and deliberately low in the middle band, where length alone
   * is weak evidence and the caller ought to escalate to a model.
   * @param feature - the chunk's structural features, when known.
   * @returns a confidence in `[0, 1]`.
   */
  private confidenceFor(feature: ChunkFeature | undefined): number {
    if (feature === undefined) return 0.3
    if (feature.pinned === true) return 1
    if (feature.bytes <= this.thresholds.small) return 0.95
    if (feature.bytes > this.thresholds.large) return 0.9
    if (feature.kind !== undefined && SUBSTANTIVE_KINDS.has(feature.kind)) return 0.8
    if (feature.kind !== undefined && NOISY_KINDS.has(feature.kind)) return 0.85
    // The undecided middle: a real signal that a model should be asked.
    return 0.4
  }
}
