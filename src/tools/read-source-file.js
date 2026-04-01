// ─── read-source-file tool ────────────────────────────────────────────────────
export const toolMeta = {
  id: 'read-source-file',
  name: 'Read Source File',
  version: '1.0.0',
  description: 'Read a file from the SOURCE (secondary) repository in Fusion mode. Read-only.',
  category: 'coding',
  author: 'ICARUS',
}

export async function execute(input, config = {}) {
  const { path } = input
  if (!path) throw new Error('path is required')

  const { getFileContent, sourceRepo } = config
  if (!getFileContent) throw new Error('getFileContent not provided in config')
  if (!sourceRepo?.owner || !sourceRepo?.repo) throw new Error('sourceRepo not configured — connect a source repo in Settings')

  const content = await getFileContent({
    owner: sourceRepo.owner,
    repo:  sourceRepo.repo,
    path,
    branch: sourceRepo.branch || 'main',
    token:  sourceRepo.token || '',
  })
  return { path, content, source: `${sourceRepo.owner}/${sourceRepo.repo}` }
}

export async function test() {
  const failures = []

  const SOURCE_FILES = {
    'src/index.js':   'export default function main() {}',
    'src/utils.js':   'export const noop = () => {}',
    'package.json':   '{"name":"source-repo","version":"1.0.0"}',
  }

  function makeConfig(sourceRepoOverride) {
    return {
      getFileContent: async ({ owner, repo, path, branch }) => {
        if (owner !== 'acme' || repo !== 'source') throw new Error(`wrong repo: ${owner}/${repo}`)
        if (!SOURCE_FILES[path]) throw new Error(`file not found: ${path}`)
        return SOURCE_FILES[path]
      },
      sourceRepo: sourceRepoOverride ?? { owner: 'acme', repo: 'source', branch: 'main', token: '' },
    }
  }

  // Trial 1: content returned correctly
  const r1 = await execute({ path: 'src/index.js' }, makeConfig())
  if (r1.content !== SOURCE_FILES['src/index.js']) failures.push('Trial 1: content mismatch')

  // Trial 2: path echoed in result
  if (r1.path !== 'src/index.js') failures.push('Trial 2: path not echoed')

  // Trial 3: source label is owner/repo
  if (r1.source !== 'acme/source') failures.push(`Trial 3: source label wrong, got "${r1.source}"`)

  // Trial 4: different valid paths work
  const r4 = await execute({ path: 'package.json' }, makeConfig())
  if (!r4.content.includes('source-repo')) failures.push('Trial 4: package.json content wrong')

  // Trial 5: owner and repo forwarded to getFileContent
  let capturedArgs = null
  await execute({ path: 'src/utils.js' }, {
    getFileContent: async (args) => { capturedArgs = args; return 'ok' },
    sourceRepo: { owner: 'myorg', repo: 'myrepo', branch: 'develop', token: 'tok' },
  })
  if (capturedArgs?.owner  !== 'myorg')   failures.push('Trial 5: owner not forwarded')
  if (capturedArgs?.repo   !== 'myrepo')  failures.push('Trial 5: repo not forwarded')
  if (capturedArgs?.branch !== 'develop') failures.push('Trial 5: branch not forwarded')

  // Trial 6: missing path throws
  try {
    await execute({}, makeConfig())
    failures.push('Trial 6: should throw for missing path')
  } catch (e) {
    if (!e.message.includes('path')) failures.push(`Trial 6: wrong error: ${e.message}`)
  }

  // Trial 7: missing sourceRepo throws with guidance
  try {
    await execute({ path: 'f.js' }, { getFileContent: async () => '' })
    failures.push('Trial 7: should throw for missing sourceRepo')
  } catch (e) {
    if (!e.message.includes('sourceRepo')) failures.push(`Trial 7: error should mention sourceRepo, got: "${e.message}"`)
  }

  // Trial 8: partial sourceRepo (no repo) throws
  try {
    await execute({ path: 'f.js' }, { getFileContent: async () => '', sourceRepo: { owner: 'x' } })
    failures.push('Trial 8: should throw when sourceRepo.repo missing')
  } catch (e) {
    if (!e.message.includes('sourceRepo')) failures.push(`Trial 8: wrong error: ${e.message}`)
  }

  // Trial 9: missing getFileContent throws
  try {
    await execute({ path: 'f.js' }, { sourceRepo: { owner: 'x', repo: 'y' } })
    failures.push('Trial 9: should throw for missing getFileContent')
  } catch (e) {
    if (!e.message.includes('getFileContent')) failures.push(`Trial 9: wrong error: ${e.message}`)
  }

  if (failures.length) return { passed: false, message: failures.join(' | ') }
  return { passed: true, message: 'All 9 trials passed (content, path echo, source label, param forwarding, error guards).' }
}
