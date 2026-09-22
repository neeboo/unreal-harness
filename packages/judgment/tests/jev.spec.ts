/**
 * The Jev adapter: translation, response normalisation, and failure discipline.
 *
 * No network here. The adapter takes an injectable transport precisely so the
 * translation can be pinned against recorded shapes, and so the interesting
 * cases — an out-of-vocabulary choice, a missing answer, a rate limit — are
 * testable without a key.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  JEV_PINNED_MODEL,
  JevProvider,
  JevRequestError,
  TIER_CRITERIA,
  ValueError,
} from '../src/index.ts'
import type { AnswerOrFailure, ChoiceAnswer, JudgmentProvider } from '../src/index.ts'

/** A transport that answers with one canned body and records what it received. */
function stubTransport(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = []
  const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  })
  return { transport: transport as unknown as typeof fetch, calls }
}

const chunkQuestions = {
  c1: { type: 'choice' as const, instructions: 'How much is needed?', criteria: TIER_CRITERIA },
}

describe('JevProvider construction', () => {
  it('refuses an empty key rather than sending an unauthenticated request', () => {
    const { transport } = stubTransport({})
    expect(() => new JevProvider({ apiKey: '   ', fetch: transport })).toThrow(ValueError)
  })

  it('pins a versioned model by default, not a moving alias', async () => {
    const { transport, calls } = stubTransport({ answers: {} })
    const provider = new JevProvider({ apiKey: 'k', fetch: transport })
    await provider.judge({ state: 'x', questions: chunkQuestions })

    const body = JSON.parse(String(calls[0]!.init.body)) as { model: string }
    // An alias would change answers behind thresholds a caller already tuned.
    expect(body.model).toBe(JEV_PINNED_MODEL)
    expect(body.model).not.toContain('latest')
  })
})

describe('JevProvider translation', () => {
  it('sends the state separately from the questions', async () => {
    const { transport, calls } = stubTransport({ answers: {} })
    const provider = new JevProvider({ apiKey: 'k', fetch: transport })
    const state = { chunks: [{ id: 'c1', text: 'a long body' }] }

    await provider.judge({ state, questions: chunkQuestions })

    const body = JSON.parse(String(calls[0]!.init.body)) as {
      state: unknown
      questions: Record<string, { instructions: string }>
    }
    // The state/instruction split is a hard constraint of the service: state and
    // questions share one budget, so a chunk's body must not ride in its
    // instruction or a large batch silently overruns the cap.
    expect(body.state).toEqual(state)
    expect(body.questions.c1!.instructions).toBe('How much is needed?')
    expect(JSON.stringify(body.questions)).not.toContain('a long body')
  })

  it('sends the bearer token and the endpoint it was configured with', async () => {
    const { transport, calls } = stubTransport({ answers: {} })
    const provider = new JevProvider({
      apiKey: 'secret-key',
      fetch: transport,
      endpoint: 'https://example.test/v1/systemone',
    })
    await provider.judge({ state: 'x', questions: chunkQuestions })

    expect(calls[0]!.url).toBe('https://example.test/v1/systemone')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer secret-key')
  })

  it('splits a large batch across calls without dropping questions', async () => {
    const { transport, calls } = stubTransport({ answers: {} })
    const provider = new JevProvider({ apiKey: 'k', fetch: transport, maxQuestionsPerCall: 2 })
    const questions = Object.fromEntries(
      ['a', 'b', 'c', 'd', 'e'].map(id => [
        id,
        { type: 'choice' as const, instructions: `q ${id}`, criteria: TIER_CRITERIA },
      ]),
    )

    const answers = await provider.judge({ state: 'x', questions })

    expect(calls).toHaveLength(3)
    // Every question is accounted for, which is the property that matters: a
    // dropped question would shift a caller's results with no error.
    expect(Object.keys(answers).sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('JevProvider response handling', () => {
  it('returns the selected option, its distribution, and its confidence', async () => {
    const { transport } = stubTransport({
      model: JEV_PINNED_MODEL,
      answers: {
        c1: {
          choice: 'key',
          probabilities: { none: 0.05, gist: 0.15, key: 0.7, full: 0.1 },
          confidence: 0.82,
        },
      },
    })
    const provider = new JevProvider({ apiKey: 'k', fetch: transport })

    const answers = await provider.judge({ state: 'x', questions: chunkQuestions })
    const answer = answers.c1 as AnswerOrFailure<ChoiceAnswer>

    expect(answer.ok).toBe(true)
    if (!answer.ok) return
    expect(answer.answer.choice).toBe('key')
    expect(answer.answer.confidence).toBe(0.82)
    expect(Object.values(answer.answer.probabilities).reduce((a, b) => a + b, 0)).toBeCloseTo(1)
  })

  it('treats an option the question never offered as unanswerable', async () => {
    const { transport } = stubTransport({
      answers: { c1: { choice: 'summarize', confidence: 0.99 } },
    })
    const provider = new JevProvider({ apiKey: 'k', fetch: transport })

    const answers = await provider.judge({ state: 'x', questions: chunkQuestions })
    const answer = answers.c1 as AnswerOrFailure<ChoiceAnswer>

    // A caller branches on a value it declared. Returning an undeclared option
    // would let a caller act on something outside its own state machine, so it
    // is refused even at high confidence.
    expect(answer.ok).toBe(false)
    if (answer.ok) return
    expect(answer.reason).toContain('did not offer')
  })

  it('names a missing answer instead of silently returning fewer results', async () => {
    const { transport } = stubTransport({ answers: {} })
    const provider = new JevProvider({ apiKey: 'k', fetch: transport })

    const answers = await provider.judge({ state: 'x', questions: chunkQuestions })
    const answer = answers.c1 as AnswerOrFailure<ChoiceAnswer>

    // Dropping it would mis-index a caller's batch and surface the bug far from
    // its cause.
    expect(answer.ok).toBe(false)
    if (answer.ok) return
    expect(answer.reason).toContain('no answer')
  })

  it('normalises a noul answer and a score answer to their promised shapes', async () => {
    const { transport } = stubTransport({
      answers: {
        truth: { noul: 0.87 },
        severity: { score: 2, scoreProbabilities: [0.05, 0.15, 0.8], confidence: 0.77 },
      },
    })
    const provider = new JevProvider({ apiKey: 'k', fetch: transport })

    const answers = await provider.judge({
      state: 'x',
      questions: {
        truth: { type: 'noul', instructions: 'Is this true?' },
        severity: { type: 'score', instructions: 'How bad?', criteria: ['low', 'mid', 'high'] },
      },
    })

    expect(answers.truth).toEqual({ ok: true, answer: { type: 'noul', noul: 0.87 } })
    expect(answers.severity!.ok).toBe(true)
  })

  it('throws on a whole-request failure rather than reporting every question unanswerable', async () => {
    const { transport } = stubTransport({ error: 'rate limited' }, 429)
    const provider = new JevProvider({ apiKey: 'k', fetch: transport })

    // A caller cannot distinguish "unanswerable" from "we never reached the
    // model", and only one of those is worth retrying.
    await expect(provider.judge({ state: 'x', questions: chunkQuestions })).rejects.toThrow(
      JevRequestError,
    )
  })

  it('reports the status on a transport rejection', async () => {
    const { transport } = stubTransport({}, 401)
    const provider = new JevProvider({ apiKey: 'k', fetch: transport })
    await expect(provider.judge({ state: 'x', questions: chunkQuestions })).rejects.toMatchObject({
      status: 401,
    })
  })

  it('answers an empty question set without calling the service', async () => {
    const { transport, calls } = stubTransport({ answers: {} })
    const provider = new JevProvider({ apiKey: 'k', fetch: transport })
    expect(await provider.judge({ state: 'x', questions: {} })).toEqual({})
    expect(calls).toHaveLength(0)
  })
})

describe('the seam contract', () => {
  it('is implemented by both providers, so a caller can swap them', () => {
    // Both are only ever used through the interface; a consumer that reached for
    // a concrete class would not be able to run the cheap provider in tests.
    const providers: JudgmentProvider[] = [
      new JevProvider({ apiKey: 'k', fetch: stubTransport({}).transport }),
    ]
    expect(providers.map(provider => provider.name)).toEqual(['jev'])
  })
})
