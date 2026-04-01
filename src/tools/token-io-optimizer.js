// ─── token-io-optimizer tool ────────────────────────────────────────────────
export const toolMeta = {
  id: 'token-io-optimizer',
  name: 'Token I/O Optimizer',
  version: '1.0.0',
  description: 'Generate a token-optimization plan for long requests while preserving implementation quality.',
  category: 'analysis',
  author: 'ICARUS',
}

function buildPlan(task, expectedOutputSize = 'medium', mode = 'adaptive') {
  const normalizedSize = ['small', 'medium', 'large', 'huge'].includes(expectedOutputSize)
    ? expectedOutputSize
    : 'medium'
  const normalizedMode = ['off', 'adaptive', 'aggressive'].includes(mode)
    ? mode
    : 'adaptive'

  const recommendations = [
    'Keep full implementation quality: never omit required code, tests, or error handling.',
    'Batch reads using read_many_files and use grep before opening many files.',
    'Avoid redundant tool calls by caching prior read/search results within the session.',
    'Use edit_file for surgical patches; reserve write_file for full rewrites/new files.',
    'Defer verbose prose until final answer; keep intermediate tool outputs concise.',
  ]

  if (normalizedSize === 'large' || normalizedSize === 'huge') {
    recommendations.push('Split work into milestones and only load context relevant to the current milestone.')
  }

  if (normalizedMode === 'off') {
    recommendations.unshift('Optimization mode OFF: prioritize maximal context and verbosity.')
  } else if (normalizedMode === 'aggressive') {
    recommendations.push('Aggressive mode: cap repeated file reads and summarize unchanged sections after first inspection.')
    recommendations.push('Aggressive mode: prefer short tool arguments and avoid re-sending unchanged large strings.')
  } else {
    recommendations.push('Adaptive mode: optimize only when requests are long or repetitive.')
  }

  return {
    tool: 'token_io_optimizer',
    mode: normalizedMode,
    expectedOutputSize: normalizedSize,
    qualityGuardrail: 'Do not sacrifice correctness, completeness, or code quality for token savings.',
    taskSummary: String(task || '').trim().slice(0, 400),
    recommendations,
  }
}

export async function execute(input = {}) {
  if (typeof input.task !== 'string' || !input.task.trim()) {
    throw new Error('task is required')
  }
  return buildPlan(input.task, input.expected_output_size, input.mode)
}

export async function test() {
  const failures = []

  const basic = await execute({ task: 'Refactor auth' })
  if (basic.mode !== 'adaptive') failures.push('Default mode should be adaptive')
  if (basic.expectedOutputSize !== 'medium') failures.push('Default output size should be medium')

  const aggressive = await execute({ task: 'Large migration', expected_output_size: 'huge', mode: 'aggressive' })
  if (!aggressive.recommendations.some(r => r.includes('Aggressive mode'))) {
    failures.push('Aggressive mode recommendations missing')
  }

  try {
    await execute({})
    failures.push('Missing task should throw')
  } catch (err) {
    if (!String(err.message).includes('task')) failures.push('Missing task error should mention task')
  }

  if (failures.length) return { passed: false, message: failures.join(' | ') }
  return { passed: true, message: 'All token optimizer checks passed.' }
}
