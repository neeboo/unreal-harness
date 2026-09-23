/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-rsi-guided`.
 * @module @deepseek-ai/dsh-rsi-guided/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-rsi-guided'

/** Cordis companion plugin name. */
export const name = 'rsi-guided-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant to install.
 *
 * The ledger's contracts are all synchronous and are proven by this package's
 * specs rather than re-derived here: the fold is pure and total (an event it does
 * not understand returns the same state reference), the projection's schema
 * rejects a ledger whose `order` and `attempts` disagree, and the prompt
 * contribution is asserted against the request the *model* received — which is
 * the artifact that matters, and one this companion could not observe without
 * re-running an assembly.
 *
 * Restating the fold as an invariant would duplicate the implementation rather
 * than detect drift from it.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
