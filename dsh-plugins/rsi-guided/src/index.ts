/**
 * Trace-guided context: put the session's own attempt history back in the prompt.
 *
 * # The gap this closes
 *
 * `rsi-trace` records what a session tried. Recording changes nothing: the
 * measured effect of mounting it on Terminal-Bench was a pass rate
 * indistinguishable from the bare harness, which is exactly what an
 * observational layer should do. To have any effect on outcomes, a layer has to
 * change what the agent *sees*.
 *
 * This plugin does the smallest honest version of that. It folds the session's
 * tool calls into an attempt ledger and contributes a short, literal summary to
 * the model's dynamic context: how many attempts have been made, and which ones
 * failed and why. An agent that has forgotten that it already ran a failing
 * command will run it again; showing it the failure is the cheapest possible
 * intervention, and unlike a judgement it cannot invent anything — every line is
 * a thing that actually happened in this session.
 *
 * # Why it is a prompt *context* and not a prompt *section*
 *
 * dsh's `systemPrompt.context()` materialises dynamic material as a durable
 * user-role snapshot *after* retained history, whereas a section rewrites the
 * system prompt. The distinction matters for cost: the system prompt is the
 * cacheable prefix, so a section whose text changes every step would invalidate
 * the cache on every step. A context travels after the prefix and leaves it
 * intact. On `deepseek-flash` that is the difference between $0.003 and
 * $0.15 per million tokens on the re-sent prompt.
 *
 * # What it does not do
 *
 * It does not steer, rank, plan, or summarise. Advisory layers acquire a habit of
 * asserting things about a session they can only observe, and a confident wrong
 * assertion in a prompt is worse than silence. Everything rendered here is a
 * literal record.
 *
 * @module @unreal-harness/rsi-guided
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import { attemptLedgerProjection } from './projection.ts'
import {
  DEFAULT_LEDGER_LIMIT,
  renderLedger,
  type AttemptLedgerState,
  type AttemptRecord,
} from './types.ts'

export { attemptLedgerProjection } from './projection.ts'
export {
  DEFAULT_LEDGER_LIMIT,
  ERROR_EXCERPT_LIMIT,
  attemptIdentity,
  excerptFromMessage,
  foldAttemptLedger,
  initAttemptLedger,
  renderLedger,
  shortDigest,
} from './types.ts'
export type { AttemptLedgerState, AttemptOutcome, AttemptRecord } from './types.ts'

export const name = 'rsi-guided'
export const inject = ['sessionProjections']

declare module '@deepseek-ai/cordis' {
  interface Context {
    rsiGuided: RsiGuided
  }
}

/** Options for the guidance layer. */
export interface RsiGuidedConfig {
  /**
   * Where the ledger sits in the dynamic-context order.
   *
   * 120 places it after the approval policy (115) and among the tool-guidance
   * band (100-199), which is where a reader of the assembled prompt expects
   * operational detail about the run to appear.
   */
  readonly order?: number
  /** Maximum failed attempts rendered per assembly. */
  readonly limit?: number
  /** When false, the projection is still folded but nothing is contributed. */
  readonly enabled?: boolean
}

/**
 * The advisory service.
 *
 * Every method takes its session explicitly. dsh's projection registry scopes a
 * fold per session, so this service is stateless and needs no per-session map —
 * the same shape `rsi-trace` uses, for the same reason.
 */
export class RsiGuided extends Service {
  static inject = ['sessionProjections', 'systemPrompt']

  private readonly order: number
  private readonly limit: number
  private readonly enabled: boolean

  constructor(ctx: Context, config: RsiGuidedConfig = {}) {
    super(ctx, 'rsiGuided')
    this.order = config.order ?? 120
    this.limit = config.limit ?? DEFAULT_LEDGER_LIMIT
    this.enabled = config.enabled ?? true

    // Registered from the service constructor, not a sibling `ctx.inject`
    // callback: this class requires `sessionProjections`, so the service exists
    // by the time it is built, and the fiber that owns this registration is the
    // service's own. A sibling callback would tie the fold's lifetime to a fiber
    // that settles after this plugin has finished loading.
    ctx.effect(() => ctx.sessionProjections.register(attemptLedgerProjection))

    if (this.enabled) {
      ctx.systemPrompt.context({
        name: 'rsi-guided:attempts',
        order: this.order,
        text: context => {
          const agent = context.agent
          // A bare assemble() -- diagnostics, tests -- has no session to report
          // on, and inventing one would put another session's attempts in this
          // prompt.
          if (agent === undefined) return ''
          return this.guidance(agent.session)
        },
      })
    }
  }

  /**
   * Current ledger for one session.
   * @param session - the session whose attempts are read.
   * @returns the ledger, or `undefined` when this session has made no attempts.
   */
  ledger(session: Session): AttemptLedgerState | undefined {
    return this.ctx.sessionProjections.stateOf(session, 'rsi/attemptLedger')
  }

  /**
   * Recorded attempts in first-seen order.
   * @param session - the session whose attempts are read.
   * @returns attempts oldest first; empty when none are recorded.
   */
  attempts(session: Session): readonly AttemptRecord[] {
    const state = this.ledger(session)
    if (state === undefined) return []
    return state.order.flatMap(key => {
      const attempt = state.attempts[key]
      return attempt === undefined ? [] : [attempt]
    })
  }

  /**
   * The prompt text this layer contributes for one session.
   *
   * Exposed separately from the registration so a test — or a report — can read
   * exactly what the agent would have been shown, rather than inferring it from a
   * rendered prompt.
   *
   * @param session - the session whose attempts are rendered.
   * @returns prompt text, or an empty string when there is nothing to say.
   */
  guidance(session: Session): string {
    const state = this.ledger(session)
    if (state === undefined) return ''
    return renderLedger(state, { limit: this.limit })
  }
}

export default RsiGuided
