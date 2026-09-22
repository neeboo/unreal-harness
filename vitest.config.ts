import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    /**
     * Only packages that run standalone are included.
     *
     * `packages/rsi-trace` is a dsh plugin: its tests mount real dsh services
     * (AgentLoop, SessionStore, session projections) and therefore run inside a
     * dsh checkout, per PHASE0-VERIFICATION.md. Pointing vitest at them here
     * would fail on unresolvable peers rather than on anything real, so they are
     * excluded instead of being made to pass vacuously.
     */
    include: ['packages/judgment/tests/**/*.spec.ts'],
    pool: 'forks',
    passWithNoTests: false,
  },
})
