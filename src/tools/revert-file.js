// ─── revert-file tool ─────────────────────────────────────────────────────────
export const toolMeta = {
  id: 'revert-file',
  name: 'Revert File',
  version: '1.0.0',
  description: 'Restore a file to its state before the last N commits that touched it.',
  category: 'coding',
  author: 'ICARUS',
}

export async function execute(input, config = {}) {
  const { path, commits_back = 1, message } = input
  if (!path) throw new Error('path is required')
  if (commits_back > 10) throw new Error('commits_back max is 10')

  const { getFileCommitHistory, getFileContent, createOrUpdateFile, repoOwner, repoName, baseBranch, githubToken } = config
  if (!getFileCommitHistory || !getFileContent || !createOrUpdateFile) {
    throw new Error('getFileCommitHistory, getFileContent, and createOrUpdateFile required in config')
  }

  const commits = await getFileCommitHistory({ owner: repoOwner, repo: repoName, path, branch: baseBranch, token: githubToken })
  const targetCommit = commits[commits_back]
  if (!targetCommit) throw new Error(`Not enough commit history (found ${commits.length} commits)`)

  const oldContent = await getFileContent({ owner: repoOwner, repo: repoName, path, ref: targetCommit.sha, token: githubToken })
  const commitMsg = message || `Revert ${path} to ${commits_back} commit(s) back`
  await createOrUpdateFile({ owner: repoOwner, repo: repoName, path, content: oldContent, message: commitMsg, branch: baseBranch, token: githubToken })

  return { path, reverted: true, to_sha: targetCommit.sha, message: commitMsg }
}

export async function test() {
  const failures = []

  const HISTORY = [
    { sha: 'aaa111', message: 'latest' },   // index 0 = current
    { sha: 'bbb222', message: 'prev 1' },   // index 1 = 1 back
    { sha: 'ccc333', message: 'prev 2' },   // index 2 = 2 back
    { sha: 'ddd444', message: 'prev 3' },   // index 3 = 3 back
  ]
  const FILE_AT = {
    bbb222: 'content at bbb222',
    ccc333: 'content at ccc333',
    ddd444: 'content at ddd444',
  }

  let lastWrite = null
  function makeConfig() {
    lastWrite = null
    return {
      getFileCommitHistory: async () => HISTORY,
      getFileContent: async ({ ref }) => FILE_AT[ref] || 'unknown',
      createOrUpdateFile: async (args) => { lastWrite = args },
      repoOwner: 'test', repoName: 'repo', baseBranch: 'main', githubToken: '',
    }
  }

  // Trial 1: commits_back=1 restores from index [1] (bbb222)
  const r1 = await execute({ path: 'src/app.js', commits_back: 1 }, makeConfig())
  if (r1.to_sha !== 'bbb222')                  failures.push(`Trial 1: expected bbb222, got "${r1.to_sha}"`)
  if (lastWrite?.content !== 'content at bbb222') failures.push('Trial 1: wrong content written')

  // Trial 2: commits_back=2 restores from index [2] (ccc333)
  const r2 = await execute({ path: 'src/app.js', commits_back: 2 }, makeConfig())
  if (r2.to_sha !== 'ccc333') failures.push(`Trial 2: expected ccc333, got "${r2.to_sha}"`)

  // Trial 3: commits_back=3 restores from index [3] (ddd444)
  const r3 = await execute({ path: 'src/app.js', commits_back: 3 }, makeConfig())
  if (r3.to_sha !== 'ddd444') failures.push(`Trial 3: expected ddd444, got "${r3.to_sha}"`)

  // Trial 4: default commits_back is 1
  const r4 = await execute({ path: 'src/app.js' }, makeConfig())
  if (r4.to_sha !== 'bbb222') failures.push(`Trial 4: default commits_back should be 1, got sha "${r4.to_sha}"`)

  // Trial 5: not enough history throws descriptive error
  try {
    await execute({ path: 'src/app.js', commits_back: 5 }, {
      getFileCommitHistory: async () => [{ sha: 'only' }, { sha: 'two' }],
      getFileContent: async () => '',
      createOrUpdateFile: async () => {},
      repoOwner: 'test', repoName: 'repo', baseBranch: 'main', githubToken: '',
    })
    failures.push('Trial 5: should have thrown for insufficient history')
  } catch (e) {
    if (!e.message.includes('commit')) failures.push(`Trial 5: wrong error: ${e.message}`)
  }

  // Trial 6: commits_back > 10 throws immediately (guard before API call)
  try {
    await execute({ path: 'f.js', commits_back: 11 }, makeConfig())
    failures.push('Trial 6: should throw for commits_back > 10')
  } catch (e) {
    if (!e.message.includes('10')) failures.push(`Trial 6: wrong error: ${e.message}`)
  }

  // Trial 7: custom commit message is forwarded
  await execute({ path: 'src/app.js', commits_back: 1, message: 'revert: undo bad refactor' }, makeConfig())
  if (lastWrite?.message !== 'revert: undo bad refactor') failures.push(`Trial 7: custom message not forwarded, got "${lastWrite?.message}"`)

  // Trial 8: default commit message mentions the path
  await execute({ path: 'src/app.js', commits_back: 1 }, makeConfig())
  if (!lastWrite?.message.includes('src/app.js')) failures.push(`Trial 8: default message missing path, got "${lastWrite?.message}"`)

  if (failures.length) return { passed: false, message: failures.join(' | ') }
  return { passed: true, message: 'All 8 trials passed (index selection, default, insufficient history, max guard, commit messages).' }
}
