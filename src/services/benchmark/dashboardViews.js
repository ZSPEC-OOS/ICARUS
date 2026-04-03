function toPercent(value = 0) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`
}

export function buildBenchmarkDashboardView(report, baseline = null) {
  if (!report) {
    return {
      kpis: [],
      regressions: [],
      taskRows: [],
      summaryText: 'No benchmark report available yet.',
    }
  }

  const deltas = {
    correctnessRate: baseline ? Number((report.correctnessRate - baseline.correctnessRate).toFixed(3)) : null,
    testPassRate: baseline ? Number((report.testPassRate - baseline.testPassRate).toFixed(3)) : null,
    timeToGreenMs: baseline ? report.timeToGreenMs - baseline.timeToGreenMs : null,
    costPerTask: baseline ? Number((report.costPerTask - baseline.costPerTask).toFixed(6)) : null,
  }

  return {
    kpis: [
      { label: 'Correctness', value: toPercent(report.correctnessRate), delta: deltas.correctnessRate },
      { label: 'AST Edit Distance', value: report.astEditDistance.toFixed(3), delta: null },
      { label: 'Test Pass Rate', value: toPercent(report.testPassRate), delta: deltas.testPassRate },
      { label: 'Time to Green', value: `${report.timeToGreenMs} ms`, delta: deltas.timeToGreenMs },
      { label: 'Cost / Task', value: `$${report.costPerTask.toFixed(4)}`, delta: deltas.costPerTask },
    ],
    regressions: report.regressions || [],
    taskRows: (report.tasks || []).map(task => ({
      task: task.name,
      correctness: task.correctness ? 'pass' : 'fail',
      astEditDistance: task.astEditDistance,
      testPassRate: task.testPassRate,
      elapsedMs: task.elapsedMs,
      cost: task.cost,
    })),
    summaryText: report.regressions?.length
      ? `${report.regressions.length} regressions detected against baseline ${report.baselineVersion || 'n/a'}.`
      : 'No regressions detected in nightly benchmark suite.',
  }
}
