/**
 * The benchmark CLI entry point.
 *
 * Reads the key from the environment, runs the A/B, and prints the report path. All
 * numbers come from `runBenchmark`; this file only parses arguments and decides
 * where to write.
 * @module
 */
import { runBenchmark } from './run.ts'

const args = new Map<string, string>()
for (const raw of process.argv.slice(2)) {
  const [key, ...rest] = raw.replace(/^--/, '').split('=')
  if (key !== undefined && key !== '') args.set(key, rest.join('='))
}

const apiKey = process.env.DEEPSEEK_API_KEY
if (apiKey === undefined || apiKey.trim() === '') {
  process.stderr.write('DEEPSEEK_API_KEY is required (source ~/.zshrc, or pass the env var)\n')
  process.exit(2)
}

const rounds = Number(args.get('rounds') ?? 3)
const branchCount = Number(args.get('branches') ?? 4)
const refineCount = Number(args.get('refines') ?? 1)
const maxParallelism = Number(args.get('parallelism') ?? 4)
const effort = (args.get('effort') ?? 'low') as 'low' | 'high' | 'max'
const model = args.get('model') ?? 'deepseek-flash'
const outDir = args.get('out') ?? `bench-out/${new Date().toISOString().replace(/[:.]/g, '-')}`

await runBenchmark({
  apiKey,
  rounds,
  branchCount,
  refineCount,
  maxParallelism,
  effort,
  model,
  outDir,
  onProgress: message => process.stderr.write(`${message}\n`),
})

process.stdout.write(`${outDir}\n`)
