/**
 * The two pure functions standing between model output and an executable policy.
 *
 * `extractJsonObject` is a hand-written scanner rather than a regex because model
 * replies are prose-wrapped and can contain braces inside strings. The cases below
 * are the ones that actually break naive implementations.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'

import { extractJsonObject } from '../src/propose-experiment.ts'

describe('extractJsonObject', () => {
  it('reads a bare object', () => {
    expect(extractJsonObject('{"id":"x","rules":[{"then":"any"}]}')).toEqual({
      id: 'x',
      rules: [{ then: 'any' }],
    })
  })

  it('reads an object wrapped in prose', () => {
    const text = 'Sure, here is the policy:\n{"id":"x","rules":[{"then":"any"}]}\nHope that helps.'
    expect(extractJsonObject(text)).toEqual({ id: 'x', rules: [{ then: 'any' }] })
  })

  it('reads an object inside a markdown fence', () => {
    const text = '```json\n{"id":"fenced","rules":[]}\n```'
    expect(extractJsonObject(text)).toEqual({ id: 'fenced', rules: [] })
  })

  it('does not stop at a brace inside a string', () => {
    // The rationale contains an unbalanced brace; a naive scanner closes the
    // object here and fails to parse.
    const text = '{"id":"x","rationale":"use { wisely","rules":[{"then":"any"}]}'
    const parsed = extractJsonObject(text) as { rationale?: string } | undefined
    expect(parsed?.rationale).toBe('use { wisely')
  })

  it('does not stop at an escaped quote inside a string', () => {
    const text = '{"id":"x","rationale":"a \\"quoted\\" word","rules":[{"then":"any"}]}'
    const parsed = extractJsonObject(text) as { rationale?: string } | undefined
    expect(parsed?.rationale).toBe('a "quoted" word')
  })

  it('returns undefined when there is no object at all', () => {
    expect(extractJsonObject('I cannot help with that.')).toBeUndefined()
  })

  it('returns undefined when the object is truncated', () => {
    expect(extractJsonObject('{"id":"x","rules":[{"then":')).toBeUndefined()
  })

  it('returns undefined when the braces balance but the JSON is invalid', () => {
    expect(extractJsonObject('{not json at all}')).toBeUndefined()
  })

  it('reads the first object when several are present', () => {
    const parsed = extractJsonObject('{"id":"first"} and {"id":"second"}') as {
      id?: string
    } | undefined
    expect(parsed?.id).toBe('first')
  })

  it('handles nested objects', () => {
    const parsed = extractJsonObject('{"id":"x","when":{"a":1,"b":2}}') as
      | { when?: { a?: number } }
      | undefined
    expect(parsed?.when?.a).toBe(1)
  })
})
