/**
 * CLI for the proposal experiment.
 *
 * ```sh
 * DEEPSEEK_API_KEY=... pnpm --filter @neeboo/unreal-harness-bench propose-experiment \
 *   --out harbor/tools/propose-summary.json --revisions 4
 * ```
 *
 * @module
 */

import { writeFile } from 'node:fs/promises'
import { runProposeExperiment } from './propose-experiment.ts'

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

const apiKey = process.env['DEEPSEEK_API_KEY']
if (apiKey === undefined || apiKey.trim() === '') {
  process.stderr.write('DEEPSEEK_API_KEY is required for the proposal experiment\n')
  process.exit(2)
}

const revisions = Number(argValue('--revisions') ?? 4)
const out = argValue('--out')
const effort = (argValue('--effort') ?? 'low') as 'low' | 'high' | 'max'

const result = await runProposeExperiment({
  apiKey,
  revisions,
  effort,
  onProgress: message => process.stderr.write(`${message}\n`),
})

const serialised = `${JSON.stringify(result, null, 2)}\n`
if (out !== undefined) {
  await writeFile(out, serialised, 'utf8')
  process.stderr.write(`wrote ${out}\n`)
}

process.stdout.write(serialised)
