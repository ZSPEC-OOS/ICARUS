// ─── list-source-directory tool ───────────────────────────────────────────────
export const toolMeta = {
  id: 'list-source-directory',
  name: 'List Source Directory',
  version: '1.0.0',
  description: 'List files and subdirectories in a SOURCE (secondary) repository directory. Read-only.',
  category: 'coding',
  author: 'ICARUS',
}

export async function execute(input, config = {}) {
  const { path = '' } = input

  const { listDirectory, sourceRepo } = config
  if (!listDirectory) throw new Error('listDirectory not provided in config')
  if (!sourceRepo?.owner || !sourceRepo?.repo) throw new Error('sourceRepo not configured — connect a source repo in Settings')

  const entries = await listDirectory({
    owner:  sourceRepo.owner,
    repo:   sourceRepo.repo,
    path,
    branch: sourceRepo.branch || 'main',
    token:  sourceRepo.token || '',
  })
  return { path, entries, source: `${sourceRepo.owner}/${sourceRepo.repo}` }
}

export async function test() {
  const failures = []

  const SOURCE_TREE = {
    '':    [{ name: 'src', type: 'dir' }, { name: 'package.json', type: 'file' }],
    'src': [{ name: 'index.js', type: 'file' }, { name: 'lib', type: 'dir' }],
    'src/lib': [{ name: 'utils.js', type: 'file' }],
  }

  function makeConfig(sourceRepoOverride) {
    return {
      listDirectory: async ({ path }) => {
        if (!(path in SOURCE_TREE)) throw new Error(`path not found: ${path}`)
        return SOURCE_TREE[path]
      },
      sourceRepo: sourceRepoOverride ?? { owner: 'acme', repo: 'source', branch: 'main', token: '' },
    }
  }

  // Trial 1: root listing returns correct entries
  const r1 = await execute({ path: '' }, makeConfig())
  if (!Array.isArray(r1.entries))   failures.push('Trial 1: entries should be array')
  if (r1.entries.length !== 2)      failures.push(`Trial 1: expected 2 root entries, got ${r1.entries.length}`)
  if (r1.source !== 'acme/source')  failures.push(`Trial 1: source label wrong, got "${r1.source}"`)
  if (r1.path !== '')               failures.push('Trial 1: path not echoed')

  // Trial 2: nested path listing
  const r2 = await execute({ path: 'src' }, makeConfig())
  if (r2.entries.length !== 2) failures.push(`Trial 2: expected 2 src entries, got ${r2.entries.length}`)
  if (r2.path !== 'src')       failures.push('Trial 2: path not echoed')

  // Trial 3: deeply nested path
  const r3 = await execute({ path: 'src/lib' }, makeConfig())
  if (r3.entries.length !== 1)               failures.push(`Trial 3: expected 1 lib entry, got ${r3.entries.length}`)
  if (r3.entries[0].name !== 'utils.js')     failures.push('Trial 3: utils.js not found')

  // Trial 4: owner/repo/branch forwarded correctly
  let capturedArgs = null
  await execute({ path: 'src' }, {
    listDirectory: async (args) => { capturedArgs = args; return [] },
    sourceRepo: { owner: 'myorg', repo: 'myrepo', branch: 'develop', token: 'tok' },
  })
  if (capturedArgs?.owner  !== 'myorg')   failures.push('Trial 4: owner not forwarded')
  if (capturedArgs?.repo   !== 'myrepo')  failures.push('Trial 4: repo not forwarded')
  if (capturedArgs?.branch !== 'develop') failures.push('Trial 4: branch not forwarded')

  // Trial 5: default path is '' when omitted
  const r5 = await execute({}, makeConfig())
  if (r5.path !== '')          failures.push(`Trial 5: default path should be '', got "${r5.path}"`)
  if (r5.entries.length !== 2) failures.push('Trial 5: root entries not returned when path omitted')

  // Trial 6: missing sourceRepo throws
  try {
    await execute({ path: '' }, { listDirectory: async () => [] })
    failures.push('Trial 6: should throw for missing sourceRepo')
  } catch (e) {
    if (!e.message.includes('sourceRepo')) failures.push(`Trial 6: wrong error: ${e.message}`)
  }

  // Trial 7: partial sourceRepo (only owner, no repo) throws
  try {
    await execute({ path: '' }, { listDirectory: async () => [], sourceRepo: { owner: 'x' } })
    failures.push('Trial 7: should throw for incomplete sourceRepo')
  } catch (e) {
    if (!e.message.includes('sourceRepo')) failures.push(`Trial 7: wrong error: ${e.message}`)
  }

  // Trial 8: missing listDirectory throws
  try {
    await execute({ path: '' }, { sourceRepo: { owner: 'x', repo: 'y' } })
    failures.push('Trial 8: should throw for missing listDirectory')
  } catch (e) {
    if (!e.message.includes('listDirectory')) failures.push(`Trial 8: wrong error: ${e.message}`)
  }

  if (failures.length) return { passed: false, message: failures.join(' | ') }
  return { passed: true, message: 'All 8 trials passed (root, nested, deep, param forwarding, default path, error guards).' }
}
