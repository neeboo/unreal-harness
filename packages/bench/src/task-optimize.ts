/**
 * The benchmark task: a real code optimization the agent performs, with a
 * deterministic evaluator.
 *
 * # The task
 *
 * The workspace holds a correct but slow implementation of a **rolling maximum**
 * over a sliding window. An attempt must produce a faster implementation that is
 * still correct. That is a genuine optimization problem with several real solution
 * families — a monotonic deque, a sparse table, a segment tree, block
 * decomposition, typed-array and loop-level tuning — so different attempts produce
 * genuinely different code rather than restatements of one idea.
 *
 * # Why this shape
 *
 * The published discovery benchmarks this repository sits beside (Dream-RSI's Lasso
 * path, Unreal Agent's Terminal-Bench) all measure the same thing: a correct
 * artifact, obtained for less compute. This task reproduces that structure at a
 * size that runs on a laptop with no container:
 *
 * - **Correctness is a gate**, checked against the seed's own output, so a fast
 *   wrong answer scores as a failure rather than a win.
 * - **Quality is held-out runtime**, measured on inputs the agent never saw, which
 *   is what stops "special-case the test" from being a strategy.
 * - **The evaluator is fixed and out-of-process**, so an attempt cannot influence
 *   how it is scored.
 * @module
 */

/** One evaluation instance: an input the candidate must handle. */
export interface BenchInstance {
  readonly name: string
  readonly values: readonly number[]
  readonly windowSize: number
}

/** The seed implementation's identifier, and the workspace it lives in. */
export const SEED_FILE = 'rolling-max.mjs'

/** The seed implementation: correct, obvious, and O(n·k). */
export const SEED_SOURCE = `/**
 * Rolling maximum over a sliding window.
 *
 * Correct but deliberately naive: rescans each window from scratch.
 * @param {number[]} values - the input series.
 * @param {number} windowSize - the window length, at least 1.
 * @returns {number[]} the maximum of each window, in order.
 */
export function rollingMax(values, windowSize) {
  const out = []
  for (let i = 0; i + windowSize <= values.length; i += 1) {
    let best = -Infinity
    for (let j = i; j < i + windowSize; j += 1) {
      if (values[j] > best) best = values[j]
    }
    out.push(best)
  }
  return out
}
`

/**
 * Development instances: large enough that a naive scan is measurably slow, small
 * enough to run many times per minute.
 */
export const DEV_INSTANCES: readonly BenchInstance[] = Object.freeze([
  { name: 'dev-ramp', values: ramp(20_000), windowSize: 32 },
  { name: 'dev-noisy', values: noisy(20_000, 20_000), windowSize: 64 },
])

/**
 * Held-out instances, never shown to the agent.
 *
 * Different sizes, window lengths, and value distributions on purpose: a candidate
 * that only special-cases the development shape fails the correctness gate here.
 */
export const HELD_OUT_INSTANCES: readonly BenchInstance[] = Object.freeze([
  { name: 'hold-ramp-wide', values: ramp(50_000), windowSize: 128 },
  { name: 'hold-noisy-wide', values: noisy(50_000, 50_000), windowSize: 256 },
  { name: 'hold-sawtooth', values: sawtooth(30_000, 97), windowSize: 17 },
  { name: 'hold-window-one', values: noisy(10_000, 10_000), windowSize: 1 },
  { name: 'hold-window-all', values: noisy(5_000, 5_000), windowSize: 5_000 },
])

function ramp(size: number): readonly number[] {
  return Array.from({ length: size }, (_, index) => index)
}

function noisy(size: number, span: number): readonly number[] {
  // A deterministic pseudo-random walk: reproducible across runs, which the
  // comparison needs, and awkward for a rolling maximum, which the task needs.
  const values: number[] = []
  let state = 12_345
  let current = span / 2
  for (let index = 0; index < size; index += 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    current += ((state / 2_147_483_648) - 0.5) * (span / 50)
    values.push(current)
  }
  return values
}

function sawtooth(size: number, period: number): readonly number[] {
  return Array.from({ length: size }, (_, index) => index % period)
}

/**
 * Reference outputs, computed with the seed under test.
 *
 * The seed defines correctness, so a candidate is correct exactly when it agrees
 * with the seed. Computing this here rather than storing literals makes the
 * definition impossible to drift from the seed.
 * @param instances - the instances to compute references for.
 * @returns one reference array per instance, in order.
 */
export function referenceOutputs(
  instances: readonly BenchInstance[],
): readonly (readonly number[])[] {
  return instances.map(instance => rollingMaxReference(instance.values, instance.windowSize))
}

/** The seed algorithm, run in-process so the reference cannot be tampered with. */
function rollingMaxReference(values: readonly number[], windowSize: number): readonly number[] {
  const out: number[] = []
  for (let i = 0; i + windowSize <= values.length; i += 1) {
    let best = -Infinity
    for (let j = i; j < i + windowSize; j += 1) {
      const value = values[j]!
      if (value > best) best = value
    }
    out.push(best)
  }
  return out
}

/**
 * The prompt for one attempt.
 *
 * Deliberately plain: a harness that helps by hinting at the solution would be
 * measuring its own hints. The agent is told what to optimize and how it is judged,
 * and nothing about how.
 * @param args - the parent's code, the already-tried ideas, and the iteration.
 * @returns the user message.
 */
export function attemptPrompt(args: {
  readonly currentSource: string
  readonly triedMutations: readonly string[]
  readonly devInstances: readonly BenchInstance[]
}): string {
  const shapes = args.devInstances
    .map(instance => `${instance.name}: n=${instance.values.length}, k=${instance.windowSize}`)
    .join('\n')
  const tried = args.triedMutations.length === 0
    ? '(nothing recorded yet)'
    : args.triedMutations.map(name => `- ${name}`).join('\n')

  return `You are optimizing one JavaScript file.

## Current implementation
\`\`\`js
${args.currentSource}
\`\`\`

## What has already been tried on this branch
${tried}

## Development inputs it must handle
${shapes}

## Your task
Rewrite \`${SEED_FILE}\` so it computes the same results faster. Correctness is
checked against the current implementation's own output on inputs you have not
seen, and quality is measured as runtime on those inputs.

## Reply format
Reply with a single fenced \`\`\`js code block containing the complete new file.
Keep the export named \`rollingMax\` and keep the same signature. Do not write
tests. Do not explain outside the code block. If nothing can be improved, reply
with the word NOCHANGE.`
}

/** Extract the code block from a model reply. */
export function extractSource(reply: string): string | undefined {
  const fenced = /```(?:js|javascript|mjs)\s*\n([\s\S]*?)```/.exec(reply)
  if (fenced?.[1] !== undefined) return fenced[1]
  const bare = /```\s*\n([\s\S]*?)```/.exec(reply)
  if (bare?.[1] !== undefined) return bare[1]
  // A model that ignored the format but wrote a module is still a real attempt;
  // rejecting it would measure formatting compliance instead of optimization.
  if (reply.includes('export function rollingMax')) return reply
  return undefined
}

/** The mutation labels a reply implies, for the "already tried" list. */
export const MUTATION_LABELS = Object.freeze([
  'monotonic-deque',
  'sparse-table',
  'segment-tree',
  'block-decomposition',
  'typed-array',
  'loop-tiling',
  'early-exit',
  'hello-world',
])
