/**
 * # @unreal-harness/judgment
 *
 * Typed, cheap judgments that code branches on: *how much of this output does
 * the task need*, *which route should this subtask take*, *does this content
 * carry a credential*.
 *
 * Asking a text-generating model those questions means coercing prose into
 * structure and parsing it back. This package defines the narrow seam for asking
 * them properly, ships a zero-cost structural provider, and adapts TypeSafe's
 * Jev for the cases structure cannot settle.
 *
 * ## The two providers
 *
 * | Provider | Cost | Answers | Use it for |
 * |---|---|---|---|
 * | {@link HeuristicJudgmentProvider} | none | `choice` only | the decisive cases: tiny chunks, enormous ones, pinned ones |
 * | {@link JevProvider} | input tokens | `choice`, `score`, `noul` | the uncertain middle, and any truth claim |
 *
 * The split is the design, not a fallback: a scorer that sends every chunk to a
 * model reintroduces the linear cost that made scoring look unattractive. Run the
 * cheap provider first and escalate only where it reports low confidence.
 *
 * ## Why the interface looks like this
 *
 * A judgment is a **type**, not a string — a choice returns one of the options
 * the caller declared, already narrowed. And **confidence is part of the
 * answer**, so a caller can refuse to act on a judgment the provider was unsure
 * about rather than discovering the uncertainty later.
 *
 * @example
 * ```ts
 * import { HeuristicJudgmentProvider, mayAct, TIER_CRITERIA } from '@unreal-harness/judgment'
 *
 * const provider = new HeuristicJudgmentProvider()
 * const answers = await provider.judge({
 *   state: { chunk: 'line one\nline two' },
 *   questions: {
 *     c1: { type: 'choice', instructions: 'How much of this is needed?', criteria: TIER_CRITERIA },
 *   },
 *   features: { c1: { id: 'c1', bytes: 18, kind: 'read' } },
 * } as never)
 *
 * // Act only on a judgment the provider was confident about.
 * mayAct(answers.c1 as never, 'full', 0.8)
 * ```
 * @module
 */

export type {
  Answer,
  AnswerOrFailure,
  Answers,
  ChoiceAnswer,
  ChoiceQuestion,
  JudgmentProvider,
  JudgmentRequest,
  JudgmentState,
  NoulAnswer,
  NoulQuestion,
  Question,
  ScoreAnswer,
  ScoreQuestion,
} from './types.ts'
export { mayAct, packQuestions } from './types.ts'

export { DEFAULT_THRESHOLDS, HeuristicJudgmentProvider } from './heuristic.ts'
export type { ChunkFeature, HeuristicRequest, HeuristicThresholds } from './heuristic.ts'

export { ASSUMED_TIER_ORDER, JEV_ENDPOINT, JEV_PINNED_MODEL, JevProvider, JevRequestError, ValueError } from './jev.ts'
export type { JevProviderOptions } from './jev.ts'

export {
  ChunkScorer,
  DEFAULT_CONFIDENCE_FLOOR,
  reducesContent,
  summariseVerdicts,
} from './scorer.ts'
export type { ChunkScorerOptions, ChunkVerdict, ScoreableChunk } from './scorer.ts'

export { breakEvenReuses, planRebuild } from './cache.ts'
export type {
  CacheGeometry,
  RebuildCandidate,
  RebuildDecision,
  RebuildPlan,
  TokenPrices,
} from './cache.ts'

export {
  CapabilityCatalogue,
  DEFAULT_MATCH_LIMIT,
} from './catalogue.ts'
export type {
  CapabilityEntry,
  CapabilityMatch,
  CatalogueOptions,
} from './catalogue.ts'

export { JEV_CHOICE_TIER_ORDER, TIER_CRITERIA } from './wire.ts'
export type { JevTier, JevWireAnswer, JevWireRequest, JevWireResponse } from './wire.ts'
