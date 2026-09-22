/**
 * The structural provider: what it may claim, and what it must refuse to.
 *
 * The interesting cases are the refusals and the low-confidence band. A provider
 * that answers everything confidently is worse than one that declines, because a
 * caller can act on a confident wrong answer and cannot act on a refusal.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_THRESHOLDS,
  HeuristicJudgmentProvider,
  mayAct,
  packQuestions,
  TIER_CRITERIA,
} from '../src/index.ts'
import type { AnswerOrFailure, ChoiceAnswer, HeuristicRequest } from '../src/index.ts'

const TIERS = Object.keys(TIER_CRITERIA)

function chunkQuestion(id: string) {
  return {
    [id]: {
      type: 'choice' as const,
      instructions: 'How much of this output does the task need?',
      criteria: TIER_CRITERIA,
    },
  }
}

async function ask(
  provider: HeuristicJudgmentProvider,
  feature: HeuristicRequest['features'] extends undefined ? never : NonNullable<HeuristicRequest['features']>[string],
): Promise<AnswerOrFailure<ChoiceAnswer>> {
  const request: HeuristicRequest = {
    state: { chunks: [] },
    questions: chunkQuestion('c1'),
    features: { c1: feature },
  }
  const answers = await provider.judge(request)
  return answers.c1 as AnswerOrFailure<ChoiceAnswer>
}

describe('HeuristicJudgmentProvider', () => {
  const provider = new HeuristicJudgmentProvider()

  it('keeps a small chunk whole and says so confidently', async () => {
    const answer = await ask(provider, { id: 'c1', bytes: 64, kind: 'bash' })
    expect(answer.ok).toBe(true)
    if (!answer.ok) return
    // Small beats noisy: length is direct evidence, the kind hint is not.
    expect(answer.answer.choice).toBe('gist')
    expect(answer.answer.confidence).toBeGreaterThanOrEqual(0.9)
  })

  it('drops an enormous chunk even when its kind is usually load-bearing', async () => {
    const answer = await ask(provider, { id: 'c1', bytes: DEFAULT_THRESHOLDS.large + 1, kind: 'read' })
    expect(answer.ok).toBe(true)
    if (!answer.ok) return
    // Size outranks kind: a 100 KB read result is still 100 KB, and letting the
    // kind hint win here would ship an oversized context under a confident
    // verdict.
    expect(answer.answer.choice).toBe('none')
  })

  it('never argues with a caller that pinned a chunk', async () => {
    const answer = await ask(provider, {
      id: 'c1',
      bytes: DEFAULT_THRESHOLDS.large * 10,
      kind: 'bash',
      pinned: true,
    })
    expect(answer.ok).toBe(true)
    if (!answer.ok) return
    // The last declared option is the most complete tier.
    expect(answer.answer.choice).toBe(TIERS.at(-1))
    expect(answer.answer.confidence).toBe(1)
  })

  it('reports LOW confidence in the undecided middle, so a caller escalates', async () => {
    const answer = await ask(provider, {
      id: 'c1',
      bytes: (DEFAULT_THRESHOLDS.small + DEFAULT_THRESHOLDS.large) / 2,
      kind: 'unknown-kind',
    })
    expect(answer.ok).toBe(true)
    if (!answer.ok) return
    // This is the provider's most useful output: a signal that structure alone
    // is not enough evidence to act on.
    expect(answer.answer.confidence).toBeLessThan(0.6)
    expect(mayAct(answer, 'full', 0.8)).toBe(false)
  })

  it('leaves a chunk of unknown size low-confidence rather than guessing', async () => {
    const answers = await provider.judge({
      state: 'x',
      questions: chunkQuestion('c1'),
    })
    const answer = answers.c1 as AnswerOrFailure<ChoiceAnswer>
    expect(answer.ok).toBe(true)
    if (!answer.ok) return
    expect(answer.answer.confidence).toBeLessThan(0.6)
  })

  it('refuses a truth claim and a rubric position instead of faking them', async () => {
    const answers = await provider.judge({
      state: 'x',
      questions: {
        truth: { type: 'noul', instructions: 'Does this contain a credential?' },
        severity: { type: 'score', instructions: 'How severe?', criteria: ['low', 'high'] },
      },
    })

    // A structural provider has no basis for either claim. Guessing would be
    // worse than refusing, because a caller cannot tell a guess from a judgment.
    expect(answers.truth).toEqual({
      ok: false,
      reason: 'the heuristic provider does not answer noul questions',
    })
    expect(answers.severity!.ok).toBe(false)
  })

  it('rejects a malformed threshold configuration at construction', () => {
    expect(() => new HeuristicJudgmentProvider({ small: 100, large: 10 })).toThrow(RangeError)
    expect(() => new HeuristicJudgmentProvider({ small: -1, large: 10 })).toThrow(RangeError)
  })

  it('produces a point-mass distribution over the declared options', async () => {
    const answer = await ask(provider, { id: 'c1', bytes: 8, kind: 'read' })
    expect(answer.ok).toBe(true)
    if (!answer.ok) return
    const probabilities = answer.answer.probabilities
    expect(Object.keys(probabilities).sort()).toEqual([...TIERS].sort())
    expect(Object.values(probabilities).reduce((a, b) => a + b, 0)).toBe(1)
  })
})

describe('packQuestions', () => {
  it('splits into contiguous batches without dropping or reordering', () => {
    expect(packQuestions(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']])
  })

  it('returns one batch when everything fits, and none when there is nothing', () => {
    expect(packQuestions(['a'], 10)).toEqual([['a']])
    expect(packQuestions([], 2)).toEqual([])
  })

  it('refuses a nonsensical limit rather than looping forever', () => {
    expect(() => packQuestions(['a'], 0)).toThrow(RangeError)
    expect(() => packQuestions(['a'], -1)).toThrow(RangeError)
    expect(() => packQuestions(['a'], 1.5)).toThrow(RangeError)
  })
})
