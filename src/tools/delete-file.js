// ─── delete-file tool ─────────────────────────────────────────────────────────
export const toolMeta = {
  id: 'delete-file',
  name: 'Delete File',
  version: '1.0.0',
  description: 'Delete a file from the repository. Irreversible without a git revert.',
  category: 'coding',
  author: 'BLUSWAN',
}

export async function execute(input, config = {}) {
  const { path, message } = input
  if (!path) throw new Error('path is required')
  const { deleteFile, repoOwner, repoName, baseBranch, githubToken } = config
  if (!deleteFile) throw new Error('deleteFile not provided in config')

  await deleteFile({ owner: repoOwner, repo: repoName, path, message: message || `Delete ${path}`, branch: baseBranch, token: githubToken })
  return { path, deleted: true }
}

export async function test() {
  const failures = []
  let lastCall = null

  function makeConfig() {
    lastCall = null
    return {
      deleteFile: async (args) => { lastCall = args },
      repoOwner: 'acme', repoName: 'site', baseBranch: 'main', githubToken: '',
    }
  }

  // Trial 1: path and owner/repo forwarded correctly
  await execute({ path: 'old/legacy.js' }, makeConfig())
  if (lastCall?.path  !== 'old/legacy.js') failures.push('Trial 1: path not forwarded')
  if (lastCall?.owner !== 'acme')          failures.push('Trial 1: owner not forwarded')
  if (lastCall?.repo  !== 'site')          failures.push('Trial 1: repo not forwarded')

  // Trial 2: result has deleted=true and echoes path
  const r2 = await execute({ path: 'tmp/scratch.js' }, makeConfig())
  if (!r2.deleted)                  failures.push('Trial 2: deleted should be true')
  if (r2.path !== 'tmp/scratch.js') failures.push('Trial 2: path not echoed in result')

  // Trial 3: default commit message contains the file path
  await execute({ path: 'src/old.js' }, makeConfig())
  if (!lastCall?.message.includes('src/old.js')) failures.push(`Trial 3: default message missing path, got "${lastCall?.message}"`)

  // Trial 4: custom commit message used verbatim
  await execute({ path: 'f.js', message: 'chore: remove deprecated module' }, makeConfig())
  if (lastCall?.message !== 'chore: remove deprecated module') failures.push(`Trial 4: custom message not used, got "${lastCall?.message}"`)

  // Trial 5: branch forwarded
  await execute({ path: 'f.js' }, makeConfig())
  if (lastCall?.branch !== 'main') failures.push(`Trial 5: branch not forwarded, got "${lastCall?.branch}"`)

  // Trial 6: missing path throws
  try {
    await execute({}, makeConfig())
    failures.push('Trial 6: should throw for missing path')
  } catch (e) {
    if (!e.message.includes('path')) failures.push(`Trial 6: wrong error: ${e.message}`)
  }

  // Trial 7: missing deleteFile throws
  try {
    await execute({ path: 'f.js' }, { repoOwner: 'x', repoName: 'y', baseBranch: 'main', githubToken: '' })
    failures.push('Trial 7: should throw for missing deleteFile')
  } catch (e) {
    if (!e.message.includes('deleteFile')) failures.push(`Trial 7: wrong error: ${e.message}`)
  }

  if (failures.length) return { passed: false, message: failures.join(' | ') }
  return { passed: true, message: 'All 7 trials passed (forwarding, result shape, default message, custom message, error guards).' }
}
