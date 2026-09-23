/**
 * The `rsi/attemptLedger` projection unit.
 *
 * Registered on `ctx.sessionProjections`, so dsh owns the fold's caching,
 * invalidation, persisted-state validation and rebuild-from-log behaviour. This
 * package contributes the definition, not a storage mechanism — the same split
 * `rsi-trace` uses, for the same reason.
 *
 * @module @deepseek-ai/dsh-rsi-guided/projection
 */

import { z } from 'zod'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection/types'
import { foldAttemptLedger, initAttemptLedger } from './types.ts'
import type { AttemptLedgerState } from './types.ts'

const attemptRecordSchema = z.object({
  tool: z.string(),
  subject: z.string(),
  detail: z.string(),
  outcome: z.enum(['succeeded', 'failed', 'unknown']),
  error: z.string().optional(),
  step: z.number().int().nonnegative(),
  turn: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
}).strict()

const pendingCallSchema = z.object({
  tool: z.string(),
  detail: z.string(),
  turn: z.number().int().nonnegative(),
  step: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
}).strict()

const attemptLedgerStateSchema = z.object({
  // The offset is stored as a plain integer and transformed, matching how
  // SessionLogOffset is persisted elsewhere; a raw branded number would fail
  // validation on read.
  inheritedEventCount: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .transform(SessionLogOffset),
  order: z.array(z.string()),
  attempts: z.record(z.string(), attemptRecordSchema),
  pending: z.record(z.string(), pendingCallSchema),
}).strict().superRefine((state, context) => {
  // `order` must name every attempt exactly once. A divergence means a write path
  // bypassed the fold rather than a legitimate intermediate state, and a ledger
  // that silently drops attempts would under-report repeats -- the one thing it
  // exists to catch.
  const seen = new Set(state.order)
  if (seen.size !== state.order.length) {
    context.addIssue({ code: 'custom', message: 'attempt ledger order must not repeat an attempt' })
  }
  for (const key of state.order) {
    if (state.attempts[key] === undefined) {
      context.addIssue({ code: 'custom', message: `attempt ledger order names an unknown attempt: ${key}` })
    }
  }
  for (const key of Object.keys(state.attempts)) {
    if (!seen.has(key)) {
      context.addIssue({ code: 'custom', message: `attempt is missing from ledger order: ${key}` })
    }
  }
}) as unknown as z.ZodType<AttemptLedgerState>

/**
 * The projection unit this package owns.
 *
 * `stateVersion` must be bumped whenever the serialized fields or the fold
 * semantics change, so persisted rows from an older unit are discarded instead
 * of being applied forward into garbage.
 */
export const attemptLedgerProjection = {
  key: 'rsi/attemptLedger',
  stateSchema: attemptLedgerStateSchema,
  // The header is part of the contract but carries nothing this fold needs: the
  // ledger is derived entirely from events.
  init: (_header: SessionHeader, inheritedEventCount: SessionLogOffset) =>
    initAttemptLedger(inheritedEventCount),
  apply: foldAttemptLedger,
  stateVersion: 1,
} satisfies ProjectionDefinition<'rsi/attemptLedger', AttemptLedgerState>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'rsi/attemptLedger': AttemptLedgerState
  }
}
