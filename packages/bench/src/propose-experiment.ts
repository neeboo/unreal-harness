/**
 * The paper's actual claim, tested: does an *invented* policy beat a hand-written one?
 *
 * # What was missing before this file
 *
 * Every other measurement in this repository selects from a pool of policies a
 * person wrote. That tests the judging half of the loop and leaves the inventing
 * half — the part the paper is actually about — unexercised. A loop that can only
 * pick from a fixed menu cannot improve past that menu, so "does dreaming help?"
 * is not answerable from it.
 *
 * This experiment closes the loop with a real model. DeepSeek is asked to design
 * policies, they are compiled and scored by the same replay the hand-written pool
 * is scored by, and the two pools are compared on worlds neither was fitted on.
 *
 * # The comparison, stated precisely
 *
 * `dream()` is given a proposer that calls the model and the hand-written pool's
 * best member as its incumbent. The loop then runs its real cycle: propose,
 * evaluate by replay, keep the best. Both pools are scored on the **same held-out
 * worlds**, so the question is: given equal information, does a generated policy
 * out-score the best policy a person wrote?
 *
 * A "no" is a legitimate result and is reported as one. This measures a specific
 * claim, not a slogan, and the numbers below are the measurement.
 *
 * @module
 */

import {
  bestEvaluation,
  compileProposal,
  dream,
  evaluatePolicy,
  parseProposal,
  proposalUserMessage,
  PROPOSAL_SYSTEM_PROMPT,
  statFor,
  syntheticCorpus,
} from '@unreal-harness/policy'
import type {
  ExplorationPolicy,
  PolicyEvaluation,
  PolicyStat,
  ProposedPolicy,
} from '@unreal-harness/policy'

import { DeepSeekClient } from './deepseek.ts'
import { POOL as HAND_POOL } from '@unreal-harness/policy'

const BETA = { cost: 0.05, parallelism: 0.1 } as const
const BINDING = { maxParallelism: 4, roundLimit: 8 } as const
const SHAPE = { branchCount: 4, refinementDepth: 3 } as const
const GRID = { branchCount: 1, refineCount: 1 } as const

/** One proposal attempt, with whatever the model returned and what it cost. */
export interface ProposalAttempt {
  readonly index: number
  readonly accepted: boolean
  readonly policyId?: string
  readonly rationale?: string
  readonly ruleCount?: number
  readonly rawText?: string
  readonly error?: string
  readonly promptTokens: number
  readonly completionTokens: number
  readonly cachedPromptTokens: number
  /** Mean replay score on the training worlds, once compiled and evaluated. */
  readonly trainScore?: number
}

/** Everything the experiment measured. */
export interface ProposeExperimentResult {
  readonly generatedAt: string
  readonly model: string
  readonly effort: string
  readonly regime: {
    readonly branchCount: number
    readonly refinementDepth: number
    readonly roundLimit: number
    readonly maxParallelism: number
    readonly trainWorlds: number
    readonly heldOutWorlds: number
    readonly revisionsRequested: number
  }
  readonly handWritten: {
    readonly pool: readonly { readonly policy: string; readonly trainScore: number | undefined }[]
    readonly bestOnTrain: string | undefined
    readonly bestOnTrainScore: number | undefined
  }
  readonly proposals: readonly ProposalAttempt[]
  readonly invented: {
    readonly acceptedIds: readonly string[]
    readonly bestOnTrain: string | undefined
    readonly bestOnTrainScore: number | undefined
    readonly meanTrainScore: number | undefined
    readonly acceptanceRate: number
  }
  /** Held-out head-to-head: the numbers that decide the claim. */
  readonly heldOut: {
    readonly handWrittenBest: {
      readonly policy: string
      readonly coverage: number
      readonly meanScore: number
    }
    readonly inventedBest: {
      readonly policy: string
      readonly coverage: number
      readonly meanScore: number
    } | null
    readonly inventedBeatsHandWritten: boolean | null
    readonly deltaMeanScore: number | null
  }
  /** The loop's own contract, which unlike transfer must hold. */
  readonly selectionGuarantee: {
    readonly dreamSelected: string | undefined
    readonly dreamIncumbent: string | undefined
    readonly monotone: boolean
    readonly stopReason: string
  }
  readonly tokenUsage: {
    readonly promptTokens: number
    readonly completionTokens: number
    readonly cachedPromptTokens: number
  }
}

/**
 * Pull the first balanced JSON object out of a reply.
 *
 * Models wrap JSON in prose or fences often enough that requiring a bare object
 * would reject usable proposals, while scanning for the first balanced `{...}`
 * stays strict about what it accepts.
 */
export function extractJsonObject(text: string): unknown | undefined {
  const start = text.indexOf('{')
  if (start === -1) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

/**
 * Run the experiment.
 *
 * @param options - credentials, and how many revisions the loop may request.
 * @returns the measurements.
 */
export async function runProposeExperiment(options: {
  readonly apiKey: string
  readonly model?: string
  readonly effort?: 'low' | 'high' | 'max'
  readonly revisions?: number
  readonly onProgress?: (message: string) => void
}): Promise<ProposeExperimentResult> {
  const progress = options.onProgress ?? ((): void => {})
  const client = new DeepSeekClient({
    apiKey: options.apiKey,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    // Generous enough for a 2-4 rule JSON object plus reasoning. At 2048 the
    // model's reply was truncated mid-object on one of two attempts, and a
    // truncated reply is indistinguishable from a malformed one -- so the token
    // budget silently masqueraded as a format failure.
    maxTokens: 8_192,
  })

  const train = syntheticCorpus(120, 1_000, SHAPE)
  const heldOut = syntheticCorpus(120, 9_000, SHAPE)
  const revisions = options.revisions ?? 4

  // ---- hand-written pool, fitted on train ---------------------------------
  const handEvaluations = HAND_POOL.map(policy =>
    evaluatePolicy(train.worlds, policy, BETA, BINDING),
  )
  const handBest = bestEvaluation(handEvaluations)
  if (handBest === undefined) {
    throw new Error('the hand-written pool produced no scoreable policy')
  }
  // The loop's incumbent is the best hand-written policy, so a proposal only
  // replaces it by beating it — and if nothing beats it, the loop returns it
  // unchanged. That is the comparison this experiment exists to make.
  const incumbent: ExplorationPolicy =
    HAND_POOL.find(policy => policy.id === handBest.policyId) ?? HAND_POOL[0]!
  progress(
    `hand-written pool: ${handBest.policyId} leads on train at ${handBest.meanScore?.toFixed(4)}`,
  )

  // ---- run the real loop with a model-backed proposer ---------------------
  const proposals: ProposalAttempt[] = []
  const invented = new Map<string, ExplorationPolicy>()
  let proposalIndex = 0

  const outcome = await dream(train.worlds, incumbent, {
    revisions,
    beta: BETA,
    replay: BINDING,
    propose: async ({ incumbent, evaluations, bestScore, triedIds }) => {
      const index = proposalIndex
      proposalIndex += 1
      try {
        const completion = await client.complete([
          { role: 'system', content: PROPOSAL_SYSTEM_PROMPT },
          {
            role: 'user',
            content: proposalUserMessage({
              incumbentId: incumbent.id,
              bestScore,
              triedIds,
              evaluations: evaluations.map(evaluation => ({
                policyId: evaluation.policyId,
                meanScore: evaluation.meanScore,
              })),
              budget: { rounds: BINDING.roundLimit, parallelism: BINDING.maxParallelism },
            }),
          },
        ])

        const usage = {
          promptTokens: completion.usage.promptTokens,
          completionTokens: completion.usage.completionTokens,
          cachedPromptTokens: completion.usage.cachedPromptTokens,
        }

        const json = extractJsonObject(completion.text)
        if (json === undefined) {
          proposals.push({
            index,
            accepted: false,
            error: 'reply contained no JSON object',
            rawText: completion.text.slice(0, 800),
            ...usage,
          })
          progress(`proposal ${index + 1}: rejected (no JSON)`)
          return undefined
        }

        const proposal: ProposedPolicy = parseProposal(json)
        const compiled = compileProposal(proposal, GRID)
        const trainScore = evaluatePolicy(train.worlds, compiled.policy, BETA, BINDING).meanScore
        invented.set(proposal.id, compiled.policy)
        proposals.push({
          index,
          accepted: true,
          policyId: proposal.id,
          ...(proposal.rationale === undefined ? {} : { rationale: proposal.rationale }),
          ruleCount: proposal.rules.length,
          ...(trainScore === undefined ? {} : { trainScore }),
          ...usage,
        })
        progress(
          `proposal ${index + 1}: accepted ${proposal.id} (${proposal.rules.length} rules, train ${trainScore?.toFixed(4)})`,
        )
        // The loop evaluates and selects among *policies*, so the compiled form
        // is what it must receive; the proposal itself is kept only for the
        // report, since a rule list is easier to read than a closure.
        return compiled.policy
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        proposals.push({ index, accepted: false, error: message, promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0 })
        progress(`proposal ${index + 1}: rejected (${message})`)
        // Returning undefined ends the revision loop rather than retrying: a
        // proposer that retries until it gets something valid would hide how
        // often the model fails the format, which is itself a result.
        return undefined
      }
    },
  })

  // ---- held-out head-to-head ----------------------------------------------
  const handBestPolicy = HAND_POOL.find(policy => policy.id === handBest.policyId) ?? HAND_POOL[0]!
  const handStat: PolicyStat = statFor(heldOut.worlds, handBestPolicy, BINDING)

  // Selection happens on train for BOTH pools, and the held-out comparison is
  // then run on the winners. Picking one side's winner on train and the other's
  // on held-out would guarantee the second looked better -- which is exactly the
  // mistake an earlier revision of this file made, reporting a one-point "win"
  // that was an artifact of the comparison rather than of the policies.
  const inventedEvaluations = [...invented.entries()].map(([id, policy]) => ({
    id,
    evaluation: evaluatePolicy(train.worlds, policy, BETA, BINDING),
  }))
  const inventedBest =
    inventedEvaluations.length === 0
      ? undefined
      : inventedEvaluations.reduce((best, row) =>
          (row.evaluation.meanScore ?? -Infinity) > (best.evaluation.meanScore ?? -Infinity)
            ? row
            : best,
        )

  const inventedStat =
    inventedBest === undefined
      ? null
      : statFor(heldOut.worlds, invented.get(inventedBest.id)!, BINDING)

  const usage = proposals.reduce(
    (total, attempt) => ({
      promptTokens: total.promptTokens + attempt.promptTokens,
      completionTokens: total.completionTokens + attempt.completionTokens,
      cachedPromptTokens: total.cachedPromptTokens + attempt.cachedPromptTokens,
    }),
    { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0 },
  )

  return {
    generatedAt: new Date().toISOString(),
    model: client.model,
    effort: client.effort,
    regime: {
      ...SHAPE,
      roundLimit: BINDING.roundLimit,
      maxParallelism: BINDING.maxParallelism,
      trainWorlds: train.worlds.length,
      heldOutWorlds: heldOut.worlds.length,
      revisionsRequested: revisions,
    },
    handWritten: {
      pool: HAND_POOL.map((policy, index) => ({
        policy: policy.id,
        trainScore: handEvaluations[index]?.meanScore,
      })),
      bestOnTrain: handBest.policyId,
      bestOnTrainScore: handBest.meanScore,
    },
    proposals,
    invented: {
      acceptedIds: [...invented.keys()],
      bestOnTrain: inventedBest?.id,
      bestOnTrainScore: inventedBest?.evaluation.meanScore,
      meanTrainScore:
        inventedEvaluations.length === 0
          ? undefined
          : inventedEvaluations.reduce((sum, row) => sum + (row.evaluation.meanScore ?? 0), 0) /
            inventedEvaluations.length,
      acceptanceRate:
        proposals.length === 0
          ? 0
          : proposals.filter(attempt => attempt.accepted).length / proposals.length,
    },
    heldOut: {
      handWrittenBest: {
        policy: handBest.policyId,
        coverage: handStat.coverage,
        meanScore: handStat.mean_score,
      },
      inventedBest:
        inventedStat === null || inventedBest === undefined
          ? null
          : {
              policy: inventedBest.id,
              coverage: inventedStat.coverage,
              meanScore: inventedStat.mean_score,
            },
      inventedBeatsHandWritten:
        inventedStat === null ? null : inventedStat.mean_score > handStat.mean_score,
      deltaMeanScore:
        inventedStat === null ? null : inventedStat.mean_score - handStat.mean_score,
    },
    selectionGuarantee: {
      dreamSelected: outcome.selected.id,
      dreamIncumbent: outcome.incumbent.id,
      monotone: outcome.monotone,
      stopReason: outcome.stopReason,
    },
    tokenUsage: usage,
  }
}

export type { PolicyEvaluation }
