// ─── grep tool ────────────────────────────────────────────────────────────────
export const toolMeta = {
  id: 'grep',
  name: 'Grep',
  version: '1.0.0',
  description: 'Regex search across indexed file contents. Returns matching lines with file paths and line numbers.',
  category: 'analysis',
  author: 'ICARUS',
}

export async function execute(input, config = {}) {
  const { pattern, path: pathPrefix, ignore_case = false } = input
  if (!pattern) throw new Error('pattern is required')

  const { shadowContext } = config
  if (!shadowContext) throw new Error('shadowContext not provided in config')

  const regex = new RegExp(pattern, ignore_case ? 'gi' : 'g')
  const results = []

  const indexed = shadowContext.getIndexedContent?.() || {}
  for (const [filePath, content] of Object.entries(indexed)) {
    if (pathPrefix && !filePath.startsWith(pathPrefix)) continue
    const lines = content.split('\n')
    lines.forEach((line, idx) => {
      if (regex.test(line)) {
        results.push({ file: filePath, line: idx + 1, text: line.trim() })
      }
      regex.lastIndex = 0
    })
  }

  return { pattern, matches: results, count: results.length }
}

export async function test() {
  const corpus = {
    'src/auth.js':   'export function login(user) {\n  return authenticate(user)\n}\nexport function LOGOUT() {}',
    'src/app.js':    'import { login } from "./auth"\nconst app = createApp()\napp.use(login)',
    'lib/utils.js':  'export const VERSION = "1.0.0"\n// login helper\nfunction noop() {}',
  }
  const ctx = { getIndexedContent: () => corpus }
  const failures = []

  // Trial 1: exact match returns correct file + line number
  const r1 = await execute({ pattern: 'authenticate' }, { shadowContext: ctx })
  if (r1.count !== 1) failures.push(`Trial 1: expected 1 match, got ${r1.count}`)
  if (r1.matches[0]?.line !== 2) failures.push(`Trial 1: expected line 2, got ${r1.matches[0]?.line}`)
  if (r1.matches[0]?.file !== 'src/auth.js') failures.push(`Trial 1: wrong file`)

  // Trial 2: pattern appears across multiple files
  const r2 = await execute({ pattern: 'login' }, { shadowContext: ctx })
  const files2 = r2.matches.map(m => m.file)
  if (!files2.includes('src/auth.js')) failures.push('Trial 2: missing src/auth.js')
  if (!files2.includes('src/app.js'))  failures.push('Trial 2: missing src/app.js')
  if (!files2.includes('lib/utils.js')) failures.push('Trial 2: missing lib/utils.js')

  // Trial 3: case-sensitive — LOGOUT should NOT match "logout"
  const r3cs = await execute({ pattern: 'logout', ignore_case: false }, { shadowContext: ctx })
  if (r3cs.count !== 0) failures.push(`Trial 3: case-sensitive should return 0, got ${r3cs.count}`)

  // Trial 4: case-insensitive — LOGOUT should match
  const r3ci = await execute({ pattern: 'logout', ignore_case: true }, { shadowContext: ctx })
  if (r3ci.count !== 1) failures.push(`Trial 4: case-insensitive should return 1, got ${r3ci.count}`)

  // Trial 5: path prefix filter — only src/ files
  const r4 = await execute({ pattern: 'login', path: 'src/' }, { shadowContext: ctx })
  const files4 = r4.matches.map(m => m.file)
  if (files4.includes('lib/utils.js')) failures.push('Trial 5: path filter leaked lib/utils.js')
  if (r4.count < 2) failures.push(`Trial 5: expected >=2 matches in src/, got ${r4.count}`)

  // Trial 6: no match returns empty
  const r5 = await execute({ pattern: 'xyzzy_nonexistent_12345' }, { shadowContext: ctx })
  if (r5.count !== 0) failures.push(`Trial 6: expected 0, got ${r5.count}`)

  // Trial 7: missing pattern throws
  try {
    await execute({}, { shadowContext: ctx })
    failures.push('Trial 7: should have thrown for missing pattern')
  } catch (e) {
    if (!e.message.includes('pattern is required')) failures.push(`Trial 7: wrong error: ${e.message}`)
  }

  // Trial 8: missing shadowContext throws
  try {
    await execute({ pattern: 'login' }, {})
    failures.push('Trial 8: should have thrown for missing shadowContext')
  } catch (e) {
    if (!e.message.includes('shadowContext')) failures.push(`Trial 8: wrong error: ${e.message}`)
  }

  if (failures.length) return { passed: false, message: failures.join(' | ') }
  return { passed: true, message: `All 8 trials passed (${r2.count} cross-file matches, case filtering, path prefix, error guards).` }
}
