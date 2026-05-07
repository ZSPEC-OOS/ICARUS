// ─── analyze-stacktrace tool ──────────────────────────────────────────────────
export const toolMeta = {
  id: 'analyze-stacktrace',
  name: 'Analyze Stacktrace',
  version: '1.0.0',
  description: 'Parse JS/TS stack traces into structured frames and actionable debugging hints.',
  category: 'analysis',
  author: 'BLUSWAN',
}

function inferHint(errorName = '', message = '') {
  const hay = `${errorName} ${message}`.toLowerCase()
  if (hay.includes('undefined') || hay.includes('null')) return 'Check null/undefined guards before property access.'
  if (hay.includes('module') && hay.includes('not found')) return 'Verify import path, file casing, and dependency installation.'
  if (hay.includes('syntaxerror')) return 'Inspect nearby syntax (missing bracket/comma/quote) at the first frame.'
  if (hay.includes('typeerror')) return 'Inspect the top frame variables and expected object/function types.'
  return 'Start at the top frame and inspect surrounding code plus recent edits.'
}

function parseFrame(line) {
  const trimmed = line.trim()
  const m1 = trimmed.match(/^at\s+(.*?)\s+\((.*?):(\d+):(\d+)\)$/)
  if (m1) return { fn: m1[1], file: m1[2], line: Number(m1[3]), column: Number(m1[4]) }

  const m2 = trimmed.match(/^at\s+(.*?):(\d+):(\d+)$/)
  if (m2) return { fn: '(anonymous)', file: m2[1], line: Number(m2[2]), column: Number(m2[3]) }

  return null
}

export async function execute(input) {
  const { stacktrace, max_frames = 8 } = input || {}
  if (!stacktrace || typeof stacktrace !== 'string') throw new Error('stacktrace is required')

  const lines = stacktrace.split('\n').filter(Boolean)
  const header = lines[0] || ''
  const headMatch = header.match(/^([\w$.]+):\s*(.*)$/)
  const errorName = headMatch?.[1] || 'Error'
  const message = headMatch?.[2] || header

  const frames = []
  for (const line of lines.slice(1)) {
    const parsed = parseFrame(line)
    if (parsed) frames.push(parsed)
    if (frames.length >= Math.max(1, Math.min(max_frames, 25))) break
  }

  return {
    error: { name: errorName, message },
    frameCount: frames.length,
    frames,
    hint: inferHint(errorName, message),
  }
}

export async function test() {
  const failures = []
  const sample = [
    'TypeError: Cannot read properties of undefined (reading "map")',
    '    at renderList (src/components/List.jsx:42:15)',
    '    at src/App.jsx:10:3',
  ].join('\n')

  const r1 = await execute({ stacktrace: sample })
  if (r1.error.name !== 'TypeError') failures.push('Trial 1: error name not parsed')
  if (r1.frames.length !== 2) failures.push(`Trial 1: expected 2 frames, got ${r1.frames.length}`)
  if (r1.frames[0]?.file !== 'src/components/List.jsx') failures.push('Trial 1: first frame file mismatch')

  const r2 = await execute({ stacktrace: sample, max_frames: 1 })
  if (r2.frames.length !== 1) failures.push(`Trial 2: max_frames not respected (${r2.frames.length})`)

  if (!r1.hint.toLowerCase().includes('undefined')) failures.push('Trial 3: undefined hint missing')

  try {
    await execute({})
    failures.push('Trial 4: missing stacktrace should throw')
  } catch (e) {
    if (!e.message.includes('stacktrace')) failures.push(`Trial 4: wrong error: ${e.message}`)
  }

  if (failures.length) return { passed: false, message: failures.join(' | ') }
  return { passed: true, message: 'All 4 trials passed (header parsing, frame parsing, frame limit, input guard).' }
}
