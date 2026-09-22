/**
 * The System One wire vocabulary, isolated from the adapter's logic.
 *
 * Keeping the wire shape in a leaf module means the translation can be tested
 * against recorded payloads without constructing an adapter, and a change in the
 * service's response shape has exactly one file to touch.
 * @module
 */

/**
 * The tier keys this repository uses for "how much of this is needed".
 *
 * Least to most complete. Declared once because the order is a contract: a
 * provider that returns `key` when the caller wanted `full` produces a confident
 * wrong answer, which is worse than a refusal.
 */
export const JEV_CHOICE_TIER_ORDER = ['none', 'gist', 'key', 'full'] as const

/** One tier key. */
export type JevTier = (typeof JEV_CHOICE_TIER_ORDER)[number]

/** The criteria map a four-tier chunk question sends. */
export const TIER_CRITERIA: Readonly<Record<JevTier, string>> = Object.freeze({
  none: 'Irrelevant to the task at hand',
  gist: 'Only the conclusion or a one-line summary matters',
  key: 'A key portion matters, but not all of it',
  full: 'Every line matters',
})

/** One answer as the service returns it. */
export interface JevWireAnswer {
  /** Selected option for a choice question. */
  readonly choice?: string
  /** Selected level index for a score question. */
  readonly score?: number
  /** Truth probability for a noul question. */
  readonly noul?: number
  /**
   * Distribution across options for a choice question.
   *
   * Separate from {@link JevWireAnswer.scoreProbabilities} rather than a union:
   * the two shapes are not interchangeable, and a union would push the
   * discrimination onto every reader.
   */
  readonly probabilities?: Record<string, number>
  /** Distribution across rubric levels for a score question, lowest first. */
  readonly scoreProbabilities?: readonly number[]
  /** Calibration summary, when the service computed one. */
  readonly confidence?: number
}

/** The service's response envelope. */
export interface JevWireResponse {
  /** The versioned model id that answered. */
  readonly model?: string
  /** Answers keyed by the question id the caller supplied. */
  readonly answers?: Record<string, JevWireAnswer>
  /** Usage or error detail the service chose to include. */
  readonly error?: string
}

/** The service's request envelope. */
export interface JevWireRequest {
  /** The material the questions are asked about. */
  readonly state: string | Readonly<Record<string, unknown>> | readonly string[]
  /** Model id to evaluate with. */
  readonly model: string
  /** Questions keyed by caller-chosen id. */
  readonly questions: Record<string, unknown>
}
