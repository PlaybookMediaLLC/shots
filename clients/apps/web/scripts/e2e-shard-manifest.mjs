#!/usr/bin/env node
// Turns the Playwright JSON reports a full run uploads into the committed
// shard manifest (test/e2e/durations.json) that dev/e2e-plan.mjs packs shards
// with. Without it, shards are balanced by file count and the slowest shard
// decides the run's wall clock.
//
// Usage: node scripts/e2e-shard-manifest.mjs <report.json...> [--out <file>]
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * A shard's cost is the sum of its specs, so a spec's cost is its own sum.
 *
 * @param {{suites?: unknown[]}[]} reports Parsed Playwright JSON reports.
 * @returns {Record<string, number>}
 */
export function totalsByFile(reports) {
  /** @type {Map<string, number>} */
  const totals = new Map()
  /** @param {any} suite */
  const visit = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const entry of spec.tests ?? []) {
        if ((entry.status ?? '') === 'skipped') continue
        // Retries are real shard time: a flaky spec costs what it costs.
        const ms = (entry.results ?? []).reduce((sum, result) => sum + (result.duration ?? 0), 0)
        totals.set(spec.file, (totals.get(spec.file) ?? 0) + ms)
      }
    }
    for (const child of suite.suites ?? []) visit(child)
  }
  for (const report of reports) for (const suite of report.suites ?? []) visit(suite)
  return Object.fromEntries([...totals].sort(([a], [b]) => a.localeCompare(b)))
}

/**
 * Smooths each spec toward its newest measurement so one slow night cannot
 * pin a shard, and drops specs the suite no longer has. A spec measured for
 * the first time takes its measurement as-is.
 *
 * @param {{generated?: string, specs?: Record<string, number>} | null} previous
 * @param {Record<string, number>} observed
 * @param {{weight?: number}} [options]
 * @returns {{generated: string, specs: Record<string, number>}}
 */
export function mergeManifest(previous, observed, { weight = 0.4 } = {}) {
  /** @type {Record<string, number>} */
  const specs = {}
  for (const [file, ms] of Object.entries(observed)) {
    const before = previous?.specs?.[file]
    specs[file] = typeof before === 'number' && before > 0
      ? Math.round(before * (1 - weight) + ms * weight)
      : Math.round(ms)
  }
  return { generated: new Date().toISOString(), specs }
}

function main() {
  const args = process.argv.slice(2)
  const outIndex = args.indexOf('--out')
  const out = outIndex === -1 ? 'test/e2e/durations.json' : args[outIndex + 1]
  const files = (outIndex === -1 ? args : [...args.slice(0, outIndex), ...args.slice(outIndex + 2)])
    .filter((file) => existsSync(file))
  if (files.length === 0) {
    console.error('No Playwright JSON report was given; the manifest is unchanged.')
    process.exit(1)
  }
  const observed = totalsByFile(files.map((file) => JSON.parse(readFileSync(file, 'utf8'))))
  if (Object.keys(observed).length === 0) {
    console.error('The reports contain no executed specs; the manifest is unchanged.')
    process.exit(1)
  }
  const previous = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null
  const merged = mergeManifest(previous, observed)
  writeFileSync(out, `${JSON.stringify(merged, null, 2)}\n`)
  const total = Object.values(merged.specs).reduce((sum, ms) => sum + ms, 0)
  console.error(`Wrote ${Object.keys(merged.specs).length} specs to ${out} (${(total / 1000).toFixed(0)} s of tests).`)
}

if (process.argv[1]?.endsWith('e2e-shard-manifest.mjs')) main()
