// ─── list-directory tool ──────────────────────────────────────────────────────
export const toolMeta = {
  id: 'list-directory',
  name: 'List Directory',
  version: '1.0.0',
  description: 'List files and subdirectories inside a directory of the repository.',
  category: 'coding',
  author: 'ICARUS',
}

export async function execute(input, config = {}) {
  const { path = '' } = input
  const { listDirectory, repoOwner, repoName, baseBranch, githubToken } = config
  if (!listDirectory) throw new Error('listDirectory not provided in config')

  const entries = await listDirectory({ owner: repoOwner, repo: repoName, path, branch: baseBranch, token: githubToken })
  return { path, entries }
}

export async function test() {
  const failures = []

  const TREE = {
    '': [
      { name: 'src',          type: 'dir'  },
      { name: 'package.json', type: 'file' },
      { name: 'README.md',    type: 'file' },
    ],
    'src': [
      { name: 'App.jsx',  type: 'file' },
      { name: 'main.jsx', type: 'file' },
      { name: 'components', type: 'dir' },
    ],
    'src/components': [
      { name: 'Button.jsx', type: 'file' },
    ],
  }

  function makeConfig() {
    return {
      listDirectory: async ({ path }) => {
        if (!(path in TREE)) throw new Error(`path not found: ${path}`)
        return TREE[path]
      },
      repoOwner: 'test', repoName: 'repo', baseBranch: 'main', githubToken: '',
    }
  }

  // Trial 1: root listing returns correct entries
  const r1 = await execute({ path: '' }, makeConfig())
  if (!Array.isArray(r1.entries))    failures.push('Trial 1: entries should be an array')
  if (r1.entries.length !== 3)       failures.push(`Trial 1: expected 3 root entries, got ${r1.entries.length}`)
  if (r1.path !== '')                failures.push('Trial 1: path not echoed')
  const hasPackage = r1.entries.some(e => e.name === 'package.json')
  if (!hasPackage) failures.push('Trial 1: package.json missing from root')

  // Trial 2: nested path listing
  const r2 = await execute({ path: 'src' }, makeConfig())
  if (r2.entries.length !== 3)        failures.push(`Trial 2: expected 3 src entries, got ${r2.entries.length}`)
  if (r2.path !== 'src')              failures.push('Trial 2: path not echoed')
  const hasComponents = r2.entries.some(e => e.name === 'components' && e.type === 'dir')
  if (!hasComponents) failures.push('Trial 2: components dir missing from src')

  // Trial 3: deeply nested path
  const r3 = await execute({ path: 'src/components' }, makeConfig())
  if (r3.entries.length !== 1)           failures.push(`Trial 3: expected 1 entry, got ${r3.entries.length}`)
  if (r3.entries[0].name !== 'Button.jsx') failures.push('Trial 3: Button.jsx missing')

  // Trial 4: path defaults to '' (root) when omitted
  const r4 = await execute({}, makeConfig())
  if (r4.path !== '')          failures.push(`Trial 4: default path should be '', got "${r4.path}"`)
  if (r4.entries.length !== 3) failures.push('Trial 4: root entries missing when path omitted')

  // Trial 5: invalid path propagates error from listDirectory
  try {
    await execute({ path: 'nonexistent/path' }, makeConfig())
    failures.push('Trial 5: should have thrown for invalid path')
  } catch (e) {
    if (!e.message.includes('not found')) failures.push(`Trial 5: wrong error: ${e.message}`)
  }

  // Trial 6: missing listDirectory throws
  try {
    await execute({ path: '' }, { repoOwner: 'x', repoName: 'y', baseBranch: 'main', githubToken: '' })
    failures.push('Trial 6: should throw for missing listDirectory')
  } catch (e) {
    if (!e.message.includes('listDirectory')) failures.push(`Trial 6: wrong error: ${e.message}`)
  }

  if (failures.length) return { passed: false, message: failures.join(' | ') }
  return { passed: true, message: 'All 6 trials passed (root, nested, deep, default path, error propagation, guard).' }
}
