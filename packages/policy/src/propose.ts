/**
 * The invention step: a model proposes new exploration policies.
 *
 * # Why a DSL instead of generated code
 *
 * The paper's proposal step invents new policy code. Executing model-written code
 * inside a benchmark runner would make the runner's own behaviour unverifiable —
 * a proposal could reach the filesystem, loop forever, or read the worlds it is
 * being scored against. Those are not hypothetical risks for a component whose
 * entire purpose is to be *judged*, so this module constrains the invention: the
 * model returns a small JSON rule list, and a compiler turns it into a policy.
 *
 * The constraint is real but not crippling. The decision a policy actually makes
 * is "deepen an existing lineage or open a fresh one, and how many at once", so a
 * rule language over exactly those choices spans the useful space while keeping
 * every proposal inspectable, serializable, and safe to evaluate.
 *
 * # What this closes
 *
 * Everything else in `packages/bench` measures a *hand-written* pool. That leaves
 * the paper's actual claim — that invention beats hand-design — untested, because
 * the loop can only select from what someone already wrote. A proposal that
 * transfers is the difference between "the loop runs" and "the loop improves".
 *
 * @module
 */

import type { ExplorationPolicy, PrefixQuestion } from './types.ts'
import { IMPLICIT_ROOT } from './types.ts'

/** What a rule does when it fires. */
export type RuleAction =
  | 'open_branch'
  | 'deepen_newest'
  | 'deepen_oldest'
  | 'deepen_best'
  | 'any'

/** A guard on when a rule may fire. */
export interface RuleCondition {
  /** Fire only while at least this many rounds remain (undefined = always). */
  readonly roundsRemainingAtLeast?: number
  /** Fire only while at most this many nodes have been revealed. */
  readonly revealedAtMost?: number
  /** Fire only while the number of opened branches is at most this. */
  readonly openedBranchesAtMost?: number
  /** Fire only while the number of opened branches is at least this. */
  readonly openedBranchesAtLeast?: number
}

/** One rule: a condition, an action, and an optional per-run cap. */
export interface PolicyRule {
  readonly when?: RuleCondition
  readonly then: RuleAction
  /** Maximum times this rule may fire in one run. */
  readonly maxUses?: number
}

/** A proposed policy, as the model returns it. */
export interface ProposedPolicy {
  readonly id: string
  readonly rationale?: string
  readonly rules: readonly PolicyRule[]
  /** Grid plan, if the proposer wants to change the budget shape. */
  readonly branchCount?: number
  readonly refineCount?: number
}

/** Why a proposal could not be compiled. */
export class ProposalCompileError extends Error {
  override readonly name = 'ProposalCompileError'

  constructor(
    readonly code: 'empty-rules' | 'unknown-action' | 'bad-shape',
    message: string,
  ) {
    super(message)
  }
}

const ACTIONS: readonly RuleAction[] = [
  'open_branch',
  'deepen_newest',
  'deepen_oldest',
  'deepen_best',
  'any',
]

function checkNonNegativeInteger(value: unknown, field: string): void {
  if (value === undefined) return
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ProposalCompileError(
      'bad-shape',
      `${field} must be a non-negative integer, received ${JSON.stringify(value)}`,
    )
  }
}

/**
 * Validate a proposal parsed from model output.
 *
 * Separated from compilation so a caller can reject a bad proposal and ask again
 * without half-building a policy, and so the validation rules are testable
 * against adversarial input rather than only against well-formed output.
 *
 * @param value - parsed JSON, of unknown shape.
 * @returns the validated proposal.
 * @throws {ProposalCompileError} when the shape is unusable.
 */
export function parseProposal(value: unknown): ProposedPolicy {
  if (typeof value !== 'object' || value === null) {
    throw new ProposalCompileError('bad-shape', 'proposal must be an object')
  }
  const record = value as Record<string, unknown>
  const rules = record['rules']
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new ProposalCompileError('empty-rules', 'proposal must carry at least one rule')
  }

  const parsedRules: PolicyRule[] = rules.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new ProposalCompileError('bad-shape', `rule ${index} must be an object`)
    }
    const rule = entry as Record<string, unknown>
    const then = rule['then']
    if (typeof then !== 'string' || !ACTIONS.includes(then as RuleAction)) {
      throw new ProposalCompileError(
        'unknown-action',
        `rule ${index} has action ${JSON.stringify(then)}; known actions: ${ACTIONS.join(', ')}`,
      )
    }
    checkNonNegativeInteger(rule['maxUses'], `rule ${index} maxUses`)

    const when = rule['when']
    let condition: RuleCondition | undefined
    if (when !== undefined) {
      if (typeof when !== 'object' || when === null) {
        throw new ProposalCompileError('bad-shape', `rule ${index} when must be an object`)
      }
      const raw = when as Record<string, unknown>
      for (const field of [
        'roundsRemainingAtLeast',
        'revealedAtMost',
        'openedBranchesAtMost',
        'openedBranchesAtLeast',
      ]) {
        checkNonNegativeInteger(raw[field], `rule ${index} when.${field}`)
      }
      condition = {
        ...(raw['roundsRemainingAtLeast'] === undefined
          ? {}
          : { roundsRemainingAtLeast: raw['roundsRemainingAtLeast'] as number }),
        ...(raw['revealedAtMost'] === undefined
          ? {}
          : { revealedAtMost: raw['revealedAtMost'] as number }),
        ...(raw['openedBranchesAtMost'] === undefined
          ? {}
          : { openedBranchesAtMost: raw['openedBranchesAtMost'] as number }),
        ...(raw['openedBranchesAtLeast'] === undefined
          ? {}
          : { openedBranchesAtLeast: raw['openedBranchesAtLeast'] as number }),
      }
    }

    return {
      ...(condition === undefined ? {} : { when: condition }),
      then: then as RuleAction,
      ...(rule['maxUses'] === undefined ? {} : { maxUses: rule['maxUses'] as number }),
    }
  })

  if (typeof record['id'] !== 'string' || record['id'].length === 0) {
    throw new ProposalCompileError('bad-shape', 'proposal must carry a non-empty id')
  }
  checkNonNegativeInteger(record['branchCount'], 'branchCount')
  checkNonNegativeInteger(record['refineCount'], 'refineCount')

  return {
    id: record['id'],
    ...(typeof record['rationale'] === 'string' ? { rationale: record['rationale'] } : {}),
    rules: parsedRules,
    ...(record['branchCount'] === undefined
      ? {}
      : { branchCount: record['branchCount'] as number }),
    ...(record['refineCount'] === undefined ? {} : { refineCount: record['refineCount'] as number }),
  }
}

/** A compiled proposal, ready to be replayed. */
export interface CompiledProposal {
  readonly policy: ExplorationPolicy
  /**
   * Which rule fired in each decision round, for one run.
   *
   * Exposed because a rule list that never exercises its later rules is a policy
   * the model did not really design — and that is only visible by looking.
   */
  readonly trace: readonly number[]
}

/**
 * Compile a validated proposal into a replayable policy.
 *
 * @param proposal - the validated proposal.
 * @param fallbackGrid - grid to use when the proposal does not specify one.
 * @returns the policy plus a per-round record of which rule fired.
 */
export function compileProposal(
  proposal: ProposedPolicy,
  fallbackGrid: { readonly branchCount: number; readonly refineCount: number },
): CompiledProposal {
  const usage = new Array<number>(proposal.rules.length).fill(0)
  const trace: number[] = []

  const policy: ExplorationPolicy = {
    id: proposal.id,
    label: proposal.rationale ?? `proposed: ${proposal.rules.map(rule => rule.then).join(' > ')}`,
    beta: 0.5,
    planGrid: () => ({
      branchCount: proposal.branchCount ?? fallbackGrid.branchCount,
      refineCount: proposal.refineCount ?? fallbackGrid.refineCount,
    }),
    selectBatch: (question: PrefixQuestion) => {
      const actions = question.legalActions()
      if (actions.length === 0) return []
      const branches = question.openedBranches().length
      const revealed = Object.keys(question.observed()).length
      const canOpen = actions.includes(IMPLICIT_ROOT)
      const deepenable = actions.filter(action => action !== IMPLICIT_ROOT)

      for (let index = 0; index < proposal.rules.length; index += 1) {
        const rule = proposal.rules[index]
        if (rule === undefined) continue
        if (rule.maxUses !== undefined && (usage[index] ?? 0) >= rule.maxUses) continue

        const when = rule.when
        if (when !== undefined) {
          if (
            when.revealedAtMost !== undefined &&
            revealed > when.revealedAtMost
          ) {
            continue
          }
          if (
            when.openedBranchesAtMost !== undefined &&
            branches > when.openedBranchesAtMost
          ) {
            continue
          }
          if (
            when.openedBranchesAtLeast !== undefined &&
            branches < when.openedBranchesAtLeast
          ) {
            continue
          }
          // "rounds remaining" is only knowable when the caller bounded the run;
          // without a limit the condition cannot exclude anything and is ignored
          // rather than guessed, so a proposal is never silently reinterpreted.
          if (when.roundsRemainingAtLeast !== undefined && question.maxParallelism <= 0) {
            continue
          }
        }

        const acted = resolveAction(rule.then, {
          canOpen,
          deepenable,
          question,
        })
        if (acted === undefined) continue

        usage[index] = (usage[index] ?? 0) + 1
        trace.push(index)
        return acted
      }

      // No rule applied: fall back to the first legal action, so an exhausted
      // rule list stalls nothing. A policy that returns an empty batch stops the
      // run, which would make its score incomparable rather than merely bad.
      return [actions[0]!]
    },
  }

  return { policy, trace }
}

function resolveAction(
  action: RuleAction,
  context: {
    readonly canOpen: boolean
    readonly deepenable: readonly string[]
    readonly question: PrefixQuestion
  },
): readonly string[] | undefined {
  const { canOpen, deepenable, question } = context
  const parallel = Math.max(1, Math.min(question.maxParallelism, 4))

  switch (action) {
    case 'open_branch':
      return canOpen ? [IMPLICIT_ROOT] : undefined
    case 'deepen_newest':
      return deepenable.length === 0 ? undefined : [deepenable.at(-1)!]
    case 'deepen_oldest':
      return deepenable.length === 0 ? undefined : [deepenable[0]!]
    case 'deepen_best': {
      if (deepenable.length === 0) return undefined
      const observed = question.observed()
      let best: string | undefined
      let bestScore = Number.NEGATIVE_INFINITY
      for (const nodeId of deepenable) {
        const score = observed[nodeId]?.score
        if (score === undefined) continue
        if (score > bestScore) {
          bestScore = score
          best = nodeId
        }
      }
      // No scored ancestor yet: fall back to the newest lineage rather than
      // skipping, because skipping here would waste a round and the information
      // to choose does not exist yet.
      return [best ?? deepenable.at(-1)!]
    }
    case 'any': {
      const pool = [...(canOpen ? [IMPLICIT_ROOT] : []), ...deepenable]
      return pool.slice(0, parallel)
    }
    default:
      return undefined
  }
}

/** The instruction handed to the proposing model. */
export const PROPOSAL_SYSTEM_PROMPT = `You design exploration policies for a benchmark harness.

A policy decides, once per decision round, where to spend the next batch of attempts in a recorded discovery tree. The tree has several branches; each branch is a lineage of successive refinements of one approach. The agent's job is to find the highest-scoring node it can within a fixed number of rounds.

The only tension that matters is depth versus breadth:
- Branches differ in quality, so an unopened branch might be better than anything found so far.
- Quality is sticky within a branch, so continuing a good lineage keeps paying.

Reply with ONE JSON object and nothing else:

{
  "id": "<short-kebab-case-id>",
  "rationale": "<one sentence>",
  "rules": [
    { "when": { ...optional guards... }, "then": "<action>", "maxUses": <optional int> }
  ]
}

Actions:
- "open_branch"      reveal the next unopened branch
- "deepen_newest"    continue the most recently revealed lineage
- "deepen_oldest"    continue the earliest revealed lineage
- "deepen_best"      continue the lineage whose revealed node scored highest
- "any"              fill the batch with whatever is legal

Optional guards inside "when" (all are upper/lower bounds, omit for unconditional):
- "revealedAtMost": int          only while this few nodes have been revealed
- "openedBranchesAtMost": int    only while this few branches are open
- "openedBranchesAtLeast": int   only once this many branches are open

Optional top-level: "branchCount" and "refineCount" (ints) to change the budget shape.

Rules are tried in order; the first whose guards hold and whose maxUses is not exhausted wins. Always end with an unguarded catch-all rule. Prefer 2-4 rules. Do not repeat an id from the list of already-tried ids.`

/**
 * Build the user message describing what has been tried.
 *
 * Kept separate from the call so the prompt is inspectable and testable, and so a
 * different provider can be used without touching the prompt's content.
 */
export function proposalUserMessage(context: {
  readonly incumbentId: string
  readonly bestScore: number | undefined
  readonly triedIds: readonly string[]
  readonly evaluations: readonly { readonly policyId: string; readonly meanScore: number | undefined }[]
  readonly budget: { readonly rounds: number; readonly parallelism: number }
}): string {
  const history = context.evaluations
    .map(
      evaluation =>
        `- ${evaluation.policyId}: ${
          evaluation.meanScore === undefined ? 'no score' : evaluation.meanScore.toFixed(4)
        }`,
    )
    .join('\n')

  return [
    `Deployed policy: ${context.incumbentId}`,
    `Best mean replay score so far: ${
      context.bestScore === undefined ? 'none' : context.bestScore.toFixed(4)
    }`,
    `Budget: ${context.budget.rounds} decision rounds, up to ${context.budget.parallelism} continuations per round.`,
    '',
    'Already evaluated (mean score over the recorded worlds, higher is better):',
    history || '- (nothing yet)',
    '',
    `Already-used ids, do not reuse: ${context.triedIds.join(', ') || '(none)'}`,
    '',
    'Propose one policy that you expect to score higher.',
  ].join('\n')
}
