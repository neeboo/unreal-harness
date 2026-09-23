/**
 * Synthetic discovery trees, for measuring the replay mechanism itself.
 *
 * # Why this module exists
 *
 * The dreaming loop's claim is conditional: *given* a recorded tree in which
 * allocation choices matter, replay can rank strategies on it. Measuring that
 * needs trees where choices matter, and a single recorded run supplies exactly
 * one tree with one shape. Two problems follow, and this module answers both.
 *
 * 1. **A hand-written policy pool on one recorded tree is degenerate.** In a
 *    single recorded tree, every node has at most one child, so a policy that
 *    opens branches before deepening them and a policy that does the reverse
 *    reveal the same nodes in a different order and converge on the same best
 *    score. The pool then has one distinct outcome and selection is vacuous.
 *    That is a property of *one tree*, not of the mechanism.
 * 2. **One world cannot separate signal from luck.** Any claim of the form "the
 *    selected policy is at least as good as the incumbent" is a claim about a
 *    distribution. It needs many worlds, and it needs worlds the selection was
 *    not fitted on.
 *
 * So this module generates many recorded trees from an explicit model, and the
 * experiments run the real {@link ReplayWorld} over them. Nothing here is
 * mocked: the generator only produces the *input* to the mechanism. The
 * mechanism, the policies, and the scoring are the production ones.
 *
 * # The generative model, stated honestly
 *
 * A task is assumed to have `branchCount` independent directions, each with an
 * unknown quality drawn from a normal distribution. Refining a direction
 * improves it by a fixed increment plus noise, with diminishing returns, until
 * it saturates. Two consequences are deliberate:
 *
 * - **Quality is sticky within a branch**, so depth pays: continuing a good
 *   direction keeps returning something good.
 * - **Quality varies between branches**, so breadth pays: an unexplored
 *   direction may be better than the best one found so far.
 *
 * The tension between those two is exactly the depth-versus-breadth trade-off a
 * policy exists to resolve, which is what makes the ranking of policies
 * non-trivial. The parameters are a model of a search landscape, not a
 * measurement of any real task, so the results below say nothing about absolute
 * agent quality — only about whether the mechanism ranks strategies coherently.
 *
 * @module
 */

import { ReplayWorld, type RecordedNode } from './replay.ts'

/**
 * Deterministic PRNG (mulberry32).
 *
 * A seeded generator is not a convenience here: every number this module
 * produces has to be reproducible from a seed, or the experiment's result is an
 * anecdote about one run of `Math.random()`.
 */
export function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Shape and difficulty parameters for {@link syntheticWorld}. */
export interface SyntheticWorldOptions {
  /** Independent directions the task offers. */
  readonly branchCount?: number
  /** Maximum refinements recorded within one direction. */
  readonly refinementDepth?: number
  /**
   * Spread of branch quality.
   *
   * Small makes directions nearly interchangeable, so depth dominates; large
   * makes finding the good direction dominate. Both regimes are worth running.
   */
  readonly qualitySpread?: number
  /** Standard deviation of the per-attempt noise on top of a branch's quality. */
  readonly attemptNoise?: number
  /** Mean improvement from one successful refinement. */
  readonly refinementGain?: number
  /** Probability that a refinement stops improving (diminishing returns). */
  readonly saturationChance?: number
  /**
   * How strongly creation order leaks branch quality.
   *
   * `0` means the order a branch was opened carries no information about how
   * good it is, so a policy cannot do better than pick a direction at random.
   * `1` means branches were opened best-first, which makes "open branches in
   * creation order" a strong heuristic. Real runs sit somewhere between, which
   * is why this is a knob rather than an assumption: a policy that only wins
   * when order is informative has not been shown to be a better policy.
   */
  readonly orderInformativeness?: number
  /** Random seed for this world. */
  readonly seed: number
  /** Id prefix, so nodes from different worlds never collide in a log. */
  readonly prefix?: string
}

/** The generated tree plus the latent parameters that produced it. */
export interface SyntheticWorld {
  readonly world: ReplayWorld
  readonly nodes: readonly RecordedNode[]
  /** True quality of each branch, by branch index — the generator's own truth. */
  readonly branchQuality: readonly number[]
  /** The best score actually present anywhere in the recorded tree. */
  readonly bestRecordedScore: number
}

/**
 * Generate one recorded discovery tree.
 *
 * @param options - shape and difficulty of the world.
 * @returns a {@link ReplayWorld} plus the latent branch qualities.
 */
export function syntheticWorld(options: SyntheticWorldOptions): SyntheticWorld {
  const branchCount = options.branchCount ?? 8
  const depth = options.refinementDepth ?? 8
  const spread = options.qualitySpread ?? 1
  const noise = options.attemptNoise ?? 0.25
  const gain = options.refinementGain ?? 0.9
  const saturation = options.saturationChance ?? 0.25
  const orderInfo = options.orderInformativeness ?? 0.5
  const prefix = options.prefix ?? 'n'
  const random = makeRandom(options.seed)

  // Box–Muller, so qualities are genuinely normal rather than uniform.
  const normal = (): number => {
    const u = Math.max(random(), Number.EPSILON)
    const v = random()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }

  const quality = Array.from({ length: branchCount }, () => normal() * spread)

  // Creation order leaks quality in proportion to `orderInformativeness`: the
  // order is a blend of a quality-sorted order and a random one.
  const byQuality = quality
    .map((value, index) => ({ value, index }))
    .sort((a, b) => b.value - a.value)
    .map(entry => entry.index)
  const shuffled = [...byQuality]
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    const a = shuffled[i]
    const b = shuffled[j]
    if (a === undefined || b === undefined) continue
    shuffled[i] = b
    shuffled[j] = a
  }
  const openOrder = byQuality.map((qualityIndex, rank) =>
    random() < orderInfo ? qualityIndex : (shuffled[rank] ?? qualityIndex),
  )

  const nodes: RecordedNode[] = []
  const rootIds: string[] = []
  let bestRecordedScore = Number.NEGATIVE_INFINITY

  openOrder.forEach((qualityIndex, displayBranch) => {
    const base = quality[qualityIndex] ?? 0
    // Each branch is a chain: head, then one child per refinement. A node with
    // two recorded children is not replayable (the world rejects it), because a
    // branched node has no single deterministic successor.
    const length = 1 + Math.floor(random() * depth)
    let parent: string | undefined
    for (let attempt = 0; attempt < length; attempt += 1) {
      const nodeId = `${prefix}-b${displayBranch}-a${attempt}`
      const improvement = attempt * gain * (random() < saturation ? 0.25 : 1)
      const score = base + improvement + normal() * noise
      nodes.push({
        nodeId,
        ...parent === undefined ? {} : { parent },
        branch: displayBranch,
        attempt,
        // Branch heads must be ordered by creation among themselves, so the
        // implicit root opens them in the intended sequence. Within a branch
        // the ordering is never consulted, because every node there has exactly
        // one child.
        siblingOrder: attempt === 0 ? displayBranch : attempt,
        turns: 1 + Math.floor(random() * 3),
        status: 'scored',
        score,
      })
      if (attempt === 0) rootIds.push(nodeId)
      bestRecordedScore = Math.max(bestRecordedScore, score)
      parent = nodeId
    }
  })

  return {
    world: new ReplayWorld(nodes),
    nodes,
    branchQuality: quality,
    bestRecordedScore,
  }
}

/** A collection of worlds plus their latent truths, for an experiment. */
export interface SyntheticCorpus {
  readonly worlds: readonly ReplayWorld[]
  readonly bestRecordedScores: readonly number[]
  /** The seed each world was generated from, so a result can be regenerated. */
  readonly seeds: readonly number[]
}

/**
 * Generate a corpus of worlds.
 *
 * @param count - how many worlds.
 * @param baseSeed - first seed; world `i` uses `baseSeed + i`.
 * @param options - shared shape parameters.
 */
export function syntheticCorpus(
  count: number,
  baseSeed: number,
  options: Omit<SyntheticWorldOptions, 'seed'> = {},
): SyntheticCorpus {
  const worlds: ReplayWorld[] = []
  const bestRecordedScores: number[] = []
  const seeds: number[] = []
  for (let i = 0; i < count; i += 1) {
    const seed = baseSeed + i
    const generated = syntheticWorld({ ...options, seed, prefix: `w${i}` })
    worlds.push(generated.world)
    bestRecordedScores.push(generated.bestRecordedScore)
    seeds.push(seed)
  }
  return { worlds, bestRecordedScores, seeds }
}
