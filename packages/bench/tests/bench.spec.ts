/**
 * The benchmark's measuring apparatus.
 *
 * These are the parts that must be trustworthy for any number the benchmark prints
 * to mean anything: the model call's pinning and accounting, the evaluator's
 * correctness gate and its process isolation, and the report's honesty markers. A
 * bug in any of them would produce a plausible number that is wrong, which is the
 * one failure mode a benchmark cannot recover from.
 */
import { describe, expect, it, vi } from 'vitest'
import { CompletionError, DeepSeekClient, DEFAULT_MODEL } from '../src/deepseek.ts'
import { evaluateCandidate } from '../src/evaluator.ts'
import { HELD_OUT_INSTANCES, referenceOutputs } from '../src/task-optimize.ts'

/** A transport that answers with one canned body and records what it received. */
function stub(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = []
  const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  })
  return { transport: transport as unknown as typeof fetch, calls }
}

const okBody = {
  model: DEFAULT_MODEL,
  choices: [{ message: { content: 'hi', reasoning_content: 'thinking' }, finish_reason: 'stop' }],
  usage: {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 64 },
  },
}

describe('DeepSeekClient', () => {
  it('pins the model id the API actually accepts', async () => {
    const { transport, calls } = stub(okBody)
    const client = new DeepSeekClient({ apiKey: 'k', fetch: transport })
    await client.complete([{ role: 'user', content: 'x' }])

    const body = JSON.parse(String(calls[0]!.init.body)) as { model: string }
    // `deepseek-v41-flash` and `deepseek-v4.1-flash` both return HTTP 400; the only
    // accepted id for DeepSeek-V4.1-Flash is `deepseek-flash`.
    expect(body.model).toBe(DEFAULT_MODEL)
  })

  it('sends a fixed reasoning effort, because two arms differing in effort is not a comparison', async () => {
    const { transport, calls } = stub(okBody)
    await new DeepSeekClient({ apiKey: 'k', fetch: transport, effort: 'high' })
      .complete([{ role: 'user', content: 'x' }])

    const body = JSON.parse(String(calls[0]!.init.body)) as { reasoning_effort: string }
    expect(body.reasoning_effort).toBe('high')
  })

  it('reports token accounting including cached prompt tokens', async () => {
    const { transport } = stub(okBody)
    const result = await new DeepSeekClient({ apiKey: 'k', fetch: transport })
      .complete([{ role: 'user', content: 'x' }])

    // Cache tokens are where the design's cost claims live, so they must survive
    // the client rather than be folded into a total.
    expect(result.usage).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
      cachedPromptTokens: 64,
    })
    expect(result.text).toBe('hi')
    expect(result.reasoningText).toBe('thinking')
  })

  it('refuses a response that names a different model than requested', async () => {
    const { transport } = stub({ ...okBody, model: 'deepseek-v4-pro' })
    const client = new DeepSeekClient({ apiKey: 'k', fetch: transport })

    // A silent substitution would make every downstream number unattributable.
    await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toThrow(CompletionError)
  })

  it('surfaces a provider failure with its status', async () => {
    const { transport } = stub({ error: 'rate limited' }, 429)
    const client = new DeepSeekClient({ apiKey: 'k', fetch: transport })
    await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ status: 429 })
  })

  it('refuses an empty key rather than sending an unauthenticated request', () => {
    expect(() => new DeepSeekClient({ apiKey: '  ', fetch: stub(okBody).transport })).toThrow(/key is required/)
  })
})

describe('evaluateCandidate', () => {
  const reference = referenceOutputs(HELD_OUT_INSTANCES)
  const instances = HELD_OUT_INSTANCES

  it('accepts a correct implementation and reports a runtime', async () => {
    // A monotonic deque: correct, and the kind of thing the agent is asked to find.
    const good = `
export function rollingMax(values, k) {
  const out = []
  const deque = []
  for (let i = 0; i < values.length; i += 1) {
    while (deque.length > 0 && values[deque[deque.length - 1]] <= values[i]) deque.pop()
    deque.push(i)
    if (deque[0] <= i - k) deque.shift()
    if (i >= k - 1) out.push(values[deque[0]])
  }
  return out
}
`
    const result = await evaluateCandidate(good, { instances, reference })
    expect(result.correct).toBe(true)
    expect(result.medianMs).toBeGreaterThanOrEqual(0)
    expect(result.failure).toBeUndefined()
  })

  it('records a wrong answer as a failure even when it is fast', async () => {
    const wrong = `
export function rollingMax(values, k) {
  return new Array(values.length - k + 1).fill(0)
}
`
    const result = await evaluateCandidate(wrong, { instances, reference })
    // Correctness is a gate: a fast wrong answer has no runtime and no speedup.
    expect(result.correct).toBe(false)
    expect(result.medianMs).toBeUndefined()
    expect(result.speedup).toBeUndefined()
    expect(result.failure).toContain('incorrect on')
  })

  it('reports a module without the export rather than crashing the run', async () => {
    const result = await evaluateCandidate('export const nope = 1\n', { instances, reference })
    expect(result.correct).toBe(false)
    expect(result.failure).toContain('rollingMax')
  })

  it('reports a module that does not parse, with the reason', async () => {
    const result = await evaluateCandidate('export function rollingMax( {', { instances, reference })
    expect(result.correct).toBe(false)
    expect(result.failure).toBeDefined()
  })

  it('kills a candidate that exceeds its budget instead of hanging the benchmark', async () => {
    const spin = `
export function rollingMax(values, k) {
  for (;;) { /* deliberately never returns */ }
}
`
    const result = await evaluateCandidate(spin, { instances, reference, timeoutMs: 1_500 })
    expect(result.correct).toBe(false)
    expect(result.failure).toContain('exceeded')
  })

  it('measures a speedup against the seed it is given', async () => {
    const slow = `
export function rollingMax(values, k) {
  const out = []
  for (let i = 0; i + k <= values.length; i += 1) {
    let best = -Infinity
    for (let j = i; j < i + k; j += 1) if (values[j] > best) best = values[j]
    out.push(best)
  }
  return out
}
`
    const fast = `
export function rollingMax(values, k) {
  const out = []
  const deque = []
  for (let i = 0; i < values.length; i += 1) {
    while (deque.length > 0 && values[deque[deque.length - 1]] <= values[i]) deque.pop()
    deque.push(i)
    if (deque[0] <= i - k) deque.shift()
    if (i >= k - 1) out.push(values[deque[0]])
  }
  return out
}
`
    const result = await evaluateCandidate(fast, {
      instances: instances.slice(0, 3),
      reference: reference.slice(0, 3),
      seedSource: slow,
    })
    expect(result.correct).toBe(true)
    // The seed is O(n·k) and the candidate is O(n), so a speedup above 1 is the
    // expected direction. The exact value depends on the machine; the direction
    // does not.
    expect(result.speedup).toBeGreaterThan(1)
  })

  it('reports no speedup when the seed itself cannot be measured', async () => {
    // A correct implementation, so the only thing under test is what happens when
    // the SEED cannot be measured.
    const good = `
export function rollingMax(values, k) {
  const out = []
  const deque = []
  for (let i = 0; i < values.length; i += 1) {
    while (deque.length > 0 && values[deque[deque.length - 1]] <= values[i]) deque.pop()
    deque.push(i)
    if (deque[0] <= i - k) deque.shift()
    if (i >= k - 1) out.push(values[deque[0]])
  }
  return out
}
`
    const result = await evaluateCandidate(good, {
      instances: instances.slice(0, 1),
      reference: reference.slice(0, 1),
      // A seed that does not export the function gives no baseline to divide by,
      // and a speedup against an unmeasured baseline would be a fabrication.
      seedSource: 'export const nope = 1\n',
    })
    expect(result.correct).toBe(true)
    expect(result.speedup).toBeUndefined()
  })
})
