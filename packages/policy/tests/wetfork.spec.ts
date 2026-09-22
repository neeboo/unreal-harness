/**
 * Wet forks: run attempts under several conditions and tell a real difference
 * from noise.
 *
 * The cases that matter are the ones where a naive executor would report a
 * finding it did not earn: a tie called a win, a comparison where one arm never
 * scored, a regression hidden as a tie, and drift attributed to a condition
 * because the arms were not interleaved.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  WetForkError,
  actionabilityGaps,
  recordForkAsNodes,
  wetFork,
} from '../src/index.ts'
import type { AttemptRequest, ForkCondition } from '../src/index.ts'

const control: ForkCondition = { id: 'full', label: 'full context' }
const hidden: ForkCondition = { id: 'hidden', label: 'chunk hidden' }

/** An executor whose per-condition scores are scripted. */
function executor(scores: Readonly<Record<string, readonly number[]>>) {
  const calls: AttemptRequest[] = []
  const cursors = new Map<string, number>()
  const run = (request: AttemptRequest) => {
    calls.push(request)
    const scripted = scores[request.condition.id] ?? []
    const index = cursors.get(request.condition.id) ?? 0
    cursors.set(request.condition.id, index + 1)
    const score = scripted[index]
    return Promise.resolve(
      score === undefined ? { ok: false, failure: 'no score scripted' } : { ok: true, score },
    )
  }
  return { run, calls }
}

describe('wetFork', () => {
  it('runs every arm for every replica and reports the real attempt count', async () => {
    const { run, calls } = executor({ full: [1, 1, 1], hidden: [2, 2, 2] })
    const result = await wetFork('n0', {
      control,
      conditions: [hidden],
      replicas: 3,
      noiseFloor: 0.1,
      runAttempt: run,
    })

    // Cost is reported rather than implied: a caller pays per attempt.
    expect(result.attemptsRun).toBe(6)
    expect(calls).toHaveLength(6)
    expect(result.arms.map(a => a.replica)).toEqual([1, 1, 2, 2, 3, 3])
  })

  it('INTERLEAVES arms so environment drift is not attributed to a condition', async () => {
    const { run, calls } = executor({ full: [1, 1], hidden: [1, 1] })
    await wetFork('n0', {
      control,
      conditions: [hidden],
      replicas: 2,
      noiseFloor: 0.1,
      runAttempt: run,
    })

    // Replica 1 of both arms, then replica 2 of both — not all of arm A then all
    // of arm B, which would let a warming cache or a rate limit look like a
    // finding.
    expect(calls.map(c => c.condition.id)).toEqual(['full', 'hidden', 'full', 'hidden'])
  })

  it('calls a difference beyond the noise floor an advantage', async () => {
    const { run } = executor({ full: [1, 1], hidden: [2, 2] })
    const result = await wetFork('n0', {
      control,
      conditions: [hidden],
      replicas: 2,
      noiseFloor: 0.1,
      runAttempt: run,
    })

    expect(result.comparison).toEqual({ kind: 'advantage', winner: 'hidden', margin: 1 })
  })

  it('calls a difference within the noise floor a tie', async () => {
    const { run } = executor({ full: [1, 1], hidden: [1.05, 1.02] })
    const result = await wetFork('n0', {
      control,
      conditions: [hidden],
      replicas: 2,
      noiseFloor: 0.2,
      runAttempt: run,
    })

    // The noise floor is required rather than defaulted: what counts as a real
    // difference is a property of the task's scoring.
    expect(result.comparison.kind).toBe('tie')
  })

  it('reports a REGRESSION as the control winning, not as a tie', async () => {
    const { run } = executor({ full: [3, 3], hidden: [1, 1] })
    const result = await wetFork('n0', {
      control,
      conditions: [hidden],
      replicas: 2,
      noiseFloor: 0.1,
      runAttempt: run,
    })

    // Calling this a tie would hide a real regression behind a symmetric label.
    expect(result.comparison).toEqual({ kind: 'advantage', winner: 'full', margin: 2 })
  })

  it('is inconclusive when an arm never scored', async () => {
    const { run } = executor({ full: [], hidden: [2, 2] })
    const result = await wetFork('n0', {
      control,
      conditions: [hidden],
      replicas: 2,
      noiseFloor: 0.1,
      runAttempt: run,
    })

    expect(result.comparison.kind).toBe('inconclusive')
    // Averaging an unscored attempt as zero would turn missing data into a
    // verdict.
    expect(result.summaries[0]!.meanScore).toBeUndefined()
    expect(result.summaries[0]!.failed).toBe(2)
  })

  it('summarises scores, failures, and the failure classes seen', async () => {
    // Replica 1 fails, replica 2 scores — so one arm has both a data point and a
    // robustness signal.
    const run = (request: AttemptRequest) =>
      Promise.resolve(
        request.replica === 1
          ? { ok: false, failure: 'timeout' }
          : { ok: true, score: 4 },
      )
    const result = await wetFork('n0', {
      control,
      conditions: [hidden],
      replicas: 2,
      noiseFloor: 0.1,
      runAttempt: run,
    })

    const full = result.summaries.find(s => s.conditionId === 'full')!
    expect(full.scored).toBe(1)
    expect(full.failed).toBe(1)
    expect(full.failures).toEqual(['timeout'])
    expect(full.meanScore).toBe(4)
  })

  it('refuses a plan with no challenger, a repeated condition, or bad replicas', async () => {
    const { run } = executor({})
    await expect(wetFork('n0', { control, conditions: [], noiseFloor: 0.1, runAttempt: run }))
      .rejects.toThrow(WetForkError)
    await expect(wetFork('n0', {
      control, conditions: [control], noiseFloor: 0.1, runAttempt: run,
    })).rejects.toThrow(/appears twice/)
    await expect(wetFork('n0', {
      control, conditions: [hidden], replicas: 0, noiseFloor: 0.1, runAttempt: run,
    })).rejects.toThrow(/positive integer/)
  })

  it('compares against the BEST challenger, not each in turn', async () => {
    const worse: ForkCondition = { id: 'worse' }
    const { run } = executor({ full: [1], hidden: [2], worse: [0.5] })
    const result = await wetFork('n0', {
      control,
      conditions: [hidden, worse],
      noiseFloor: 0.1,
      runAttempt: run,
    })

    // Three variants ask "did any of these beat the control". Reporting three
    // pairwise verdicts would invite reading a winner out of noise.
    expect(result.comparison).toEqual({ kind: 'advantage', winner: 'hidden', margin: 1 })
  })

  it('does not call the executor for a refused plan', async () => {
    const run = vi.fn(() => Promise.resolve({ ok: true, score: 1 }))
    await expect(wetFork('n0', { control, conditions: [], noiseFloor: 0.1, runAttempt: run }))
      .rejects.toThrow(WetForkError)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('actionabilityGaps', () => {
  it('is empty for a clean, decision-grade fork', async () => {
    const { run } = executor({ full: [1, 1, 1], hidden: [2, 2, 2] })
    const result = await wetFork('n0', {
      control, conditions: [hidden], replicas: 3, noiseFloor: 0.1, runAttempt: run,
    })
    expect(actionabilityGaps(result, { minimumScoredPerArm: 3 })).toEqual([])
  })

  it('names every unmet condition rather than returning a bare false', async () => {
    const run = () => Promise.resolve({ ok: false, failure: 'crash' })
    const result = await wetFork('n0', {
      control, conditions: [hidden], replicas: 2, noiseFloor: 0.1, runAttempt: run,
    })
    const gaps = actionabilityGaps(result, { minimumScoredPerArm: 2 })

    expect(gaps.some(g => g.includes('inconclusive'))).toBe(true)
    expect(gaps.some(g => g.includes('fewer than 2'))).toBe(true)
    expect(gaps.some(g => g.includes('crash'))).toBe(true)
  })

  it('treats a higher failure count as a finding, not a missing data point', async () => {
    const run = (request: AttemptRequest) =>
      Promise.resolve(
        request.condition.id === 'hidden'
          ? { ok: false, failure: 'oom' }
          : { ok: true, score: 1 },
      )
    const result = await wetFork('n0', {
      control, conditions: [hidden], replicas: 1, noiseFloor: 0.1, runAttempt: run,
    })

    // A condition that fails more often is a robustness result, so it is surfaced
    // instead of being averaged away.
    expect(actionabilityGaps(result).some(g => g.includes('oom'))).toBe(true)
    expect(actionabilityGaps(result, { allowFailures: true }).some(g => g.includes('oom'))).toBe(false)
  })
})

describe('recordForkAsNodes', () => {
  it('turns scored arms into replayable nodes for the history', async () => {
    const { run } = executor({ full: [1, 2], hidden: [3, 4] })
    const result = await wetFork('n0', {
      control, conditions: [hidden], replicas: 2, noiseFloor: 0.1, runAttempt: run,
    })

    const nodes = recordForkAsNodes('n0', result, { branch: 7 })
    expect(nodes).toHaveLength(4)
    expect(nodes.every(n => n.parent === 'n0' && n.branch === 7 && n.status === 'scored')).toBe(true)
    // Distinct ids, so a later fold cannot silently merge two attempts.
    expect(new Set(nodes.map(n => n.nodeId)).size).toBe(4)
    expect(nodes.map(n => n.siblingOrder)).toEqual([0, 1, 2, 3])
    expect(nodes.map(n => n.score).sort()).toEqual([1, 2, 3, 4])
  })

  it('skips attempts that scored nothing instead of inventing a value', async () => {
    const run = (request: AttemptRequest) =>
      Promise.resolve(
        request.condition.id === 'hidden' ? { ok: true, score: 5 } : { ok: false, failure: 'no' },
      )
    const result = await wetFork('n0', {
      control, conditions: [hidden], replicas: 1, noiseFloor: 0.1, runAttempt: run,
    })

    const nodes = recordForkAsNodes('n0', result, { branch: 0 })
    // Recording a made-up score would put a fiction into a history the loop later
    // trusts for its decisions.
    expect(nodes).toHaveLength(1)
    expect(nodes[0]!.score).toBe(5)
  })
})
