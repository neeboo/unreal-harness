/**
 * The replay engine and the dreaming loop.
 *
 * The claim worth pinning is monotonicity: because the candidate set includes the
 * incumbent, the selected policy is never worse on the recorded history. The
 * equally important half is the negative cases — a proposer that resubmits the
 * incumbent, a revision that scores worse, an incumbent that never scored — since
 * each of those is where a loop would otherwise report an improvement it did not
 * achieve.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  IMPLICIT_ROOT,
  PolicyStore,
  ReplayWorld,
  bestEvaluation,
  clampGrid,
  dream,
  evaluatePolicy,
  replayScore,
  runPolicy,
  sweepBeta,
  sweepIsInformative,
} from '../src/index.ts'
import type {
  ExplorationPolicy,
  PrefixQuestion,
  RecordedNode,
} from '../src/index.ts'

function node(
  nodeId: string,
  parent: string | undefined,
  branch: number,
  attempt: number,
  siblingOrder: number,
  score?: number,
): RecordedNode {
  return {
    nodeId,
    ...parent === undefined ? {} : { parent },
    branch,
    attempt,
    siblingOrder,
    turns: 1,
    status: score === undefined ? 'open' : 'scored',
    ...score === undefined ? {} : { score },
  }
}

/** Three branches, each a two-attempt chain. Only heads are roots. */
function worlds(): ReplayWorld {
  return new ReplayWorld([
    node('b0', undefined, 0, 0, 0, 0.3),
    node('b1', undefined, 1, 0, 1, 0.9),
    node('b2', undefined, 2, 0, 2, 0.6),
    node('b0/a0', 'b0', 0, 1, 0, 0.5),
    node('b1/a0', 'b1', 1, 1, 0, 0.95),
    node('b2/a0', 'b2', 2, 1, 0, 0.4),
  ])
}

/** A policy that opens every branch, then deepens from the front. */
function breadth(overrides: Partial<ExplorationPolicy> = {}): ExplorationPolicy {
  return {
    id: 'breadth',
    beta: 0.5,
    planGrid: () => ({ branchCount: 3, refineCount: 2 }),
    selectBatch: (question: PrefixQuestion) => {
      const legal = question.legalActions()
      return legal.length === 0 ? [] : [legal[0]!]
    },
    ...overrides,
  }
}

const BETA = { cost: 0.1, parallelism: 0.2 }

describe('runPolicy', () => {
  it('starts with nothing observed and only the implicit root selectable', () => {
    const seen: { observed: number; legal: readonly string[] }[] = []
    const probe: ExplorationPolicy = {
      ...breadth(),
      id: 'probe',
      selectBatch: question => {
        seen.push({ observed: Object.keys(question.observed()).length, legal: question.legalActions() })
        return question.roundCount === 0 ? [IMPLICIT_ROOT] : []
      },
    }
    runPolicy(worlds(), probe)

    // Nothing is revealed before the first decision, so a policy cannot read an
    // outcome it has not earned — the property that makes offline scoring valid.
    expect(seen[0]!.observed).toBe(0)
    expect(seen[0]!.legal).toEqual([IMPLICIT_ROOT])
  })

  it('opens branches in creation order, not score order', () => {
    const opened: string[] = []
    const probe: ExplorationPolicy = {
      ...breadth(),
      id: 'probe',
      selectBatch: question => {
        if (question.legalRoots().length > 0) return [IMPLICIT_ROOT]
        return []
      },
    }
    const run = runPolicy(worlds(), probe)
    // b0 has the LOWEST score and is opened first: creation order is what history
    // defines, so it is what replay must respect.
    expect(run.revealedNodeIds).toEqual(['b0', 'b1', 'b2'])
    void opened
  })

  it('walks a branch along its single recorded continuation', () => {
    const steps: string[][] = []
    const probe: ExplorationPolicy = {
      ...breadth(),
      id: 'probe',
      selectBatch: question => {
        const legal = question.legalActions()
        steps.push([...legal])
        return legal.length === 0 ? [] : [legal[0]!]
      },
    }
    const run = runPolicy(worlds(), probe)

    expect(steps[0]).toEqual([IMPLICIT_ROOT])
    // After opening b0, its own continuation is legal while the other heads are
    // not yet revealed.
    expect(steps[1]).toEqual([IMPLICIT_ROOT, 'b0'])
    expect(run.revealedNodeIds).toContain('b0/a0')
  })

  it('terminates when every recorded node is revealed', () => {
    const run = runPolicy(
      worlds(),
      breadth({
        selectBatch: question => {
          if (question.legalRoots().length > 0) return [IMPLICIT_ROOT]
          const legal = question.legalActions()
          return legal.length === 0 ? [] : [legal[0]!]
        },
      }),
      { roundLimit: 99 },
    )
    expect(run.stopReason).toBe('exhausted')
    expect(run.revealedNodeCount).toBe(6)
  })

  it('enforces a parallelism limit rather than silently exceeding it', () => {
    const greedy = breadth({
      selectBatch: question => question.legalActions(),
    })
    expect(() => runPolicy(worlds(), greedy, { maxParallelism: 1 })).toThrow(/parallelism limit/)
  })

  it('reports an unreachable score as undefined rather than zero', () => {
    const unscored = new ReplayWorld([node('a', undefined, 0, 0, 0)])
    const run = runPolicy(unscored, breadth())
    // Nothing scored, so there is no verdict — and scoring it as zero would make
    // an unscored world look like a poor performer.
    expect(run.bestScore).toBeUndefined()
    expect(replayScore(run, BETA)).toBeUndefined()
  })
})

describe('replayScore', () => {
  it('rewards the same revealed work in fewer rounds', () => {
    const serial = runPolicy(worlds(), breadth({
      selectBatch: question => {
        const legal = question.legalActions()
        return legal.length === 0 ? [] : [legal[0]!]
      },
    }))
    const batched = runPolicy(worlds(), breadth({
      selectBatch: question => (question.roundCount < 3 ? [IMPLICIT_ROOT] : []),
    }))

    expect(replayScore(batched, BETA)!).toBeGreaterThan(replayScore(serial, BETA)!)
  })
})

describe('dream', () => {
  it('selects the best candidate and is monotone by construction', async () => {
    const better: ExplorationPolicy = {
      ...breadth(),
      id: 'better',
      // Open all branches first, in one round each — same quality, fewer rounds.
      selectBatch: question => (question.legalRoots().length > 0 ? [IMPLICIT_ROOT] : []),
    }

    const outcome = await dream([worlds()], breadth(), {
      revisions: 1,
      beta: BETA,
      propose: () => Promise.resolve(better),
    })

    expect(outcome.evaluations).toHaveLength(2)
    expect(outcome.selected.id).toBe('better')
    expect(outcome.incumbent.id).toBe('breadth')
    expect(outcome.monotone).toBe(true)
    expect(outcome.stopReason).toBe('budget-spent')
  })

  it('keeps the incumbent when a revision scores worse', async () => {
    const worse: ExplorationPolicy = {
      ...breadth(),
      id: 'worse',
      // Reveal almost nothing: a valid policy with a poor allocation.
      selectBatch: question => (question.roundCount === 0 ? [IMPLICIT_ROOT] : []),
    }

    const outcome = await dream([worlds()], breadth(), {
      revisions: 1,
      beta: BETA,
      propose: () => Promise.resolve(worse),
    })

    // The candidate set includes the incumbent, so "no improvement" means the
    // incumbent stays — a revision is not adopted merely for existing.
    expect(outcome.selected.id).toBe('breadth')
    expect(outcome.evaluations).toHaveLength(2)
  })

  it('refuses a proposer that resubmits an already-evaluated policy', async () => {
    await expect(dream([worlds()], breadth(), {
      revisions: 1,
      beta: BETA,
      // Resubmitting the incumbent would let a proposer "improve" by doing
      // nothing while consuming the budget.
      propose: () => Promise.resolve(breadth()),
    })).rejects.toThrow(/already been evaluated/)
  })

  it('stops early when the proposer declines', async () => {
    const outcome = await dream([worlds()], breadth(), {
      revisions: 5,
      beta: BETA,
      propose: () => Promise.resolve(undefined),
    })

    expect(outcome.stopReason).toBe('proposer-stopped')
    expect(outcome.evaluations).toHaveLength(1)
  })

  it('reports that monotonicity was unprovable when the incumbent never scored', async () => {
    // A world where no attempt ever scored: there is nothing to compare against,
    // and claiming monotonicity would be empty.
    const unscored = new ReplayWorld([node('a', undefined, 0, 0, 0)])
    const outcome = await dream([unscored], breadth(), {
      revisions: 0,
      beta: BETA,
      propose: () => Promise.resolve(undefined),
    })

    expect(outcome.monotone).toBe(false)
  })

  it('rejects a negative revision budget', async () => {
    await expect(dream([worlds()], breadth(), {
      revisions: -1,
      beta: BETA,
      propose: () => Promise.resolve(undefined),
    })).rejects.toThrow(RangeError)
  })

  it('averages across worlds and ignores worlds that never scored', () => {
    const scored = worlds()
    const unscored = new ReplayWorld([node('solo', undefined, 0, 0, 0)])
    const evaluation = evaluatePolicy([scored, unscored], breadth(), BETA)

    expect(evaluation.perWorld).toHaveLength(2)
    expect(evaluation.perWorld[1]).toBeUndefined()
    // The unscored world is excluded rather than counted as zero.
    expect(evaluation.meanScore).toBe(evaluation.perWorld[0])
  })

  it('does not call the proposer when the budget is zero', async () => {
    const propose = vi.fn(() => Promise.resolve(undefined))
    await dream([worlds()], breadth(), { revisions: 0, beta: BETA, propose })
    expect(propose).not.toHaveBeenCalled()
  })
})

describe('sweepBeta', () => {
  it('evaluates one policy per grid point', () => {
    const evaluations = sweepBeta(
      [worlds()],
      beta => breadth({ id: `b-${beta}`, beta }),
      [0.2, 0.5, 0.8],
      BETA,
    )
    expect(evaluations.map(e => e.policyId)).toEqual(['b-0.2', 'b-0.5', 'b-0.8'])
  })

  it('reports a degenerate sweep rather than an implied best beta', () => {
    // The same policy at every grid point: the scalar moves nothing, so a
    // "winner" would be an artefact of the sweep rather than a finding.
    const flat = sweepBeta([worlds()], () => breadth(), [0.2, 0.5, 0.8], BETA)
    expect(sweepIsInformative(flat)).toBe(false)
  })

  it('reports an informative sweep when the scalar changes the outcome', () => {
    // A genuinely different allocation, not just a different label: the narrow
    // policy stops after the first branch, so it reveals a different node set and
    // therefore scores differently.
    const earlyStop: ExplorationPolicy = {
      id: 'early-stop',
      beta: 0.2,
      planGrid: () => ({ branchCount: 1, refineCount: 1 }),
      selectBatch: question =>
        question.legalRoots().length > 0 ? [IMPLICIT_ROOT] : [],
    }

    const varied = sweepBeta(
      [worlds()],
      beta => (beta > 0.5 ? breadth({ id: `b-${beta}`, beta }) : earlyStop),
      [0.2, 0.9],
      BETA,
    )
    expect(sweepIsInformative(varied)).toBe(true)
  })

  it('refuses an empty grid', () => {
    expect(() => sweepBeta([worlds()], () => breadth(), [], BETA)).toThrow(RangeError)
  })

  it('picks the best evaluation and ignores unscored ones', () => {
    const evaluations = [
      { policyId: 'a', meanScore: undefined, perWorld: [] },
      { policyId: 'b', meanScore: 1.5, perWorld: [] },
      { policyId: 'c', meanScore: 2.5, perWorld: [] },
    ]
    expect(bestEvaluation(evaluations)?.policyId).toBe('c')
    expect(bestEvaluation([evaluations[0]!])).toBeUndefined()
  })
})

describe('clampGrid', () => {
  const context = { hardMaxBranchCount: 4, hardMaxRefineCount: 3 }

  it('passes an in-range plan through untouched', () => {
    const result = clampGrid({ branchCount: 2, refineCount: 2 }, context)
    expect(result.plan).toEqual({ branchCount: 2, refineCount: 2 })
    expect(result.clamped).toBe(false)
  })

  it('clamps beyond a ceiling and says why, rather than rejecting the policy', () => {
    const result = clampGrid({ branchCount: 99, refineCount: 2 }, context)
    // Rejecting would lose a runnable policy; honouring would overrun capacity.
    expect(result.plan.branchCount).toBe(4)
    expect(result.clamped).toBe(true)
    expect(result.reason).toContain('ceiling')
  })

  it('repairs a nonsensical dimension instead of looping on it', () => {
    expect(clampGrid({ branchCount: 0, refineCount: -3 }, context).plan)
      .toEqual({ branchCount: 1, refineCount: 1 })
    expect(clampGrid({ branchCount: 1.5, refineCount: 1 }, context).plan.branchCount).toBe(1)
  })
})

describe('PolicyStore', () => {
  it('records versions append-only and refuses a repeated id', () => {
    const store = new PolicyStore()
    store.record(breadth())
    // A repeated id would make every later comparison ambiguous about which
    // version it named.
    expect(() => store.record(breadth())).toThrow(/already recorded/)
  })

  it('keeps the deployed pointer separate from the record order', () => {
    const store = new PolicyStore()
    store.record(breadth({ id: 'v1' }))
    store.record(breadth({ id: 'v2' }))
    store.deploy('v1')

    expect(store.deployed).toBe('v1')
    expect(store.all().map(r => r.policyId)).toEqual(['v1', 'v2'])
    // Rolling back to a version whose score is still on record is the point of
    // keeping deployment separate.
    store.deploy('v2')
    expect(store.deployed).toBe('v2')
  })

  it('refuses to attach a mismatched evaluation', () => {
    const store = new PolicyStore()
    store.record(breadth({ id: 'v1' }))
    expect(() => store.attachEvaluation('v1', {
      policyId: 'other',
      meanScore: 1,
      perWorld: [1],
    })).toThrow(/names "other"/)
  })

  it('ranks only scored versions', () => {
    const store = new PolicyStore()
    store.record(breadth({ id: 'unscored' }))
    store.record(breadth({ id: 'low' }))
    store.attachEvaluation('low', { policyId: 'low', meanScore: 1, perWorld: [1] })
    store.record(breadth({ id: 'high' }))
    store.attachEvaluation('high', { policyId: 'high', meanScore: 9, perWorld: [9] })

    // An unscored version is an unknown, not a poor performer, so ranking it
    // would invite a verdict that was never given.
    expect(store.ranked().map(r => r.policyId)).toEqual(['high', 'low'])
  })

  it('survives a snapshot round trip with its order and deployment', () => {
    const store = new PolicyStore()
    store.record(breadth({ id: 'v1', label: 'first' }))
    store.record(breadth({ id: 'v2' }))
    store.attachEvaluation('v1', { policyId: 'v1', meanScore: 2, perWorld: [2] })
    store.deploy('v1')

    const restored = PolicyStore.restore(store.snapshot())
    expect(restored.all().map(r => r.policyId)).toEqual(['v1', 'v2'])
    expect(restored.deployed).toBe('v1')
    expect(restored.get('v1')?.label).toBe('first')
    expect(restored.get('v1')?.evaluation?.meanScore).toBe(2)
  })

  it('refuses a snapshot that deploys a policy it does not contain', () => {
    expect(() => PolicyStore.restore({ records: [], deployed: 'ghost' }))
      .toThrow(/deploys unknown policy/)
  })

  it('refuses a snapshot that repeats an id', () => {
    const record = { policyId: 'dup', beta: 0.5, sequence: 0 }
    expect(() => PolicyStore.restore({ records: [record, record], deployed: undefined }))
      .toThrow(/repeats policy/)
  })
})
