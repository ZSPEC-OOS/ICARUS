// ─── write-file tool ──────────────────────────────────────────────────────────
export const toolMeta = {
  id: 'write-file',
  name: 'Write File',
  version: '1.0.0',
  description: 'Create a new file or completely overwrite an existing file in the repository.',
  category: 'coding',
  author: 'BLUSWAN',
}

export async function execute(input, config = {}) {
  const { path, content, message } = input
  if (!path)    throw new Error('path is required')
  if (!content && content !== '') throw new Error('content is required')
  const { createOrUpdateFile, repoOwner, repoName, baseBranch, githubToken } = config
  if (!createOrUpdateFile) throw new Error('createOrUpdateFile not provided in config')
  const commitMsg = message || `Update ${path}`
  await createOrUpdateFile({ owner: repoOwner, repo: repoName, path, content, message: commitMsg, branch: baseBranch, token: githubToken })
  return { path, written: true, message: commitMsg }
}

export async function test() {
  const failures = []
  let lastCall = null

  function makeConfig() {
    lastCall = null
    return {
      createOrUpdateFile: async (args) => { lastCall = args },
      repoOwner: 'acme', repoName: 'site', baseBranch: 'main', githubToken: '',
    }
  }

  // Trial 1: content forwarded exactly
  const body = 'const x = 1\nexport default x\n'
  await execute({ path: 'src/x.js', content: body }, makeConfig())
  if (lastCall?.content !== body) failures.push('Trial 1: content was not forwarded verbatim')
  if (lastCall?.path !== 'src/x.js') failures.push('Trial 1: path mismatch')

  // Trial 2: default commit message uses path
  await execute({ path: 'README.md', content: '# Hello' }, makeConfig())
  if (!lastCall?.message.includes('README.md')) failures.push(`Trial 2: default message missing path, got "${lastCall?.message}"`)

  // Trial 3: custom commit message is used verbatim
  await execute({ path: 'f.js', content: 'x', message: 'chore: update constants' }, makeConfig())
  if (lastCall?.message !== 'chore: update constants') failures.push(`Trial 3: custom message overridden, got "${lastCall?.message}"`)

  // Trial 4: empty string content is valid (empty file)
  const r4 = await execute({ path: 'empty.txt', content: '' }, makeConfig())
  if (!r4.written) failures.push('Trial 4: empty content should be allowed')
  if (lastCall?.content !== '') failures.push('Trial 4: empty string not forwarded')

  // Trial 5: repo owner/name forwarded to createOrUpdateFile
  await execute({ path: 'f.js', content: 'x' }, makeConfig())
  if (lastCall?.owner !== 'acme') failures.push('Trial 5: owner not forwarded')
  if (lastCall?.repo  !== 'site') failures.push('Trial 5: repo not forwarded')

  // Trial 6: missing path throws
  try {
    await execute({ content: 'x' }, makeConfig())
    failures.push('Trial 6: should throw for missing path')
  } catch (e) {
    if (!e.message.includes('path')) failures.push(`Trial 6: wrong error: ${e.message}`)
  }

  // Trial 7: missing content throws
  try {
    await execute({ path: 'f.js' }, makeConfig())
    failures.push('Trial 7: should throw for missing content')
  } catch (e) {
    if (!e.message.includes('content')) failures.push(`Trial 7: wrong error: ${e.message}`)
  }

  if (failures.length) return { passed: false, message: failures.join(' | ') }
  return { passed: true, message: 'All 7 trials passed (content fidelity, commit messages, empty file, param forwarding, error guards).' }
}
