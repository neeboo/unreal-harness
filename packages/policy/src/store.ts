/**
 * The policy store: a durable record of which version is deployed and how each
 * one scored.
 *
 * The store exists because the loop's central claim is comparative. "This policy
 * is better" only means something against a recorded score for the policy it
 * replaced, and "we deployed the winner" only means something if the incumbent
 * can be named later. A loop that tracked neither would still produce a policy —
 * it just would not be able to say why.
 *
 * # Append-only, and the current version is a separate fact
 *
 * Records are never rewritten. Which one is *deployed* is a pointer, kept
 * separately, so a policy can be re-selected without editing history and a bad
 * deployment can be rolled back to a version whose score is still on record.
 * @module
 */

import type { ExplorationPolicy } from './types.ts'
import type { PolicyEvaluation } from './dream.ts'

/** One recorded policy version. */
export interface PolicyRecord {
  readonly policyId: string
  readonly label?: string
  /**
   * The intensity scalar this version was evaluated at.
   *
   * Stored rather than recomputed: a policy's β is part of what was scored, and
   * a later sweep must not be able to relabel an old result.
   */
  readonly beta: number
  /** The evaluation this version received, once it has one. */
  readonly evaluation?: PolicyEvaluation
  /** Monotone insertion counter, so records have a stable order. */
  readonly sequence: number
}

/** Why a store operation was refused. */
export class PolicyStoreError extends Error {
  override readonly name = 'PolicyStoreError'

  constructor(
    readonly code: 'unknown-policy' | 'already-recorded',
    message: string,
  ) {
    super(message)
  }
}

/**
 * An append-only record of policy versions with a separate deployed pointer.
 */
export class PolicyStore {
  private readonly records: PolicyRecord[] = []
  private readonly byId = new Map<string, PolicyRecord>()
  private deployedId: string | undefined

  /**
   * Record a policy version.
   *
   * @param policy - the version to record.
   * @param evaluation - its score, when it has been evaluated.
   * @returns the stored record.
   * @throws {PolicyStoreError} when the id is already recorded — a re-recorded id
   * would make every later comparison ambiguous about which version it named.
   */
  record(policy: ExplorationPolicy, evaluation?: PolicyEvaluation): PolicyRecord {
    if (this.byId.has(policy.id)) {
      throw new PolicyStoreError(
        'already-recorded',
        `policy "${policy.id}" is already recorded; a version id must name one version`,
      )
    }
    const record: PolicyRecord = {
      policyId: policy.id,
      ...policy.label === undefined ? {} : { label: policy.label },
      beta: policy.beta,
      ...evaluation === undefined ? {} : { evaluation },
      sequence: this.records.length,
    }
    this.records.push(record)
    this.byId.set(record.policyId, record)
    return record
  }

  /**
   * Attach an evaluation to an already-recorded policy.
   *
   * Separate from {@link PolicyStore.record} so a policy can be recorded when it
   * is deployed and scored later, which is the order a live loop produces.
   * @param policyId - the version to update.
   * @param evaluation - its score.
   * @returns the updated record.
   * @throws {PolicyStoreError} when the id is unknown.
   */
  attachEvaluation(policyId: string, evaluation: PolicyEvaluation): PolicyRecord {
    const existing = this.byId.get(policyId)
    if (existing === undefined) {
      throw new PolicyStoreError('unknown-policy', `unknown policy "${policyId}"`)
    }
    if (evaluation.policyId !== policyId) {
      // A mismatched id would silently attach one policy's score to another,
      // which is exactly the failure a comparative record must not have.
      throw new PolicyStoreError(
        'unknown-policy',
        `evaluation names "${evaluation.policyId}" but was attached to "${policyId}"`,
      )
    }
    const updated: PolicyRecord = { ...existing, evaluation }
    this.records[existing.sequence] = updated
    this.byId.set(policyId, updated)
    return updated
  }

  /**
   * Mark a version as deployed.
   * @param policyId - the version to deploy.
   * @throws {PolicyStoreError} when the id is unknown.
   */
  deploy(policyId: string): void {
    if (!this.byId.has(policyId)) {
      throw new PolicyStoreError('unknown-policy', `cannot deploy unknown policy "${policyId}"`)
    }
    this.deployedId = policyId
  }

  /** The deployed version's id, if one has been deployed. */
  get deployed(): string | undefined {
    return this.deployedId
  }

  /** The deployed record, if one has been deployed. */
  get deployedRecord(): PolicyRecord | undefined {
    return this.deployedId === undefined ? undefined : this.byId.get(this.deployedId)
  }

  /** Look up one record. */
  get(policyId: string): PolicyRecord | undefined {
    return this.byId.get(policyId)
  }

  /** Every record, in insertion order. */
  all(): readonly PolicyRecord[] {
    return [...this.records]
  }

  /**
   * Every record that carries a score, best first.
   *
   * Unscored records are excluded rather than sorted last: a version that was
   * recorded but never evaluated is not a poor performer, it is an unknown, and
   * ranking it would invite a caller to read a verdict that was never given.
   * @returns scored records, highest mean score first.
   */
  ranked(): readonly PolicyRecord[] {
    return this.records
      .filter((record): record is PolicyRecord & { evaluation: PolicyEvaluation } =>
        record.evaluation?.meanScore !== undefined)
      .sort((left, right) => (right.evaluation.meanScore ?? 0) - (left.evaluation.meanScore ?? 0))
  }

  /**
   * A serialisable snapshot of the whole store.
   *
   * The store is the durable artifact of a loop that may run for days, so it
   * must survive a restart. `sequence` is included so a restored store keeps the
   * same order regardless of how the backing store enumerates it.
   * @returns a lossless snapshot.
   */
  snapshot(): {
    readonly records: readonly PolicyRecord[]
    readonly deployed: string | undefined
  } {
    return { records: this.all(), deployed: this.deployedId }
  }

  /**
   * Rebuild a store from a snapshot.
   * @param snapshot - a value produced by {@link PolicyStore.snapshot}.
   * @returns the restored store.
   * @throws {PolicyStoreError} when the snapshot repeats an id or names a
   * deployed policy it does not contain.
   */
  static restore(snapshot: {
    readonly records: readonly PolicyRecord[]
    readonly deployed: string | undefined
  }): PolicyStore {
    const store = new PolicyStore()
    for (const record of [...snapshot.records].sort((a, b) => a.sequence - b.sequence)) {
      if (store.byId.has(record.policyId)) {
        throw new PolicyStoreError(
          'already-recorded',
          `snapshot repeats policy "${record.policyId}"`,
        )
      }
      store.records.push(record)
      store.byId.set(record.policyId, record)
    }
    if (snapshot.deployed !== undefined) {
      if (!store.byId.has(snapshot.deployed)) {
        throw new PolicyStoreError(
          'unknown-policy',
          `snapshot deploys unknown policy "${snapshot.deployed}"`,
        )
      }
      store.deployedId = snapshot.deployed
    }
    return store
  }
}
