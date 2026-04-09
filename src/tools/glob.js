// ─── glob tool ────────────────────────────────────────────────────────────────
export const toolMeta = {
  id: 'glob',
  name: 'Glob',
  version: '1.0.0',
  description: 'Find files matching a glob pattern (e.g. src/**/*.jsx). Returns matching paths sorted alphabetically.',
  category: 'analysis',
  author: 'BLUSWAN',
}

/**
 * Convert a glob pattern string into a RegExp.
 * Supports: * (any non-separator chars), ** (any chars including /), ? (single non-separator char),
 * {a,b} (brace expansion).
 */
function globToRegex(pattern) {
  let src = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === '*' && pattern[i + 1] === '*') {
      src += '.*'
      i += 2
      if (pattern[i] === '/') i++ // absorb trailing slash after **
    } else if (ch === '*') {
      src += '[^/]*'
      i++
    } else if (ch === '?') {
      src += '[^/]'
      i++
    } else if (ch === '{') {
      const end = pattern.indexOf('}', i)
      if (end === -1) {
        src += '\\{'
        i++
      } else {
        const options = pattern
          .slice(i + 1, end)
          .split(',')
          .map(o => o.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
        src += `(?:${options.join('|')})`
        i = end + 1
      }
    } else {
      src += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      i++
    }
  }
  return new RegExp(`^${src}$`)
}

export async function execute(input, config = {}) {
  const { pattern, path: basePath } = input
  if (!pattern) throw new Error('pattern is required')

  const { shadowContext } = config
  if (!shadowContext) throw new Error('shadowContext not provided in config')

  const indexed = shadowContext.getIndexedContent?.() || {}
  const allPaths = Object.keys(indexed)

  // Prepend basePath to pattern if provided and not already included
  const effectivePattern =
    basePath && !pattern.startsWith(basePath)
      ? `${basePath.replace(/\/$/, '')}/${pattern}`
      : pattern

  const regex = globToRegex(effectivePattern)
  const matches = allPaths.filter(p => regex.test(p)).sort()

  return { pattern: effectivePattern, matches, count: matches.length }
}

export async function test() {
  const corpus = {
    'src/App.jsx': '',
    'src/components/Button.jsx': '',
    'src/components/Modal.tsx': '',
    'src/services/api.js': '',
    'src/services/auth.js': '',
    'tests/App.test.js': '',
    'tests/Button.test.jsx': '',
    'package.json': '',
    'vite.config.js': '',
  }
  const ctx = { getIndexedContent: () => corpus }
  const failures = []

  // Trial 1: **/*.jsx matches all jsx files across directories
  const r1 = await execute({ pattern: '**/*.jsx' }, { shadowContext: ctx })
  for (const f of ['src/App.jsx', 'src/components/Button.jsx', 'tests/Button.test.jsx']) {
    if (!r1.matches.includes(f)) failures.push(`Trial 1: missing ${f}`)
  }
  if (r1.matches.includes('src/components/Modal.tsx')) failures.push('Trial 1: should not match .tsx')

  // Trial 2: src/**/*.js matches only .js files under src/
  const r2 = await execute({ pattern: 'src/**/*.js' }, { shadowContext: ctx })
  if (!r2.matches.includes('src/services/api.js'))  failures.push('Trial 2: missing api.js')
  if (!r2.matches.includes('src/services/auth.js')) failures.push('Trial 2: missing auth.js')
  if (r2.matches.includes('tests/App.test.js')) failures.push('Trial 2: leaked tests/App.test.js')
  if (r2.matches.includes('vite.config.js'))    failures.push('Trial 2: leaked vite.config.js')

  // Trial 3: *.json matches only root-level json
  const r3 = await execute({ pattern: '*.json' }, { shadowContext: ctx })
  if (!r3.matches.includes('package.json')) failures.push('Trial 3: missing package.json')
  if (r3.count !== 1) failures.push(`Trial 3: expected 1, got ${r3.count}`)

  // Trial 4: brace expansion {jsx,tsx}
  const r4 = await execute({ pattern: 'src/components/*.{jsx,tsx}' }, { shadowContext: ctx })
  if (!r4.matches.includes('src/components/Button.jsx')) failures.push('Trial 4: missing Button.jsx')
  if (!r4.matches.includes('src/components/Modal.tsx'))  failures.push('Trial 4: missing Modal.tsx')
  if (r4.count !== 2) failures.push(`Trial 4: expected 2, got ${r4.count}`)

  // Trial 5: ? single-char wildcard
  const r5 = await execute({ pattern: 'src/services/a??.js' }, { shadowContext: ctx })
  if (!r5.matches.includes('src/services/api.js')) failures.push('Trial 5: missing api.js')

  // Trial 6: no matches returns empty array
  const r6 = await execute({ pattern: '**/*.py' }, { shadowContext: ctx })
  if (r6.count !== 0) failures.push(`Trial 6: expected 0, got ${r6.count}`)

  // Trial 7: basePath prefix is applied
  const r7 = await execute({ pattern: '**/*.js', path: 'src' }, { shadowContext: ctx })
  if (r7.matches.includes('tests/App.test.js')) failures.push('Trial 7: basePath filter leaked tests/')
  if (!r7.matches.includes('src/services/api.js')) failures.push('Trial 7: missing src/services/api.js')

  // Trial 8: missing pattern throws
  try {
    await execute({}, { shadowContext: ctx })
    failures.push('Trial 8: should have thrown for missing pattern')
  } catch (e) {
    if (!e.message.includes('pattern is required')) failures.push(`Trial 8: wrong error: ${e.message}`)
  }

  // Trial 9: missing shadowContext throws
  try {
    await execute({ pattern: '**/*.js' }, {})
    failures.push('Trial 9: should have thrown for missing shadowContext')
  } catch (e) {
    if (!e.message.includes('shadowContext')) failures.push(`Trial 9: wrong error: ${e.message}`)
  }

  if (failures.length) return { passed: false, message: failures.join(' | ') }
  return {
    passed: true,
    message: `All 9 trials passed (**, *, ?, {a,b} brace expansion, basePath prefix, no-match, error guards).`,
  }
}
