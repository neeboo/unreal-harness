/**
 * The capability catalogue: many abilities, few schemas paid for.
 *
 * The case that matters is the one where nothing matches. A catalogue that
 * releases a schema for every query has not solved the problem it exists for —
 * it has renamed it — so "withheld" has to be asserted, not assumed.
 */
import { describe, expect, it } from 'vitest'
import { CapabilityCatalogue, DEFAULT_MATCH_LIMIT } from '../src/index.ts'
import type { CapabilityEntry } from '../src/index.ts'

function entry(name: string, summary: string, keywords: readonly string[]): CapabilityEntry {
  return { name, summary, keywords, schema: { name, description: summary } }
}

const entries: readonly CapabilityEntry[] = [
  entry('kubernetes_deploy', 'Roll out a deployment to a Kubernetes cluster', ['k8s', 'deploy', 'rollout']),
  entry('sql_explain', 'Explain a SQL query plan', ['sql', 'query', 'plan', 'database']),
  entry('screenshot', 'Capture a screenshot of a web page', ['browser', 'image', 'capture']),
  entry('send_email', 'Send an email message', ['mail', 'notify']),
]

describe('CapabilityCatalogue', () => {
  it('lists every capability cheaply, without releasing any schema', () => {
    const catalogue = new CapabilityCatalogue(entries)
    const listing = catalogue.listing()

    // The model learns that four abilities exist and pays for none of their
    // contracts. This is what makes a large catalogue affordable.
    expect(listing).toHaveLength(4)
    expect(Object.keys(listing[0]!)).toEqual(['name', 'summary'])
    expect(catalogue.size).toBe(4)
  })

  it('releases only what the query reaches', () => {
    const catalogue = new CapabilityCatalogue(entries)
    const matches = catalogue.match('how do I explain this slow sql query')

    expect(matches.map(m => m.entry.name)).toEqual(['sql_explain'])
    expect(matches[0]!.matchedTerms.length).toBeGreaterThan(1)
    // The other three stay withheld — the property the catalogue exists for.
    expect(catalogue.schemasFor('how do I explain this slow sql query')).toHaveLength(1)
  })

  it('withholds everything when nothing matches', () => {
    const catalogue = new CapabilityCatalogue(entries)

    // A miss must be a miss. Releasing on no evidence is the failure mode this
    // module exists to prevent.
    expect(catalogue.match('refactor the authentication middleware')).toEqual([])
    expect(catalogue.schemasFor('refactor the authentication middleware')).toEqual([])
    expect(catalogue.hasMatch('refactor the authentication middleware')).toBe(false)
  })

  it('ranks by how many distinct query terms hit, breaking ties by name', () => {
    const catalogue = new CapabilityCatalogue(entries)
    const matches = catalogue.match('sql query plan and browser capture')

    // `sql_explain` hits three terms, `screenshot` two.
    expect(matches.map(m => m.entry.name)).toEqual(['sql_explain', 'screenshot'])
    expect(matches[0]!.score).toBeGreaterThan(matches[1]!.score)
  })

  it('bounds the release rather than trusting the query', () => {
    const many = Array.from({ length: DEFAULT_MATCH_LIMIT + 5 }, (_, i) =>
      entry(`tool_${i}`, 'shared description words', ['shared']))
    const catalogue = new CapabilityCatalogue(many)

    // A caller that receives everything has paid the cost the catalogue avoids.
    expect(catalogue.match('shared')).toHaveLength(DEFAULT_MATCH_LIMIT)
    expect(new CapabilityCatalogue(many, { limit: 3 }).match('shared')).toHaveLength(3)
  })

  it('can hold a small always-available set outright', () => {
    const withPinned: readonly CapabilityEntry[] = [
      ...entries,
      { ...entry('read_file', 'Read a file', ['file']), alwaysAvailable: true },
    ]

    // Default: even an always-available entry is withheld until asked for.
    expect(new CapabilityCatalogue(withPinned).match('unrelated').length).toBe(0)
    // Opt in, and its schema is released without a match.
    const eager = new CapabilityCatalogue(withPinned, { loadAlwaysAvailable: true })
    expect(eager.match('unrelated').map(m => m.entry.name)).toContain('read_file')
  })

  it('ignores stop words, so a verbose query is not a match-everything query', () => {
    const catalogue = new CapabilityCatalogue(entries)
    // Every content word here is a stop word or too short, so nothing is
    // released: a query full of filler carries no evidence.
    expect(catalogue.match('I want to do this and then that')).toEqual([])
  })

  it('rejects a duplicate capability name instead of shadowing one', () => {
    expect(() => new CapabilityCatalogue([
      entry('a', 'first', []),
      entry('a', 'second', []),
    ])).toThrow(/duplicate capability name/)
  })

  it('rejects a nonsensical limit rather than returning nothing silently', () => {
    expect(() => new CapabilityCatalogue(entries, { limit: 0 })).toThrow(RangeError)
    expect(() => new CapabilityCatalogue(entries, { limit: 1.5 })).toThrow(RangeError)
  })

  it('is stable: the same query releases the same schemas in the same order', () => {
    const catalogue = new CapabilityCatalogue(entries)
    const first = catalogue.match('sql and browser')
    const second = catalogue.match('sql and browser')

    // Stability is what lets a caller record what it released and compare runs.
    expect(first.map(m => m.entry.name)).toEqual(second.map(m => m.entry.name))
    expect(first.map(m => m.score)).toEqual(second.map(m => m.score))
  })
})
