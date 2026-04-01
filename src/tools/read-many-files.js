// ─── read-many-files tool ─────────────────────────────────────────────────────
export const toolMeta = {
  id: 'read-many-files',
  name: 'Read Many Files',
  version: '1.0.0',
  description: 'Read multiple files in a single call — more efficient than separate read-file calls.',
  category: 'coding',
  author: 'ICARUS',
}

export async function execute(input, config = {}) {
  const { paths } = input
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('paths must be a non-empty array')
  if (paths.length > 20) throw new Error('max 20 paths per call')

  const { getFileContent, repoOwner, repoName, baseBranch, githubToken } = config
  if (!getFileContent) throw new Error('getFileContent not provided in config')

  const files = await Promise.all(
    paths.map(async path => {
      try {
        const content = await getFileContent({ owner: repoOwner, repo: repoName, path, branch: baseBranch, token: githubToken })
        return { path, content }
      } catch (e) {
        return { path, error: e.message }
      }
    }),
  )

  return { files, count: files.length }
}

export async function test() {
  const failures = []

  const REPO = {
    'src/a.js': 'export const A = 1',
    'src/b.js': 'export const B = 2',
    'src/c.js': 'export const C = 3',
  }

  function makeConfig(badPaths = []) {
    return {
      getFileContent: async ({ path }) => {
        if (badPaths.includes(path)) throw new Error('not found')
        if (!REPO[path]) throw new Error('not found')
        return REPO[path]
      },
      repoOwner: 'test', repoName: 'repo', baseBranch: 'main', githubToken: '',
    }
  }

  // Trial 1: all files returned in order
  const r1 = await execute({ paths: ['src/a.js', 'src/b.js', 'src/c.js'] }, makeConfig())
  if (r1.count !== 3) failures.push(`Trial 1: expected 3 files, got ${r1.count}`)
  if (r1.files[0].path !== 'src/a.js') failures.push('Trial 1: first file path mismatch')
  if (r1.files[1].content !== 'export const B = 2') failures.push('Trial 1: second file content mismatch')
  if (r1.files[2].path !== 'src/c.js') failures.push('Trial 1: third file path mismatch')

  // Trial 2: content is verbatim
  const r2 = await execute({ paths: ['src/a.js'] }, makeConfig())
  if (r2.files[0].content !== REPO['src/a.js']) failures.push('Trial 2: content not verbatim')

  // Trial 3: one bad path doesn't break the others — returns error field instead
  const r3 = await execute({ paths: ['src/a.js', 'missing.js', 'src/c.js'] }, makeConfig(['missing.js']))
  if (r3.count !== 3) failures.push(`Trial 3: should still return 3 entries, got ${r3.count}`)
  const badEntry = r3.files.find(f => f.path === 'missing.js')
  if (!badEntry?.error) failures.push('Trial 3: missing file should have error field')
  const goodEntry = r3.files.find(f => f.path === 'src/a.js')
  if (!goodEntry?.content) failures.push('Trial 3: good file lost when another failed')

  // Trial 4: empty array throws
  try {
    await execute({ paths: [] }, makeConfig())
    failures.push('Trial 4: should throw for empty paths array')
  } catch (e) {
    if (!e.message.includes('non-empty')) failures.push(`Trial 4: wrong error: ${e.message}`)
  }

  // Trial 5: non-array throws
  try {
    await execute({ paths: 'src/a.js' }, makeConfig())
    failures.push('Trial 5: should throw when paths is a string')
  } catch (e) {
    if (!e.message.includes('array')) failures.push(`Trial 5: wrong error: ${e.message}`)
  }

  // Trial 6: 21 paths exceeds limit
  const tooMany = Array.from({ length: 21 }, (_, i) => `file${i}.js`)
  try {
    await execute({ paths: tooMany }, makeConfig())
    failures.push('Trial 6: should throw for >20 paths')
  } catch (e) {
    if (!e.message.includes('20')) failures.push(`Trial 6: wrong error: ${e.message}`)
  }

  // Trial 7: exactly 20 paths is allowed
  const twenty = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}.js`, `content${i}`]))
  const r7 = await execute(
    { paths: Object.keys(twenty) },
    { getFileContent: async ({ path }) => twenty[path], repoOwner: 'x', repoName: 'y', baseBranch: 'main', githubToken: '' },
  )
  if (r7.count !== 20) failures.push(`Trial 7: expected 20, got ${r7.count}`)

  if (failures.length) return { passed: false, message: failures.join(' | ') }
  return { passed: true, message: 'All 7 trials passed (ordering, verbatim content, partial failure, limits, error guards).' }
}
