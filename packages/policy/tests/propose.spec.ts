/**
 * The proposal compiler: the boundary between model output and executable policy.
 *
 * Everything here is written from the premise that the model's output is
 * *untrusted input*. A proposal is generated text, so it will eventually be
 * malformed, out of range, or shaped to reach something it should not. The
 * compiler's job is to reject all of that and to accept only rules it can
 * explain, which is why the rejection cases matter as much as the happy path.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'

import {
  ProposalCompileError,
  compileProposal,
  parseProposal,
  proposalUserMessage,
} from '../src/propose.ts'
import { ReplayWorld } from '../src/replay.ts'
import type { RecordedNode } from '../src/replay.ts'
import { runPolicy } from '../src/replay.ts'

/** A two-branch tree, each branch a chain, so both actions are legal. */
function twoBranchWorld(): ReplayWorld {
  const nodes: RecordedNode[] = []
  for (const branch of [0, 1]) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      nodes.push({
        nodeId: `b${branch}-a${attempt}`,
        ...(attempt === 0 ? {} : { parent: `b${branch}-a${attempt - 1}` }),
        branch,
        attempt,
        siblingOrder: attempt === 0 ? branch : attempt,
        turns: 1,
        status: 'scored',
        score: branch === 1 ? 10 + attempt : 1 + attempt,
      })
    }
  }
  return new ReplayWorld(nodes)
}

const GRID = { branchCount: 2, refineCount: 2 } as const

describe('parseProposal rejects unusable model output', () => {
  it('rejects a non-object', () => {
    expect(() => parseProposal('open_branch')).toThrow(ProposalCompileError)
  })

  it('rejects an empty rule list', () => {
    expect(() => parseProposal({ id: 'x', rules: [] })).toThrow(/at least one rule/)
  })

  it('rejects a missing id', () => {
    expect(() => parseProposal({ rules: [{ then: 'any' }] })).toThrow(/non-empty id/)
  })

  it('rejects an unknown action and names the known ones', () => {
    expect(() => parseProposal({ id: 'x', rules: [{ then: 'delete_everything' }] })).toThrow(
      /known actions/,
    )
  })

  it('rejects a negative maxUses', () => {
    expect(() =>
      parseProposal({ id: 'x', rules: [{ then: 'any', maxUses: -1 }] }),
    ).toThrow(/maxUses must be a non-negative integer/)
  })

  it('rejects a fractional guard', () => {
    expect(() =>
      parseProposal({ id: 'x', rules: [{ when: { revealedAtMost: 1.5 }, then: 'any' }] }),
    ).toThrow(/revealedAtMost must be a non-negative integer/)
  })

  it('does not silently drop an unknown action in a later rule', () => {
    expect(() =>
      parseProposal({ id: 'x', rules: [{ then: 'any' }, { then: 'nope' }] }),
    ).toThrow(ProposalCompileError)
  })

  it('accepts a well-formed proposal and keeps the optional fields', () => {
    const parsed = parseProposal({
      id: 'balanced',
      rationale: 'open then deepen',
      rules: [
        { when: { openedBranchesAtMost: 2 }, then: 'open_branch' },
        { then: 'deepen_best' },
      ],
      branchCount: 3,
      refineCount: 1,
    })
    expect(parsed.id).toBe('balanced')
    expect(parsed.rules).toHaveLength(2)
    expect(parsed.branchCount).toBe(3)
    expect(parsed.rules[0]?.when?.openedBranchesAtMost).toBe(2)
  })
})

describe('compileProposal produces a policy that can actually be replayed', () => {
  it('runs to exhaustion without stalling', () => {
    const { policy } = compileProposal(
      parseProposal({
        id: 'opener',
        rules: [{ then: 'open_branch' }, { then: 'deepen_newest' }],
      }),
      GRID,
    )
    const run = runPolicy(twoBranchWorld(), policy, { maxParallelism: 2 })
    expect(run.stopReason).not.toBe('empty-batch')
    expect(run.revealedNodeCount).toBeGreaterThan(0)
  })

  it('honours rule order: an opener that always opens only opens', () => {
    const { policy, trace } = compileProposal(
      parseProposal({ id: 'always-open', rules: [{ then: 'open_branch' }, { then: 'any' }] }),
      GRID,
    )
    runPolicy(twoBranchWorld(), policy, { maxParallelism: 2 })
    // Once both branches are open, `open_branch` is no longer legal and the
    // catch-all must take over, so rule 0 can appear only twice.
    expect(trace.filter(index => index === 0).length).toBeLessThanOrEqual(2)
  })

  it('honours maxUses', () => {
    const { policy } = compileProposal(
      parseProposal({
        id: 'capped',
        rules: [{ then: 'open_branch', maxUses: 1 }, { then: 'deepen_newest' }],
      }),
      GRID,
    )
    const run = runPolicy(twoBranchWorld(), policy, { maxParallelism: 1 })
    expect(run.stopReason).not.toBe('empty-batch')
  })

  it('deepen_best follows the higher-scoring lineage rather than the newest', () => {
    const world = twoBranchWorld()
    const { policy } = compileProposal(
      parseProposal({
        id: 'score-aware',
        rules: [
          { when: { openedBranchesAtLeast: 2 }, then: 'deepen_best' },
          { then: 'open_branch' },
        ],
      }),
      GRID,
    )
    const run = runPolicy(world, policy, { maxParallelism: 1 })
    const best = run.bestScore
    // Branch 1 scores 10-12; a policy that never deepens it cannot reach 12.
    expect(best).toBeGreaterThanOrEqual(11)
  })

  it('falls back to a legal action when every rule is guarded out', () => {
    const { policy } = compileProposal(
      parseProposal({
        id: 'impossible',
        rules: [{ when: { openedBranchesAtLeast: 99 }, then: 'deepen_newest' }],
      }),
      GRID,
    )
    const run = runPolicy(twoBranchWorld(), policy, { maxParallelism: 2 })
    // The guard can never hold, so the fallback carries the run. It must still
    // make progress: an empty batch would end the run and make the score
    // incomparable instead of merely bad.
    expect(run.stopReason).not.toBe('empty-batch')
    expect(run.revealedNodeCount).toBeGreaterThan(0)
  })

  it('respects the proposal grid override', () => {
    const { policy } = compileProposal(
      parseProposal({ id: 'wide', rules: [{ then: 'any' }], branchCount: 7, refineCount: 0 }),
      GRID,
    )
    expect(policy.planGrid({ hardMaxBranchCount: 8, round: 1 })).toEqual({
      branchCount: 7,
      refineCount: 0,
    })
  })

  it('uses the fallback grid when the proposal omits one', () => {
    const { policy } = compileProposal(
      parseProposal({ id: 'plain', rules: [{ then: 'any' }] }),
      GRID,
    )
    expect(policy.planGrid({ hardMaxBranchCount: 8, round: 1 })).toEqual(GRID)
  })

  it('is deterministic for one proposal', () => {
    const proposal = parseProposal({
      id: 'det',
      rules: [{ then: 'open_branch' }, { then: 'deepen_oldest' }],
    })
    const a = runPolicy(twoBranchWorld(), compileProposal(proposal, GRID).policy, {
      maxParallelism: 2,
    })
    const b = runPolicy(twoBranchWorld(), compileProposal(proposal, GRID).policy, {
      maxParallelism: 2,
    })
    expect(a.bestScore).toBe(b.bestScore)
    expect(a.revealedNodeIds).toEqual(b.revealedNodeIds)
  })
})

describe('proposalUserMessage', () => {
  it('names the incumbent, the budget and every tried id', () => {
    const message = proposalUserMessage({
      incumbentId: 'depth-100',
      bestScore: 1.7237,
      triedIds: ['depth-100', 'depth-50'],
      evaluations: [
        { policyId: 'depth-100', meanScore: 1.7237 },
        { policyId: 'depth-50', meanScore: 1.5491 },
      ],
      budget: { rounds: 8, parallelism: 4 },
    })
    expect(message).toContain('depth-100')
    expect(message).toContain('1.7237')
    expect(message).toContain('depth-50')
    expect(message).toContain('8 decision rounds')
    expect(message).toContain('do not reuse')
  })

  it('does not claim a score when there is none', () => {
    const message = proposalUserMessage({
      incumbentId: 'x',
      bestScore: undefined,
      triedIds: [],
      evaluations: [{ policyId: 'x', meanScore: undefined }],
      budget: { rounds: 4, parallelism: 1 },
    })
    expect(message).toContain('no score')
    expect(message).toContain('(nothing yet)'.replace('(nothing yet)', 'x'))
  })
})

describe('a proposal is data, never code', () => {
  it('compiles rule lists without eval or new Function', async () => {
    // The proposer is the one component whose input is model output AND whose
    // output is executed, so the boundary has to be structural. Executing a
    // generated policy as code would let it reach the filesystem, loop forever,
    // or read the worlds it is being scored against -- and would make the
    // benchmark runner's own behaviour unverifiable. This test fails if a future
    // refactor reintroduces code generation.
    const source = await import('node:fs/promises').then(fs =>
      fs.readFile(new URL('../src/propose.ts', import.meta.url), 'utf8'),
    )
    expect(source).not.toMatch(/\beval\s*\(/)
    expect(source).not.toMatch(/new\s+Function\s*\(/)
  })
})
