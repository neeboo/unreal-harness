/**
 * The capability catalogue: make many tools available without paying for all of
 * them in every request.
 *
 * A tool schema sits in the system prompt for every step, whether or not the
 * step could use it. Declare two hundred tools and the model pays for two
 * hundred schemas on every call — which is how a capable harness ends up slower
 * and more expensive than a limited one.
 *
 * dsh already answers this: a `ToolSchema` may carry `deferLoading`, which keeps
 * the tool out of the assembled schema set until something asks for it. This
 * module is the other half — the *catalogue* that decides what a deferred tool
 * is for, so the model can discover that an ability exists without holding its
 * full contract.
 *
 * # Why the entries are prose, not schemas
 *
 * An entry is a short description of what a capability can do, plus the keywords
 * a query is matched against. The full schema stays in the catalogue until the
 * capability is selected. That split is the whole point: a model that cannot
 * recall that an ability exists will never ask for it, and a model that holds
 * every full schema has already paid the cost the catalogue was meant to avoid.
 * @module
 */

/**
 * One capability's discoverable summary.
 *
 * Deliberately not a schema: this is what the model may see cheaply, and keeping
 * it to prose is what makes holding hundreds of entries affordable.
 */
export interface CapabilityEntry {
  /** Stable identity, also the tool name it defers. */
  readonly name: string
  /** One sentence on what it does, shown when the catalogue is consulted. */
  readonly summary: string
  /**
   * Words a query is matched against.
   *
   * Free-form on purpose. A caller tunes recall by adding terms, which is a
   * decision it can reason about, unlike an embedding threshold.
   */
  readonly keywords: readonly string[]
  /**
   * The full schema, handed over only when this capability is loaded.
   *
   * Typed as `unknown` because this module never inspects it: it exists to be
   * withheld and then released, and depending on its shape would couple the
   * catalogue to every tool implementation.
   */
  readonly schema: unknown
  /** Whether the capability is always available, ignoring the query. */
  readonly alwaysAvailable?: boolean
}

/** One match, with the score that produced it. */
export interface CapabilityMatch {
  readonly entry: CapabilityEntry
  readonly score: number
  /** Which query terms matched, so a miss can be explained. */
  readonly matchedTerms: readonly string[]
}

/** How the catalogue is consulted. */
export interface CatalogueOptions {
  /**
   * Maximum matches returned for one query.
   *
   * A bound rather than a threshold, because a caller that gets everything has
   * paid the cost the catalogue exists to avoid.
   */
  readonly limit?: number
  /**
   * Whether an always-available entry's schema is released without a match.
   *
   * `false` for a pure catalogue: it lists everything and loads nothing until
   * asked. `true` for a set small enough to hold outright.
   */
  readonly loadAlwaysAvailable?: boolean
}

/** Default match bound. */
export const DEFAULT_MATCH_LIMIT = 8

/**
 * A searchable set of capabilities whose schemas are withheld until needed.
 */
export class CapabilityCatalogue {
  private readonly entries: ReadonlyMap<string, CapabilityEntry>
  private readonly limit: number
  private readonly loadAlwaysAvailable: boolean

  constructor(
    entries: readonly CapabilityEntry[],
    options: CatalogueOptions = {},
  ) {
    const byName = new Map<string, CapabilityEntry>()
    for (const entry of entries) {
      if (byName.has(entry.name)) {
        throw new Error(`duplicate capability name: ${entry.name}`)
      }
      byName.set(entry.name, entry)
    }
    this.entries = byName
    this.limit = options.limit ?? DEFAULT_MATCH_LIMIT
    if (!Number.isInteger(this.limit) || this.limit < 1) {
      throw new RangeError(`limit must be a positive integer, received ${this.limit}`)
    }
    this.loadAlwaysAvailable = options.loadAlwaysAvailable ?? false
  }

  /** How many capabilities the catalogue knows about. */
  get size(): number {
    return this.entries.size
  }

  /** Every entry, in insertion order. */
  all(): readonly CapabilityEntry[] {
    return [...this.entries.values()]
  }

  /**
   * The brief listing a model may hold cheaply.
   *
   * Names and summaries only. This is what makes "there are four hundred tools"
   * affordable: the model learns that abilities exist without receiving any of
   * their contracts.
   * @returns one line per capability.
   */
  listing(): readonly { readonly name: string; readonly summary: string }[] {
    return this.all().map(entry => ({ name: entry.name, summary: entry.summary }))
  }

  /**
   * Capabilities whose schemas should be released for this query.
   *
   * Matches on the query terms against each entry's keywords and summary, ranks
   * by how many distinct terms hit, and returns at most {@link CatalogueOptions.limit}
   * of them. An entry with no match stays withheld — which is the case that
   * matters, because releasing everything turns the catalogue back into the
   * problem it solves.
   * @param query - what the model is trying to do, in its own words.
   * @returns matching entries, best first.
   */
  match(query: string): readonly CapabilityMatch[] {
    const terms = tokenise(query)
    const matches: CapabilityMatch[] = []

    for (const entry of this.entries.values()) {
      if (this.loadAlwaysAvailable && entry.alwaysAvailable === true) {
        matches.push({ entry, score: Number.POSITIVE_INFINITY, matchedTerms: [] })
        continue
      }
      const matched = matchedTerms(entry, terms)
      if (matched.length === 0) continue
      matches.push({ entry, score: matched.length, matchedTerms: matched })
    }

    // Ties break by name so a query's answer is stable across runs, which is
    // what lets a caller record and compare what it released.
    matches.sort((left, right) =>
      right.score - left.score || left.entry.name.localeCompare(right.entry.name))
    return matches.slice(0, this.limit)
  }

  /**
   * Release the schemas for a query, ready to hand to the harness.
   * @param query - what the model is trying to do.
   * @returns the selected entries' schemas, best match first.
   */
  schemasFor(query: string): readonly unknown[] {
    return this.match(query).map(match => match.entry.schema)
  }

  /**
   * Whether a query would release anything.
   *
   * Exposed so a caller can tell "the catalogue had nothing relevant" from "the
   * catalogue was never consulted" — different problems with different fixes.
   * @param query - what the model is trying to do.
   * @returns whether at least one capability matched.
   */
  hasMatch(query: string): boolean {
    return this.match(query).length > 0
  }
}

/** Split a query into lowercase terms, dropping punctuation and stop words. */
function tokenise(query: string): readonly string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .filter(term => term.length > 1 && !STOP_WORDS.has(term))
}

/**
 * Terms carrying no discriminating power.
 *
 * Kept tiny. Every entry here is a word that would otherwise match half the
 * catalogue, which is exactly what makes a match score meaningless.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'then',
  'a', 'an', 'of', 'to', 'in', 'on', 'is', 'it', 'as', 'at', 'by', 'or',
  'i', 'we', 'you', 'me', 'my', 'our',
  'do', 'does', 'can', 'could', 'should', 'would', 'will',
  'need', 'want', 'use', 'using', 'get', 'got',
])

/** Which query terms an entry matches, deduplicated and in query order. */
function matchedTerms(entry: CapabilityEntry, terms: readonly string[]): readonly string[] {
  const haystack = `${entry.name} ${entry.summary} ${entry.keywords.join(' ')}`.toLowerCase()
  const matched: string[] = []
  for (const term of terms) {
    if (matched.includes(term)) continue
    // Substring on purpose: a caller writing "kubernetes" should reach an entry
    // whose keyword is "k8s" only if it said so, but a caller writing "k8s"
    // should reach one whose summary says "k8s cluster".
    if (haystack.includes(term)) matched.push(term)
  }
  return matched
}
