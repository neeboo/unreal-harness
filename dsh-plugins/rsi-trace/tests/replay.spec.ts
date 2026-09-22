/**
 * The replay engine: history-as-simulator, exercised on a hand-built world.
 *
 * The vocabulary follows the recorded tree. A **root node** is a branch head —
 * an attempt whose parent is the implicit initial workspace, which is not
 * itself an attempt and has no node. A **non-root node** continues its parent's
 * branch. That asymmetry is what makes the two child rules differ:
 * probing the implicit root opens the next branch, while probing an attempt
 * advances along its single recorded continuation.
 *
 * These tests pin the semantics that make an offline evaluation a valid
 * prediction of an online run: deterministic child selection, youngest-first
 * branch order, strict prefix-only visibility, and fail-loud rejection of an
 * illegal selection.
 */
import { expect, it } from 'vitest'
import {
  IMPLICIT_ROOT,
  PrefixQuestion,
  ReplayWorld,
  ReplayWorldError,
  replay,
  replayScore,
} from '../src/index.ts'
import type { DiscoveryNode, ReplayResult } from '../src/index.ts'

/** Node fixture. `siblingOrder` doubles as creation position for tie-breaking. */
function node(
  nodeId: string,
  parent: string | undefined,
  branch: number,
  attempt: number,
  siblingOrder: number,
  score?: number,
): DiscoveryNode {
  return {
    nodeId,
    ...parent === undefined ? {} : { parent },
    branch,
    attempt,
    siblingOrder,
    seq: siblingOrder,
    turns: 1,
    status: score === undefined ? 'open' : 'scored',
    ...score === undefined ? {} : { score },
  }
}

/**
 * Three branches, each a chain of two attempts. Only branch heads are roots;
 * every non-root node has at most one child, which is what replay requires.
 */
function world(): ReplayWorld {
  return new ReplayWorld([
    node('b0', undefined, 0, 0, 0, 0.3),
    node('b1', undefined, 1, 0, 1, 0.9),
    node('b2', undefined, 2, 0, 2, 0.6),
    node('b0/a0', 'b0', 0, 1, 0, 0.5),
    node('b1/a0', 'b1', 1, 1, 0, 0.95),
    node('b2/a0', 'b2', 2, 1, 0, 0.4),
  ])
}

it('starts with nothing observed, and the implicit root plus every branch selectable', () => {
  const question = new PrefixQuestion(world())

  // Nothing is revealed yet: a policy cannot see a single outcome.
  expect(question.observed()).toEqual({})
  expect(question.revealed()).toEqual([])
  expect(question.roundCount).toBe(0)

  // Nothing is revealed, so the only legal action is the implicit root: opening
  // a branch is what reveals a branch head, and no branch is open yet.
  // `legalRoots` still reports every branch as unopened, which is what a policy
  // reads to decide HOW MANY directions remain.
  expect(question.legalActions()).toEqual(['root'])
  expect(question.legalRoots()).toEqual(['b0', 'b1', 'b2'])
  expect(question.openedBranches()).toEqual([])
  expect(question.exhausted).toBe(false)
})

it('opens branches in creation order, not score order', () => {
  const question = new PrefixQuestion(world())

  // Probing the implicit root opens the EARLIEST-created branch — b0, whose
  // score (0.3) is the lowest. Creation order is what history defines, so it is
  // what replay must respect.
  expect(question.probeBatch(['root']).map(o => o.nodeId)).toEqual(['b0'])

  // Exactly one branch head is revealed per opening: the others stay unopened.
  expect(question.legalRoots()).toEqual(['b1', 'b2'])

  const second = question.probeBatch(['root'])
  expect(second.map(observation => observation.nodeId)).toEqual(['b1'])
  expect(second[0]!.score).toBe(0.9)

  expect(question.probeBatch(['root']).map(o => o.nodeId)).toEqual(['b2'])
  expect(question.openedBranches()).toEqual(['b0', 'b1', 'b2'])
  expect(question.legalRoots()).toEqual([])
  // No branch remains unopened, so the handle is no longer legal — probing it
  // again is a policy error rather than a silent no-op.
  expect(question.legalActions()).toEqual(['b0', 'b1', 'b2'])
  expect(() => question.probeBatch(['root'])).toThrow(/illegal batch entry/)
})

it('walks a branch along its single recorded continuation', () => {
  const question = new PrefixQuestion(world())

  expect(question.probeBatch(['root']).map(o => o.nodeId)).toEqual(['b0'])
  // b0 is now a leaf of the observed tree, so it is the next step on its own
  // branch, while the implicit root stays selectable to open further branches.
  expect(question.legalActions()).toEqual(['root', 'b0'])
  expect(question.probeBatch(['b0']).map(o => o.nodeId)).toEqual(['b0/a0'])
  // b0/a0 has no recorded child: the branch ends, so it is a leaf with nothing
  // left to reveal and is therefore NOT a legal action.
  expect(question.legalActions()).not.toContain('b0/a0')
  expect(() => question.probeBatch(['b0/a0'])).toThrow(/illegal batch entry/)
})

it('rejects an illegal selection instead of guessing', () => {
  const question = new PrefixQuestion(world())

  // Unrevealed, unknown, and duplicated entries are all refused.
  expect(() => question.probeBatch(['b0/a0'])).toThrow(ReplayWorldError)
  expect(() => question.probeBatch(['nope'])).toThrow(ReplayWorldError)
  expect(() => question.probeBatch(['root', 'root'])).toThrow(/duplicate batch entry/)
})

it('never reveals a node the policy did not select', () => {
  const question = new PrefixQuestion(world())
  question.probeBatch(['root'])

  // Revealing b0 must not leak b0's child: the prefix is exactly what the
  // policy's own decisions uncovered.
  expect(Object.keys(question.observed())).toEqual(['b0'])
  expect(question.observed()['b0/a0']).toBeUndefined()
})

it('replays a policy deterministically and stops on an empty batch', () => {
  const policy = (question: PrefixQuestion): readonly string[] => {
    // Open every branch, then deepen the second one.
    if (question.legalRoots().length > 0) return ['root']
    return question.legalActions().includes('b1') ? ['b1'] : []
  }

  const first = replay(world(), policy)
  const second = replay(world(), policy)

  // Determinism: the same policy over the same world gives the same trajectory.
  expect(first).toEqual(second)
  expect(first.stopReason).toBe('empty-batch')
  expect(first.rounds.map(round => round.requested)).toEqual([['root'], ['root'], ['root'], ['b1']])
  expect(first.revealedNodeIds).toEqual(['b0', 'b1', 'b2', 'b1/a0'])
  expect(first.stopReason).toBe('empty-batch')
  expect(first.revealedNodeCount).toBe(4)
  expect(first.roundCount).toBe(4)
  expect(first.bestScore).toBe(0.95)
})

it('stops at the round limit and reports it', () => {
  const result = replay(world(), () => ['root'], { roundLimit: 2 })
  expect(result.stopReason).toBe('round-limit')
  expect(result.roundCount).toBe(2)
  expect(result.revealedNodeIds).toEqual(['b0', 'b1'])
})

it('reports exhaustion once every node is revealed', () => {
  // Opening a branch per round until none remain reveals the branch heads; the
  // remaining attempts are then deepened one per round until the tree is spent.
  // Deepen whichever branch head was most recently opened, one attempt per
  // round, until every branch is spent.
  const result: ReplayResult = replay(world(), question => {
    const heads = question.legalActions().filter(action => action !== IMPLICIT_ROOT)
    if (heads.length > 0) return [heads[heads.length - 1]!]
    return question.legalActions()
  }, { roundLimit: 99 })

  expect(result.stopReason).toBe('exhausted')
  expect(result.revealedNodeCount).toBe(6)
})

it('rewards batching the same revealed work into fewer rounds', () => {
  // Same outcomes both ways: {b0, b1, b0/a0, b1/a0} = 4 revealed attempts.
  // Only the batching differs. A batch is validated against the round's STARTING
  // state, so a batch cannot deepen something it opens in the same round; the
  // batch policy therefore pairs a deepening with the NEXT opening.
  const serial = replay(world(), question => {
    if (question.roundCount === 0) return ['root']
    if (question.roundCount === 1) return ['b0']
    if (question.roundCount === 2) return ['root']
    if (question.roundCount === 3) return ['b1']
    return []
  }, { roundLimit: 8 })

  const batched = replay(world(), question => {
    if (question.roundCount === 0) return ['root']
    if (question.roundCount === 1) return ['b0', 'root']
    if (question.roundCount === 2) return ['b1']
    return []
  }, { roundLimit: 8 })

  // Identical revealed work. Order differs because a batch deepens before it
  // opens the next branch, so compare as sets: the parallelism term reads counts,
  // not reveal order.
  expect([...batched.revealedNodeIds].sort()).toEqual(['b0', 'b0/a0', 'b1', 'b1/a0'])
  expect([...serial.revealedNodeIds].sort()).toEqual([...batched.revealedNodeIds].sort())
  expect(batched.revealedNodeCount).toBe(4)
  expect(serial.revealedNodeCount).toBe(batched.revealedNodeCount)
  // …in strictly fewer decision rounds.
  expect(batched.roundCount).toBeLessThan(serial.roundCount)

  // Same quality and cost, fewer rounds: the parallelism term is higher.
  const beta = { cost: 0.1, parallelism: 0.2 }
  expect(replayScore(batched, beta)!).toBeGreaterThan(replayScore(serial, beta)!)
})

it('refuses a world whose internal node branches', () => {
  // Replay can only walk a recorded parent-child order, so a non-root node with
  // two children has no deterministic successor. Refusing beats silently
  // evaluating a different world than the log describes.
  expect(() => new ReplayWorld([
    node('b0', undefined, 0, 0, 0),
    node('b0/x', 'b0', 0, 1, 0),
    node('b0/y', 'b0', 0, 1, 1),
  ])).toThrow(/at most one per parent/)
  // Roots obey the same rule: a branch head has one recorded continuation.
  expect(() => new ReplayWorld([
    node('r', undefined, 0, 0, 0),
    node('r/x', 'r', 0, 1, 0),
    node('r/y', 'r', 0, 1, 1),
  ])).toThrow(/at most one per parent/)
})

it('refuses a node whose parent is absent or duplicated', () => {
  expect(() => new ReplayWorld([node('a', 'ghost', 0, 0, 0)]))
    .toThrow(/absent parent/)
  expect(() => new ReplayWorld([node('a', undefined, 0, 0, 0), node('a', undefined, 1, 0, 1)]))
    .toThrow(/duplicate node id/)
})
