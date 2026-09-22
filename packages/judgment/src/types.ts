/**
 * The judgment seam: typed, cheap decisions that code branches on.
 *
 * Some questions an agent asks are not "write something" but "decide something":
 * how much of this output does the task need, which route should this subtask
 * take, does this content carry a credential. Those are judgments, and asking
 * them of a text-generating model means coercing prose into structure and
 * parsing it back.
 *
 * This module defines the narrow interface for asking them, following dsh's
 * capability-seam shape (a Service Definition here, providers beside it,
 * consumers that depend only on these types). Two properties make it worth a
 * seam rather than a bare HTTP call:
 *
 * - **A judgment is a type, not a string.** {@link ChoiceQuestion} returns one of
 *   the options you supplied, with the full distribution, so a caller branches on
 *   a value it already narrowed.
 * - **Confidence is part of the answer.** A judgment that cannot say "I am not
 *   sure" cannot be trusted with a destructive decision, so every choice carries
 *   the calibration needed to gate on it.
 *
 * # Batching is the point
 *
 * {@link JudgmentProvider.judge} takes MANY questions about ONE state. Asking
 * twenty questions in one call is not an optimisation to add later; it is why
 * per-item scoring is affordable at all, and a provider that only supports one
 * question at a time cannot implement this interface honestly.
 * @module
 */

/** A question whose answer is one of a fixed, unordered set of options. */
export interface ChoiceQuestion<Option extends string = string> {
  readonly type: 'choice'
  /**
   * The judgment to make, written as the exact question.
   *
   * This is the evaluation logic. It must be self-contained: the model never
   * sees the question's key, so a terse instruction is an unanswerable one.
   */
  readonly instructions: string
  /** The options, mapped to a description of what each one means. */
  readonly criteria: Readonly<Record<Option, string>>
}

/** A question whose answer is a position on an ordered rubric. */
export interface ScoreQuestion {
  readonly type: 'score'
  readonly instructions: string
  /** Ordered rubric levels, lowest first. */
  readonly criteria: readonly string[]
}

/**
 * A yes/no judgment where the probability itself is the signal.
 *
 * Deliberately has no `confidence`: a two-outcome distribution has nothing to
 * concentrate, so `noul` IS the probability. A caller that needs calibration
 * should prefer a {@link ChoiceQuestion} or {@link ScoreQuestion}.
 */
export interface NoulQuestion {
  readonly type: 'noul'
  readonly instructions: string
  /** Optional clarification of what yes and no mean. */
  readonly criteria?: string
}

/** Any question this seam can ask. */
export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion

/** The state a set of questions is evaluated against. */
export type JudgmentState = string | Readonly<Record<string, unknown>> | readonly string[]

/** A choice answer, with the distribution that produced it. */
export interface ChoiceAnswer<Option extends string = string> {
  readonly type: 'choice'
  /** Which option was selected. */
  readonly choice: Option
  /** Probability mass per option, summing to about 1. */
  readonly probabilities: Readonly<Record<Option, number>>
  /**
   * How peaked the distribution is, in `[0, 1]`.
   *
   * Collapsed by the provider so a caller can threshold without doing the maths;
   * the full distribution stays available for callers that want their own
   * statistic, because no single number fits every decision.
   */
  readonly confidence: number
}

/** A score answer, with the distribution over rubric levels. */
export interface ScoreAnswer {
  readonly type: 'score'
  /** The selected rubric level's index. */
  readonly score: number
  /** Probability mass per level, lowest first. */
  readonly probabilities: readonly number[]
  readonly confidence: number
}

/** A noul answer. */
export interface NoulAnswer {
  readonly type: 'noul'
  /** Probability that the statement is true, in `[0, 1]`. */
  readonly noul: number
}

/** Any answer this seam returns. */
export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer

/**
 * One provider's answer to one question, or its refusal to answer.
 *
 * Failure is per-question rather than per-call on purpose: a batch of twenty
 * chunk verdicts should not be lost because one of them was unanswerable.
 */
export type AnswerOrFailure<A extends Answer = Answer> =
  | { readonly ok: true; readonly answer: A }
  | { readonly ok: false; readonly reason: string }

/** The answers to one judged batch, keyed by the caller's question id. */
export type Answers = Readonly<Record<string, AnswerOrFailure>>

/** One judged request. */
export interface JudgmentRequest {
  readonly state: JudgmentState
  /** Questions keyed by a caller-chosen id, returned in the answers. */
  readonly questions: Readonly<Record<string, Question>>
}

/**
 * A provider of typed judgments.
 *
 * Implementations must evaluate every question against the same state and answer
 * each independently. A provider that lets one question's answer leak into
 * another's has turned a batch into a conversation, and the caller's per-item
 * reasoning stops holding.
 */
export interface JudgmentProvider {
  /** Registry name, unique among mounted providers. */
  readonly name: string
  /**
   * Answer every question about one state.
   *
   * @param request - the state and the questions.
   * @param signal - cancellation for the whole batch.
   * @returns one answer (or failure) per question id.
   * @throws Only for a whole-request failure such as transport or auth. A
   * question the provider cannot answer belongs in the result as `ok: false`.
   */
  judge(request: JudgmentRequest, signal?: AbortSignal): Promise<Answers>
}

/**
 * Whether an answer selected the option the caller was looking for, and was
 * confident enough to act on it.
 *
 * Encodes the gating rule once so callers cannot each invent a different one: a
 * judgment is actionable only when it agrees with the caller's expectation AND
 * clears the caller's confidence floor. A disagreement is a real answer, not a
 * failure, so it returns `false` rather than throwing.
 * @param answer - the answer to gate.
 * @param expected - the option the caller wants to act on.
 * @param floor - minimum confidence required, in `[0, 1]`.
 * @returns whether the caller may act.
 */
export function mayAct<Option extends string>(
  answer: AnswerOrFailure<ChoiceAnswer<Option>>,
  expected: Option,
  floor: number,
): boolean {
  if (!answer.ok) return false
  if (answer.answer.choice !== expected) return false
  return answer.answer.confidence >= floor
}

/**
 * Pack questions into batches that respect a provider's per-call limit.
 *
 * Batching exists because the alternative — one call per item — is what makes
 * per-chunk scoring too expensive to run. A caller with more questions than one
 * call allows must still send as few calls as possible, so this splits rather
 * than truncating.
 * @param ids - every question id, in the order they should be asked.
 * @param maxPerCall - the provider's limit; must be positive.
 * @returns contiguous batches, preserving order.
 */
export function packQuestions(
  ids: readonly string[],
  maxPerCall: number,
): readonly (readonly string[])[] {
  if (!Number.isInteger(maxPerCall) || maxPerCall < 1) {
    throw new RangeError(`maxPerCall must be a positive integer, received ${maxPerCall}`)
  }
  const batches: string[][] = []
  for (let start = 0; start < ids.length; start += maxPerCall) {
    batches.push(ids.slice(start, start + maxPerCall))
  }
  return batches
}
