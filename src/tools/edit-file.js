// ─── edit-file tool ───────────────────────────────────────────────────────────
export const toolMeta = {
  id: 'edit-file',
  name: 'Edit File',
  version: '1.0.0',
  description: 'Surgically replace an exact string in a file. Preferred over write-file for small changes.',
  category: 'coding',
  author: 'ICARUS',
}

export async function execute(input, config = {}) {
  const { path, old_str, new_str, message } = input
  if (!path)    throw new Error('path is required')
  if (!old_str) throw new Error('old_str is required')
  if (new_str === undefined || new_str === null) throw new Error('new_str is required')
  const { getFileContent, createOrUpdateFile, repoOwner, repoName, baseBranch, githubToken } = config
  if (!getFileContent || !createOrUpdateFile) throw new Error('getFileContent and createOrUpdateFile are required in config')

  const original = await getFileContent({ owner: repoOwner, repo: repoName, path, branch: baseBranch, token: githubToken })
  if (!original.includes(old_str)) throw new Error(`old_str not found in ${path}`)
  const updated = original.replace(old_str, new_str)
  const commitMsg = message || `Edit ${path}`
  await createOrUpdateFile({ owner: repoOwner, repo: repoName, path, content: updated, message: commitMsg, branch: baseBranch, token: githubToken })
  return { path, edited: true, message: commitMsg }
}

export async function test() {
  const failures = []

  // ── helpers ──────────────────────────────────────────────────────────────
  let lastWritten = null
  function makeConfig(fileContent) {
    lastWritten = null
    return {
      getFileContent: async () => fileContent,
      createOrUpdateFile: async ({ content }) => { lastWritten = content },
      repoOwner: 'test', repoName: 'repo', baseBranch: 'main', githubToken: '',
    }
  }

  // Trial 1: replacement actually appears in the written content
  const src1 = 'const version = "1.0.0"\nconst name = "icarus"\n'
  await execute({ path: 'package.js', old_str: '"1.0.0"', new_str: '"2.0.0"' }, makeConfig(src1))
  if (!lastWritten?.includes('"2.0.0"')) failures.push('Trial 1: new_str not in written content')
  if (lastWritten?.includes('"1.0.0"'))  failures.push('Trial 1: old_str still present after replacement')

  // Trial 2: surrounding content preserved
  const src2 = 'line1\nTARGET_LINE\nline3\n'
  await execute({ path: 'f.js', old_str: 'TARGET_LINE', new_str: 'REPLACED_LINE' }, makeConfig(src2))
  if (!lastWritten?.includes('line1'))          failures.push('Trial 2: line before target was lost')
  if (!lastWritten?.includes('REPLACED_LINE'))  failures.push('Trial 2: replacement missing')
  if (!lastWritten?.includes('line3'))          failures.push('Trial 2: line after target was lost')

  // Trial 3: multi-line old_str replacement
  const src3 = 'function foo() {\n  return 1\n}\n'
  await execute({ path: 'f.js', old_str: 'function foo() {\n  return 1\n}', new_str: 'function foo() {\n  return 42\n}' }, makeConfig(src3))
  if (!lastWritten?.includes('return 42')) failures.push('Trial 3: multi-line replacement failed')

  // Trial 4: empty string replacement (deletion)
  const src4 = 'keep this // REMOVE THIS COMMENT\nkeep this too\n'
  await execute({ path: 'f.js', old_str: ' // REMOVE THIS COMMENT', new_str: '' }, makeConfig(src4))
  if (lastWritten?.includes('REMOVE'))    failures.push('Trial 4: deletion did not remove old_str')
  if (!lastWritten?.includes('keep this')) failures.push('Trial 4: deletion removed surrounding content')

  // Trial 5: old_str not found → throws with descriptive error
  try {
    await execute({ path: 'f.js', old_str: 'DEFINITELY_NOT_IN_FILE', new_str: 'x' }, makeConfig('hello world'))
    failures.push('Trial 5: should have thrown for missing old_str')
  } catch (e) {
    if (!e.message.includes('not found')) failures.push(`Trial 5: wrong error message: "${e.message}"`)
  }

  // Trial 6: commit message defaults to "Edit <path>"
  await execute({ path: 'src/app.js', old_str: 'foo', new_str: 'bar' }, makeConfig('foo'))
  const r6 = await execute({ path: 'src/app.js', old_str: 'bar', new_str: 'baz' }, {
    getFileContent: async () => 'bar',
    createOrUpdateFile: async ({ message }) => { lastWritten = message },
    repoOwner: 'test', repoName: 'repo', baseBranch: 'main', githubToken: '',
  })
  if (!r6.message.includes('src/app.js')) failures.push(`Trial 6: default commit message missing path, got "${r6.message}"`)

  // Trial 7: missing path param throws
  try {
    await execute({ old_str: 'x', new_str: 'y' }, makeConfig('x'))
    failures.push('Trial 7: should have thrown for missing path')
  } catch (e) {
    if (!e.message.includes('path')) failures.push(`Trial 7: wrong error: ${e.message}`)
  }

  // Trial 8: missing old_str param throws
  try {
    await execute({ path: 'f.js', new_str: 'y' }, makeConfig('x'))
    failures.push('Trial 8: should have thrown for missing old_str')
  } catch (e) {
    if (!e.message.includes('old_str')) failures.push(`Trial 8: wrong error: ${e.message}`)
  }

  if (failures.length) return { passed: false, message: failures.join(' | ') }
  return { passed: true, message: 'All 8 trials passed (replacement, multi-line, deletion, error guards, default commit message).' }
}
