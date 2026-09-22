/**
 * The evaluator: run an attempt's code out of process and measure it.
 *
 * # Why out of process
 *
 * The candidate is model-written code. If it ran in this process it could patch the
 * timer, mutate the reference output, or crash the run — none of which a benchmark
 * can tolerate, because each turns a measurement into a claim about the candidate's
 * cooperation. A child process gives the measurement its own address space, a hard
 * timeout, and a verdict that is a fact rather than a callback.
 *
 * # What it measures
 *
 * - **Correctness first, and it is a gate.** A candidate's output is compared to the
 *   seed's on every held-out instance. A wrong answer scores as a failure however
 *   fast it ran, which is what stops "skip the work" from being an optimization.
 * - **Quality is median runtime over repetitions**, taken per instance and summed.
 *   Median rather than mean because a single GC pause should not decide a
 *   comparison, and repetitions because the first call includes JIT warm-up that
 *   has nothing to do with the algorithm.
 * - **Correctness is judged on held-out instances**, never the development ones the
 *   agent can see, so special-casing what it was shown does not help.
 * @module
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BenchInstance } from './task-optimize.ts'

/** The verdict on one candidate. */
export interface EvaluationResult {
  /** Whether the candidate matched the seed on every held-out instance. */
  readonly correct: boolean
  /**
   * Median total milliseconds across the held-out instances.
   *
   * `undefined` when the candidate was not correct: it has no quality, because a
   * fast wrong answer is not a result.
   */
  readonly medianMs: number | undefined
  /** Speedup over the seed, when the seed was measured and the candidate is correct. */
  readonly speedup: number | undefined
  /** Why the candidate failed, when it did. */
  readonly failure?: string
  /** Per-instance detail, for diagnosing an unexpected verdict. */
  readonly perInstance: readonly {
    readonly name: string
    readonly correct: boolean
    readonly medianMs: number
    readonly detail?: string
  }[]
}

/** How the evaluator is configured. */
export interface EvaluatorOptions {
  /** Instances the candidate must match the seed on. */
  readonly instances: readonly BenchInstance[]
  /** Reference outputs, in the same order as `instances`. */
  readonly reference: readonly (readonly number[])[]
  /** Repetitions per instance; the median is reported. */
  readonly repetitions?: number
  /** Hard timeout for the whole child, in milliseconds. */
  readonly timeoutMs?: number
  /**
   * The implementation the reference was taken from, measured to produce a speedup.
   *
   * Passed in rather than assumed so the comparison is against the same seed the
   * reference came from.
   */
  readonly seedSource?: string
}

/** Default repetitions. Enough to see past JIT warm-up without a slow run. */
const DEFAULT_REPETITIONS = 7

/** Default timeout: generous for 50k-element inputs, short enough to fail fast. */
const DEFAULT_TIMEOUT_MS = 60_000

/**
 * The child program.
 *
 * Written as source and handed to `node -e`, so evaluating a candidate needs no
 * file on disk beside the candidate itself and no module resolution games.
 */
const CHILD_PROGRAM = `
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const payload = JSON.parse(readFileSync(process.argv[1], 'utf8'))
const module_ = await import(pathToFileURL(payload.sourcePath).href)
const fn = module_.rollingMax
if (typeof fn !== 'function') {
  process.stdout.write(JSON.stringify({ error: 'the module does not export rollingMax' }))
  process.exit(0)
}

const results = []
for (const instance of payload.instances) {
  const values = instance.values
  const k = instance.windowSize
  let last
  const samples = []
  for (let rep = 0; rep < payload.repetitions; rep += 1) {
    const started = process.hrtime.bigint()
    last = fn(values, k)
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6
    // Discard the first call: it carries JIT warm-up, not algorithm cost.
    if (rep > 0) samples.push(elapsed)
  }
  samples.sort((a, b) => a - b)
  const medianMs = samples.length === 0 ? 0 : samples[Math.floor(samples.length / 2)]
  const expected = instance.expected
  let correct = Array.isArray(last) && last.length === expected.length
  if (correct) {
    for (let i = 0; i < expected.length; i += 1) {
      if (last[i] !== expected[i]) { correct = false; break }
    }
  }
  results.push({ name: instance.name, correct, medianMs, length: last?.length ?? -1 })
}
process.stdout.write(JSON.stringify({ results }))
`

/**
 * Evaluate one candidate source against the held-out instances.
 *
 * @param source - the candidate module's source.
 * @param options - instances, references, repetitions, and timeout.
 * @returns the verdict, including quality only when the candidate was correct.
 */
export async function evaluateCandidate(
  source: string,
  options: EvaluatorOptions,
): Promise<EvaluationResult> {
  const repetitions = options.repetitions ?? DEFAULT_REPETITIONS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const directory = await mkdtemp(join(tmpdir(), 'rsi-bench-'))

  try {
    const candidatePath = join(directory, 'candidate.mjs')
    await writeFile(candidatePath, source, 'utf8')
    const payloadPath = join(directory, 'payload.json')
    await writeFile(payloadPath, JSON.stringify({
      sourcePath: candidatePath,
      repetitions,
      instances: options.instances.map((instance, index) => ({
        name: instance.name,
        values: instance.values,
        windowSize: instance.windowSize,
        expected: options.reference[index] ?? [],
      })),
    }), 'utf8')

    const child = await runChild(payloadPath, timeoutMs)
    if (child.timedOut) {
      return {
        correct: false,
        medianMs: undefined,
        speedup: undefined,
        failure: `the candidate exceeded the ${timeoutMs}ms budget`,
        perInstance: [],
      }
    }
    if (child.error !== undefined) {
      return {
        correct: false,
        medianMs: undefined,
        speedup: undefined,
        failure: child.error,
        perInstance: [],
      }
    }

    const perInstance = child.results.map(entry => ({
      name: entry.name,
      correct: entry.correct,
      medianMs: entry.medianMs,
      ...entry.correct ? {} : { detail: `length ${entry.length}, expected ${entry.expectedLength}` },
    }))
    const wrong = perInstance.filter(entry => !entry.correct)
    if (wrong.length > 0) {
      return {
        correct: false,
        medianMs: undefined,
        speedup: undefined,
        failure: `incorrect on ${wrong.map(entry => entry.name).join(', ')}`,
        perInstance,
      }
    }

    const medianMs = perInstance.reduce((sum, entry) => sum + entry.medianMs, 0)
    let speedup: number | undefined
    if (options.seedSource !== undefined) {
      // Rebuild without `seedSource` rather than passing `undefined`:
      // `exactOptionalPropertyTypes` treats an absent key and an undefined value as
      // different, and the recursion must terminate.
      const { seedSource: _omit, ...withoutSeed } = options
      const seed = await evaluateCandidate(options.seedSource, withoutSeed)
      // A seed that cannot be measured means there is no baseline to divide by, and
      // reporting a speedup against an unmeasured baseline would be a fabrication.
      if (seed.correct && seed.medianMs !== undefined && medianMs > 0) {
        speedup = seed.medianMs / medianMs
      }
    }

    return { correct: true, medianMs, speedup, perInstance }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

interface ChildOutcome {
  readonly timedOut: boolean
  readonly error?: string
  readonly results: readonly {
    readonly name: string
    readonly correct: boolean
    readonly medianMs: number
    readonly length: number
    readonly expectedLength: number
  }[]
}

/** Run the child and collect its verdict. */
function runChild(payloadPath: string, timeoutMs: number): Promise<ChildOutcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_PROGRAM, payloadPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      resolve({ timedOut: true, results: [] })
    }, timeoutMs)

    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ timedOut: false, error: `could not start the evaluator: ${error.message}`, results: [] })
    })
    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      let parsed: { error?: string; results?: ChildOutcome['results'] }
      try {
        parsed = JSON.parse(stdout) as typeof parsed
      } catch {
        // A candidate that fails to parse is a real failure mode, and the stderr is
        // what explains it. Reporting both keeps the verdict diagnosable.
        resolve({
          timedOut: false,
          error: `the candidate did not produce a result (${stderr.trim().slice(0, 300) || 'no output'})`,
          results: [],
        })
        return
      }
      if (parsed.error !== undefined) {
        resolve({ timedOut: false, error: parsed.error, results: [] })
        return
      }
      resolve({ timedOut: false, results: parsed.results ?? [] })
    })
  })
}

/** Absolute path of a module file, for callers that need to reference one. */
export function moduleUrl(path: string): string {
  return pathToFileURL(path).href
}
