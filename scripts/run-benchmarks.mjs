#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { runNightlyBenchmarkSuite } from '../src/services/benchmark/nightlyBenchmarkSuite.js'
import { buildBenchmarkDashboardView } from '../src/services/benchmark/dashboardViews.js'

function argValue(flag, fallback = null) {
  const idx = process.argv.indexOf(flag)
  if (idx === -1 || idx + 1 >= process.argv.length) return fallback
  return process.argv[idx + 1]
}

async function readJsonIfExists(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function renderMarkdown(report, view) {
  const rows = view.taskRows
    .map(row => `| ${row.task} | ${row.correctness} | ${row.astEditDistance.toFixed(3)} | ${Math.round(row.testPassRate * 100)}% | ${row.elapsedMs} | $${row.cost.toFixed(5)} |`)
    .join('\n')

  return [
    '# Nightly Benchmark Report',
    '',
    `- Suite Version: **${report.suiteVersion}**`,
    `- Baseline: **${report.baselineVersion || 'none'}**`,
    `- Correctness: **${(report.correctnessRate * 100).toFixed(1)}%**`,
    `- AST-aware edit distance: **${report.astEditDistance.toFixed(3)}**`,
    `- Test pass rate: **${(report.testPassRate * 100).toFixed(1)}%**`,
    `- Time-to-green: **${report.timeToGreenMs} ms**`,
    `- Cost/task: **$${report.costPerTask.toFixed(6)}**`,
    '',
    `## Regression Gate\n${view.summaryText}`,
    '',
    '| Task | Correctness | AST Distance | Test Pass | Time (ms) | Cost |',
    '| --- | --- | --- | --- | --- | --- |',
    rows,
    '',
  ].join('\n')
}

async function main() {
  const outDir = argValue('--out-dir', '.icarus/benchmarks')
  const suiteVersion = argValue('--suite-version', `nightly-${new Date().toISOString().slice(0, 10)}`)
  const baselinePath = argValue('--baseline', path.join(outDir, 'baseline.json'))

  await mkdir(outDir, { recursive: true })

  const baseline = await readJsonIfExists(baselinePath)
  const report = await runNightlyBenchmarkSuite({ suiteVersion, baselineReport: baseline })
  const dashboard = buildBenchmarkDashboardView(report, baseline)

  const reportPath = path.join(outDir, `${suiteVersion}.json`)
  const latestPath = path.join(outDir, 'latest.json')
  const markdownPath = path.join(outDir, `${suiteVersion}.md`)

  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
  await writeFile(latestPath, JSON.stringify(report, null, 2), 'utf8')
  await writeFile(markdownPath, renderMarkdown(report, dashboard), 'utf8')

  if (!baseline) await writeFile(baselinePath, JSON.stringify(report, null, 2), 'utf8')

  process.stdout.write(`${JSON.stringify({ reportPath, latestPath, markdownPath, regressions: report.regressions }, null, 2)}\n`)
  if (report.regressions.length > 0) process.exitCode = 2
}

main().catch((err) => {
  process.stderr.write(`Benchmark run failed: ${err.message}\n`)
  process.exit(1)
})
