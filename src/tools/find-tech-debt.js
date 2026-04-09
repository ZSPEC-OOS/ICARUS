// ─── find-tech-debt tool ─────────────────────────────────────────────────────
export const toolMeta = {
  id: 'find-tech-debt',
  name: 'Find Tech Debt',
  version: '1.0.0',
  description: 'Scan indexed code for TODO/FIXME/HACK markers and summarize hotspots.',
  category: 'analysis',
  author: 'BLUSWAN',
}

export async function execute(input = {}, config = {}) {
  const { shadowContext } = config
  if (!shadowContext) throw new Error('shadowContext not provided in config')

  const { markers = ['TODO', 'FIXME', 'HACK', 'BUG'], path = null, limit = 50 } = input
  const escaped = markers.map(m => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = `\\b(${escaped.join('|')})\\b`

  const matches = shadowContext.grepContent?.(pattern, path, 'i') || []
  const sliced = matches.slice(0, Math.max(1, Math.min(limit, 200)))
  const byFile = {}
  for (const m of sliced) {
    byFile[m.path] = (byFile[m.path] || 0) + 1
  }

  const hotspots = Object.entries(byFile)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([file, count]) => ({ file, count }))

  return {
    pattern,
    total: matches.length,
    returned: sliced.length,
    hotspots,
    matches: sliced,
  }
}

export async function test() {
  const failures = []
  const sample = [
    { path: 'src/a.js', line: 2, text: '// TODO: refactor' },
    { path: 'src/a.js', line: 7, text: '// FIXME edge case' },
    { path: 'src/b.js', line: 1, text: '// HACK temporary' },
  ]

  const ctx = { grepContent: () => sample }
  const r1 = await execute({}, { shadowContext: ctx })
  if (r1.total !== 3) failures.push(`Trial 1: total mismatch ${r1.total}`)
  if (r1.hotspots[0]?.file !== 'src/a.js') failures.push('Trial 1: hotspots order mismatch')

  const r2 = await execute({ limit: 2 }, { shadowContext: ctx })
  if (r2.returned !== 2) failures.push(`Trial 2: limit not applied (${r2.returned})`)

  try {
    await execute({}, {})
    failures.push('Trial 3: missing shadowContext should throw')
  } catch (e) {
    if (!e.message.includes('shadowContext')) failures.push(`Trial 3: wrong error ${e.message}`)
  }

  if (failures.length) return { passed: false, message: failures.join(' | ') }
  return { passed: true, message: 'All 3 trials passed (aggregation, limit, config guard).' }
}
