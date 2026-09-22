/**
 * A {@link JudgmentProvider} backed by TypeSafe's Jev.
 *
 * Jev is a *System One* model: it does not generate text. It evaluates typed
 * questions against a state and returns typed answers, which is exactly the
 * shape this seam wants — so the adapter is a translation, not a prompt.
 *
 * Two facts about the service drive the implementation, and both are easy to get
 * wrong in a way that looks fine in a test and fails in production:
 *
 * - **State and questions share one budget** (64k combined, with the state plus
 *   the single longest question capped at 32k). The chunk bodies must therefore
 *   live in `state`, never inside `instructions`, or a large batch overruns the
 *   cap while each individual question looks small.
 * - **Output tokens are free; input tokens are not.** The cost of a judgment is
 *   the size of the state it was asked about, which is why {@link JevProvider}
 *   reports the state it sent rather than the answer count.
 *
 * This adapter holds no API key: the caller supplies a `fetch` and a key, so a
 * deployment can put its own transport, retry, or proxy in front without
 * touching the translation.
 * @module
 */

import { JEV_CHOICE_TIER_ORDER, type JevWireAnswer, type JevWireResponse } from './wire.ts'
import type {
  AnswerOrFailure,
  Answers,
  JudgmentProvider,
  JudgmentRequest,
  Question,
} from './types.ts'

/** A caller-side configuration error, distinct from a transport failure. */
export class ValueError extends Error {
  override readonly name = 'ValueError'
}

/** Where the System One endpoint lives. */
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

/**
 * The versioned model id this adapter is calibrated against.
 *
 * Pinned rather than `jev-latest` on purpose: an alias moves when TypeSafe ships,
 * which would silently change the answers behind thresholds a caller tuned. The
 * response reports the id that actually answered, and this constant is what a
 * mismatch is compared against.
 */
export const JEV_PINNED_MODEL = 'jev-1.13.0'

/** How the adapter reaches the endpoint. */
export interface JevProviderOptions {
  /** Bearer token for the System One API. */
  readonly apiKey: string
  /**
   * Transport override.
   *
   * Injectable so tests need no network and a deployment can add retries, a
   * proxy, or usage accounting without this module knowing.
   */
  readonly fetch?: typeof fetch
  /** Model id to request. Defaults to {@link JEV_PINNED_MODEL}. */
  readonly model?: string
  /** Endpoint override. Defaults to {@link JEV_ENDPOINT}. */
  readonly endpoint?: string
  /**
   * Maximum questions per call.
   *
   * A provider-level knob, not a correctness one: the service evaluates every
   * question against the state in parallel, so this only bounds request size and
   * the blast radius of one failure.
   */
  readonly maxQuestionsPerCall?: number
}

/** A judgment call that could not be completed as a whole. */
export class JevRequestError extends Error {
  override readonly name = 'JevRequestError'

  constructor(
    /** HTTP status, or 0 when the transport itself failed. */
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** Default questions per call. Chosen to keep a batch well inside the state cap. */
const DEFAULT_MAX_QUESTIONS = 32

/**
 * Ask Jev for typed judgments.
 *
 * The adapter never reports a whole-batch answer when the batch failed: a
 * transport or auth error throws, because a caller that receives `ok: false` for
 * every question cannot tell "the model found these unanswerable" from "we never
 * reached the model", and only one of those is worth retrying.
 */
export class JevProvider implements JudgmentProvider {
  readonly name = 'jev'

  private readonly transport: typeof fetch
  private readonly model: string
  private readonly endpoint: string
  private readonly maxQuestionsPerCall: number

  constructor(private readonly options: JevProviderOptions) {
    if (options.apiKey.trim() === '') {
      throw new ValueError('a Jev API key is required')
    }
    this.transport = options.fetch ?? globalThis.fetch
    if (this.transport === undefined) {
      throw new ValueError('no fetch implementation available; pass one in options')
    }
    this.model = options.model ?? JEV_PINNED_MODEL
    this.endpoint = options.endpoint ?? JEV_ENDPOINT
    this.maxQuestionsPerCall = options.maxQuestionsPerCall ?? DEFAULT_MAX_QUESTIONS
  }

  /**
   * Answer every question about one state, splitting only when the caller sent
   * more questions than one call allows.
   * @param request - the state and the questions.
   * @param signal - cancellation for the whole batch.
   * @returns one answer (or per-question failure) per question id.
   * @throws {JevRequestError} for transport, auth, rate-limit, or protocol failure.
   */
  async judge(request: JudgmentRequest, signal?: AbortSignal): Promise<Answers> {
    const entries = Object.entries(request.questions)
    if (entries.length === 0) return {}

    const answers: Record<string, AnswerOrFailure> = {}
    for (let start = 0; start < entries.length; start += this.maxQuestionsPerCall) {
      const slice = entries.slice(start, start + this.maxQuestionsPerCall)
      const batch = await this.judgeBatch(request.state, slice, signal)
      Object.assign(answers, batch)
    }
    return answers
  }

  private async judgeBatch(
    state: JudgmentRequest['state'],
    entries: readonly (readonly [string, Question])[],
    signal: AbortSignal | undefined,
  ): Promise<Answers> {
    const questions: Record<string, unknown> = {}
    for (const [id, question] of entries) questions[id] = toWireQuestion(question)

    const response = await this.transport(this.endpoint, {
      method: 'POST',
      headers: {
        // eslint-disable-next-line @typescript-eslint/naming-convention -- HTTP header name
        'Authorization': `Bearer ${this.options.apiKey}`,
        // eslint-disable-next-line @typescript-eslint/naming-convention -- HTTP header name
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ state, model: this.model, questions }),
      ...signal === undefined ? {} : { signal },
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new JevRequestError(
        response.status,
        `Jev returned ${response.status}${detail === '' ? '' : `: ${detail.slice(0, 400)}`}`,
      )
    }

    const body = (await response.json()) as JevWireResponse
    return fromWireAnswers(entries, body)
  }
}

/** Translate one seam question into the service's wire form. */
function toWireQuestion(question: Question): Record<string, unknown> {
  switch (question.type) {
    case 'choice':
      return {
        type: 'choice',
        instructions: question.instructions,
        criteria: question.criteria,
      }
    case 'score':
      return {
        type: 'score',
        instructions: question.instructions,
        criteria: question.criteria,
      }
    case 'noul':
      return {
        type: 'noul',
        instructions: question.instructions,
        ...question.criteria === undefined ? {} : { criteria: question.criteria },
      }
  }
}

/**
 * Translate the response back, naming every question the call did not answer.
 *
 * A missing answer becomes `ok: false` rather than being dropped: a caller that
 * silently receives fewer answers than it asked for will mis-index its results,
 * and the failure would surface far from its cause.
 */
function fromWireAnswers(
  entries: readonly (readonly [string, Question])[],
  body: JevWireResponse,
): Answers {
  const raw = body.answers ?? {}
  const answers: Record<string, AnswerOrFailure> = {}
  for (const [id, question] of entries) {
    const answer = raw[id] as JevWireAnswer | undefined
    answers[id] = answer === undefined
      ? { ok: false, reason: 'the provider returned no answer for this question' }
      : normaliseAnswer(question, answer)
  }
  return answers
}

/** Coerce one wire answer into the shape its question promised. */
function normaliseAnswer(question: Question, answer: JevWireAnswer): AnswerOrFailure {
  if (question.type === 'noul') {
    if (typeof answer.noul !== 'number') {
      return { ok: false, reason: 'expected a noul value' }
    }
    return { ok: true, answer: { type: 'noul', noul: answer.noul } }
  }

  if (question.type === 'score') {
    if (typeof answer.score !== 'number') {
      return { ok: false, reason: 'expected a score value' }
    }
    return {
      ok: true,
      answer: {
        type: 'score',
        score: answer.score,
        probabilities: answer.scoreProbabilities ?? [],
        confidence: answer.confidence ?? 0,
      },
    }
  }

  if (typeof answer.choice !== 'string') {
    return { ok: false, reason: 'expected a choice value' }
  }
  // A choice outside the offered options would let a caller branch on a value it
  // never declared. Treating it as unanswerable is the only safe reading.
  if (!Object.hasOwn(question.criteria, answer.choice)) {
    return {
      ok: false,
      reason: `the provider chose "${answer.choice}", which the question did not offer`,
    }
  }
  return {
    ok: true,
    answer: {
      type: 'choice',
      choice: answer.choice,
      probabilities: answer.probabilities ?? {},
      confidence: answer.confidence ?? 0,
    },
  }
}

/**
 * The tier order this adapter assumes when a caller's option keys are ambiguous.
 *
 * Exported so a consumer can assert its own convention matches rather than
 * discovering a reversal through wrong verdicts.
 */
export const ASSUMED_TIER_ORDER = JEV_CHOICE_TIER_ORDER
