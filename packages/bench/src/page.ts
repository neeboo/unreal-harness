/**
 * Render the report page: one self-contained HTML document a reader can open
 * directly.
 *
 * Everything it shows is read from `measurements.json`, which a run wrote. Nothing
 * is typed by hand, so the page cannot disagree with the run that produced it — and
 * the run's own honesty markers (`equalAttempts`, whether the candidate pool
 * discriminated) are rendered as prominently as the headline numbers, because a page
 * that shows only the flattering row is an advertisement.
 * @module
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

interface Measurements {
  readonly startedAt: string
  readonly model: string
  readonly effort: string
  readonly budget: {
    readonly rounds: number
    readonly branchCount: number
    readonly refineCount: number
    readonly attemptsPerRound: number
    readonly maxParallelism: number
  }
  readonly heldOutInstances: readonly string[]
  readonly arms: readonly {
    readonly armId: string
    readonly bestSpeedup?: number
    readonly agentCalls: number
    readonly providerCalls: number
    readonly promptTokens: number
    readonly completionTokens: number
    readonly cachedPromptTokens: number
    readonly wallMs: number
    readonly deployed: readonly string[]
    readonly curve: readonly (number | undefined)[]
    readonly improvements: number
  }[]
  readonly equalAttempts: boolean
  readonly dreamSelections: readonly {
    readonly round: number
    readonly selected: string
    readonly scores: readonly { readonly policyId: string; readonly meanScore: number | undefined }[]
  }[]
}

/**
 * Render one measurements file as a self-contained HTML page.
 * @param inputPath - path to `measurements.json`.
 * @param outputPath - where to write the HTML.
 * @returns the output path.
 */
export async function renderPage(inputPath: string, outputPath: string): Promise<string> {
  const raw = await readFile(inputPath, 'utf8')
  const data = JSON.parse(raw) as Measurements
  await writeFile(outputPath, buildHtml(data), 'utf8')
  return outputPath
}

function buildHtml(data: Measurements): string {
  const [baseline, treatment] = data.arms
  if (baseline === undefined || treatment === undefined) {
    throw new Error('the page needs both arms')
  }

  const deltaSpeedup = (treatment.bestSpeedup ?? 0) - (baseline.bestSpeedup ?? 0)
  const deltaTokens =
    (treatment.promptTokens + treatment.completionTokens) -
    (baseline.promptTokens + baseline.completionTokens)

  // Whether the dreaming ever had a choice. If no round's candidates scored
  // differently, the page must say the pool was degenerate rather than let a reader
  // read "no difference" as a finding about the loop.
  const distinguishing = data.dreamSelections
    .map(selection => new Set(
      selection.scores
        .map(entry => entry.meanScore)
        .filter((score): score is number => score !== undefined)
        .map(score => score.toFixed(6)),
    ).size)
  const poolDiscriminated = distinguishing.some(count => count >= 2)

  const rows: string[] = []
  for (const arm of data.arms) {
    rows.push(`<tr>
      <td><code>${escapeHtml(arm.armId)}</code></td>
      <td class="num">${fmtX(arm.bestSpeedup)}</td>
      <td class="num">${arm.agentCalls}</td>
      <td class="num">${arm.providerCalls}</td>
      <td class="num">${n(arm.promptTokens)}</td>
      <td class="num">${n(arm.completionTokens)}</td>
      <td class="num">${n(arm.cachedPromptTokens)}</td>
      <td class="num">${(arm.wallMs / 1000).toFixed(1)}s</td>
      <td class="num">${arm.improvements}</td>
    </tr>`)
  }

  const curveRows: string[] = []
  for (let index = 0; index < data.budget.rounds; index += 1) {
    const selection = data.dreamSelections.find(entry => entry.round === index + 1)
    curveRows.push(`<tr>
      <td class="num">${index + 1}</td>
      <td class="num">${fmtX(baseline.curve[index])}</td>
      <td class="num">${fmtX(treatment.curve[index])}</td>
      <td><code>${escapeHtml(selection?.selected ?? '—')}</code></td>
      <td class="num">${selection === undefined ? '—' : String(new Set(selection.scores.map(e => e.meanScore ?? 'na')).size)}</td>
    </tr>`)
  }

  const policyIds = [...new Set(data.dreamSelections.flatMap(s => s.scores.map(e => e.policyId)))].sort()
  const scoreRows: string[] = []
  for (const selection of data.dreamSelections) {
    const byPolicy = new Map(selection.scores.map(entry => [entry.policyId, entry.meanScore]))
    scoreRows.push(`<tr>
      <td class="num">${selection.round}</td>
      <td><code>${escapeHtml(selection.selected)}</code></td>
      ${policyIds.map(id => {
        const score = byPolicy.get(id)
        return `<td class="num">${score === undefined ? '<span class="muted">—</span>' : score.toFixed(4)}</td>`
      }).join('')}
    </tr>`)
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RSI-Harness benchmark — fixed exploration vs Dream-RSI</title>
<style>
  :root {
    --bg: #0e1116; --panel: #161b22; --line: #262d36; --ink: #e6edf3;
    --muted: #8b949e; --accent: #58a6ff; --good: #3fb950; --warn: #d29922; --bad: #f85149;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg: #ffffff; --panel: #f6f8fa; --line: #d0d7de; --ink: #1f2328; --muted: #656d76; --accent: #0969da; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  }
  main { max-width: 1080px; margin: 0 auto; padding: 48px 24px 96px; }
  h1 { font-size: 30px; line-height: 1.25; margin: 0 0 8px; letter-spacing: -0.01em; }
  h2 { font-size: 19px; margin: 44px 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
  h3 { font-size: 15px; margin: 24px 0 8px; }
  p, li { color: var(--ink); }
  .lede { color: var(--muted); margin: 0 0 28px; }
  .meta { display: flex; flex-wrap: wrap; gap: 8px 20px; color: var(--muted); font-size: 13px; margin-bottom: 24px; }
  .meta code { color: var(--ink); }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 14px; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  code { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--panel); padding: 1px 5px; border-radius: 4px; }
  .muted { color: var(--muted); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin: 16px 0 8px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; }
  .card .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
  .card .value { font-size: 24px; font-variant-numeric: tabular-nums; margin-top: 4px; }
  .card .sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .callout { border-left: 3px solid var(--accent); background: var(--panel); padding: 12px 16px; margin: 16px 0; border-radius: 0 6px 6px 0; }
  .callout.good { border-left-color: var(--good); }
  .callout.warn { border-left-color: var(--warn); }
  .callout.bad { border-left-color: var(--bad); }
  .callout strong { display: block; margin-bottom: 4px; }
  ul { padding-left: 20px; }
  footer { margin-top: 56px; padding-top: 20px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; }
</style>
</head>
<body>
<main>
  <h1>Does the Dream-RSI loop work here?</h1>
  <p class="lede">A two-arm, equal-attempt-budget A/B on a real code-optimization task. The model, the task, the seed code, and the evaluator are identical in both arms; the only difference is which recorded attempt each new attempt continues from.</p>
  <div class="meta">
    <span>run <code>${escapeHtml(data.startedAt)}</code></span>
    <span>model <code>${escapeHtml(data.model)}</code> · effort <code>${escapeHtml(data.effort)}</code></span>
    <span>budget ${data.budget.rounds} rounds × ${data.budget.attemptsPerRound} attempts</span>
    <span>parallelism ${data.budget.maxParallelism}</span>
    <span>held-out instances ${data.heldOutInstances.length}</span>
  </div>

  <div class="cards">
    <div class="card">
      <div class="label">Fixed exploration</div>
      <div class="value">${fmtX(baseline.bestSpeedup)}</div>
      <div class="sub">best held-out speedup</div>
    </div>
    <div class="card">
      <div class="label">Dream-RSI</div>
      <div class="value">${fmtX(treatment.bestSpeedup)}</div>
      <div class="sub">${deltaSpeedup >= 0 ? '+' : ''}${deltaSpeedup.toFixed(3)}× vs fixed</div>
    </div>
    <div class="card">
      <div class="label">Attempts</div>
      <div class="value">${baseline.agentCalls} / ${treatment.agentCalls}</div>
      <div class="sub">${data.equalAttempts ? 'equal — premise held' : 'UNEQUAL — comparison invalid'}</div>
    </div>
    <div class="card">
      <div class="label">Tokens</div>
      <div class="value">${deltaTokens >= 0 ? '+' : ''}${n(Math.abs(deltaTokens))}</div>
      <div class="sub">${deltaTokens >= 0 ? 'more' : 'fewer'} than fixed</div>
    </div>
  </div>

  ${data.equalAttempts
    ? `<div class="callout good"><strong>Premise held</strong>Both arms executed the same number of attempts, so the speedup comparison is like-for-like. Any difference is the exploration policy, not the work.</div>`
    : `<div class="callout bad"><strong>Premise broken</strong>The arms executed different attempt counts. The speedup comparison is <em>not</em> like-for-like and the quality row should be treated as invalid.</div>`}

  ${poolDiscriminated
    ? `<div class="callout"><strong>The candidate pool discriminated</strong>At least two candidate policies scored differently on the recorded history, so the dreaming had a real choice to make.</div>`
    : `<div class="callout warn"><strong>The candidate pool was degenerate</strong>Every candidate policy scored identically on the recorded history. The dreaming had nothing to choose between, so this run measures the benchmark's design rather than the loop. A "no difference" result here is <em>not</em> evidence about Dream-RSI.</div>`}

  <h2>Headline</h2>
  <table>
    <thead><tr>
      <th>arm</th><th class="num">best speedup</th><th class="num">attempts</th><th class="num">provider calls</th>
      <th class="num">input tokens</th><th class="num">output tokens</th><th class="num">cached input</th>
      <th class="num">wall</th><th class="num">improvements</th>
    </tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table>
  <p class="muted">Quality is median held-out runtime, measured out of process on inputs the agent never saw. Correctness is a gate: a wrong answer has no runtime and counts as a failure. "Improvements" counts attempts that produced correct, faster code.</p>

  <h2>Discovery curve</h2>
  <p>Best held-out speedup after each round. Round 1 is identical by design — the dream arm starts from the same incumbent policy — so any divergence after round 1 is the dreaming.</p>
  <table>
    <thead><tr><th class="num">round</th><th class="num">fixed</th><th class="num">dream</th><th>deployed by dream</th><th class="num">distinct scores</th></tr></thead>
    <tbody>${curveRows.join('')}</tbody>
  </table>

  <h2>What the dreaming chose</h2>
  <p>Each row is the offline replay evaluation that decided the next round's policy. Scores are the replay objective over the recorded trees: best realized speedup, minus a cost term for attempts, plus a parallelism bonus for reaching it in fewer decision rounds. Dreaming issues <strong>no model calls</strong> — it only reads recorded attempts.</p>
  <table>
    <thead><tr><th class="num">round</th><th>deployed</th>${policyIds.map(id => `<th class="num"><code>${escapeHtml(id)}</code></th>`).join('')}</tr></thead>
    <tbody>${scoreRows.join('')}</tbody>
  </table>

  <h2>What this does not measure</h2>
  <ul>
    <li><strong>Not a public benchmark.</strong> This is not Terminal-Bench 4.0, DeepSWE 1.1, SWE-Atlas QnA, or ALE-CLI. Those need Harbor plus a container runtime; the design and the exact commands are in <code>BENCHMARK.md</code>.</li>
    <li><strong>Not "better than a bare harness".</strong> That comparison is <code>dsh</code> versus <code>dsh</code> plus these plugins on a public dataset. It is designed and not yet run.</li>
    <li><strong>Not the paper's full loop.</strong> The candidate pool here is hand-written strategies, so replay-based <em>selection</em> is exercised and an LLM <em>proposing new policy code</em> is not. That is the one step standing between this and the paper's claim.</li>
    <li><strong>No absolute number means anything alone.</strong> These are properties of a rolling-maximum task with a <code>node</code> evaluator. Only the comparison between arms is informative, and only because they are otherwise identical.</li>
  </ul>

  <footer>
    Generated by <code>packages/bench</code> from <code>measurements.json</code>. Every figure on this page is read from that file; none is typed by hand.
  </footer>
</main>
</body>
</html>
`
}

function fmtX(value: number | undefined): string {
  return value === undefined ? '<span class="muted">—</span>' : `${value.toFixed(3)}×`
}

function n(value: number): string {
  return value.toLocaleString('en-US')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** CLI: `node lib/page.js <measurements.json> <out.html>` */
if (process.argv[1]?.endsWith('page.js') === true) {
  const [input, output] = process.argv.slice(2)
  if (input === undefined || output === undefined) {
    process.stderr.write('usage: node lib/page.js <measurements.json> <out.html>\n')
    process.exit(2)
  }
  const written = await renderPage(join(process.cwd(), input), join(process.cwd(), output))
  process.stdout.write(`${written}\n`)
}
