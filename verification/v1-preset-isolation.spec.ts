import { expect, it, onTestFinished } from 'vitest'
import { harness, declare, plugin, agentOn } from './harness.ts'

// V1 of PHASE0-VERIFICATION.md -- corrected conclusion.
//
// QUESTION: can RSI-Harness bind per-session state (scorer / policy runtime)
// through an agent preset, without modifying dsh?
//
// ANSWER (established by these tests): NO -- and that is fine, because dsh
// offers the right mechanism elsewhere.
//
//   * A preset service sits behind an `isolate` realm, which isolates it ACROSS
//     PRESETS, not across Agents. Two Agents on the same preset share one
//     mounted fiber (the registry caches one `generation` per preset and hands
//     back the same key), so they resolve the SAME instance. Per-Agent state
//     must therefore NOT live in a preset service.
//   * Per-Agent isolation is `dsh-scope`: "a tool registered through `agent.ctx`
//     is visible only to that agent". Session-keyed durable state belongs in
//     `ctx.storageDomain` keyed by `sessionId`.
it('shares one isolate-realm service per preset (not per Agent)', async () => {
  const ctx = await harness()
  onTestFinished(() => ctx.fiber.dispose())

  await declare(ctx, {
    id: 'standard',
    plugins: [{
      name: 'cordis:group',
      group: true,
      isolate: { rsiScorer: true },
      config: [{ name: plugin('isolated-service'), config: { label: 'scorer' } }],
    }],
  })

  const a = await agentOn(ctx, 'agent-a', 'standard')
  const b = await agentOn(ctx, 'agent-b', 'standard')

  // The registry is the intended read path for a service inside a preset group
  // (a bare `agent.ctx.get(...)` targets the root realm and finds nothing).
  const scorerA = ctx.agentPresets.serviceFor(a, 'rsiScorer')
  const scorerB = ctx.agentPresets.serviceFor(b, 'rsiScorer')

  expect(scorerA).toBeDefined()
  expect(scorerB).toBeDefined()
  // Same preset => same generation => same mounted fiber => same instance.
  // This is WHY per-session state cannot live here.
  expect(scorerA).toBe(scorerB)
})

// The enforceability half: a preset service with no `isolate` realm lands in
// the ROOT realm, and dsh rejects the mount outright rather than silently
// sharing an implementation across every session in the process.
it('rejects a preset service that leaks into the root realm', async () => {
  const ctx = await harness()
  onTestFinished(() => ctx.fiber.dispose())

  // `declare` only registers a definition; the leak audit runs at MOUNT time,
  // so the rejection surfaces when an Agent actually mounts the preset.
  await declare(ctx, {
    id: 'leaky',
    plugins: [{ name: plugin('global-service'), config: { service: 'rsiScorer', label: 'leak' } }],
  })
  await expect(agentOn(ctx, 'leaky-agent', 'leaky')).rejects.toThrow(/isolate realm/)
})
