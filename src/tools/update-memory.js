// ─── update-memory tool ───────────────────────────────────────────────────────
export const toolMeta = {
  id: 'update-memory',
  name: 'Update Memory',
  version: '1.0.0',
  description: 'Append a persistent note to BLUSWAN.md in the repository root for cross-session memory.',
  category: 'utility',
  author: 'BLUSWAN',
}

export async function execute(input, config = {}) {
  const { note } = input
  if (!note) throw new Error('note is required')

  const { getFileContent, createOrUpdateFile, repoOwner, repoName, baseBranch, githubToken } = config
  if (!getFileContent || !createOrUpdateFile) throw new Error('getFileContent and createOrUpdateFile required in config')

  let existing = ''
  try {
    existing = await getFileContent({ owner: repoOwner, repo: repoName, path: 'BLUSWAN.md', branch: baseBranch, token: githubToken })
  } catch { /* file may not exist yet */ }

  const timestamp = new Date().toISOString().split('T')[0]
  const updated = existing
    ? `${existing.trimEnd()}\n\n<!-- ${timestamp} -->\n${note}`
    : `<!-- ${timestamp} -->\n${note}`

  await createOrUpdateFile({ owner: repoOwner, repo: repoName, path: 'BLUSWAN.md', content: updated, message: 'Update BLUSWAN.md', branch: baseBranch, token: githubToken })
  return { appended: true, note }
}

export async function test() {
  const failures = []
  let lastWritten = null

  function makeConfig(existingContent, throwOnRead = false) {
    lastWritten = null
    return {
      getFileContent: async () => {
        if (throwOnRead) throw new Error('file not found')
        return existingContent
      },
      createOrUpdateFile: async ({ content }) => { lastWritten = content },
      repoOwner: 'test', repoName: 'repo', baseBranch: 'main', githubToken: '',
    }
  }

  // Trial 1: note is appended after existing content
  await execute({ note: 'Use Vite for bundling.' }, makeConfig('# Existing notes\n\nSome prior text.'))
  if (!lastWritten?.includes('Use Vite for bundling.')) failures.push('Trial 1: note not in output')
  if (!lastWritten?.includes('# Existing notes'))      failures.push('Trial 1: existing content was lost')

  // Trial 2: existing content comes before new note
  const lines2 = lastWritten?.split('\n') || []
  const existingIdx = lines2.findIndex(l => l.includes('Existing'))
  const noteIdx     = lines2.findIndex(l => l.includes('Use Vite'))
  if (existingIdx >= noteIdx) failures.push('Trial 2: existing content should appear before new note')

  // Trial 3: timestamp header is injected between old and new content
  const today = new Date().toISOString().split('T')[0]
  if (!lastWritten?.includes(`<!-- ${today} -->`)) failures.push(`Trial 3: timestamp header missing (expected <!-- ${today} -->)`)

  // Trial 4: fresh file (read throws) — note becomes the entire content
  await execute({ note: 'First ever note.' }, makeConfig('', true))
  if (!lastWritten?.startsWith('<!-- '))         failures.push('Trial 4: fresh file should start with timestamp header')
  if (!lastWritten?.includes('First ever note')) failures.push('Trial 4: note missing in fresh file')

  // Trial 5: multiple appends accumulate correctly
  await execute({ note: 'Note A' }, makeConfig('# Base'))
  const afterA = lastWritten
  await execute({ note: 'Note B' }, makeConfig(afterA))
  if (!lastWritten?.includes('Note A')) failures.push('Trial 5: Note A was lost after Note B appended')
  if (!lastWritten?.includes('Note B')) failures.push('Trial 5: Note B missing')
  if (!lastWritten?.includes('# Base')) failures.push('Trial 5: original base content lost')

  // Trial 6: always writes to BLUSWAN.md specifically
  let writtenPath = null
  await execute({ note: 'x' }, {
    getFileContent: async () => '',
    createOrUpdateFile: async ({ path }) => { writtenPath = path },
    repoOwner: 'test', repoName: 'repo', baseBranch: 'main', githubToken: '',
  })
  if (writtenPath !== 'BLUSWAN.md') failures.push(`Trial 6: should write to BLUSWAN.md, got "${writtenPath}"`)

  // Trial 7: missing note throws
  try {
    await execute({}, makeConfig(''))
    failures.push('Trial 7: should throw for missing note')
  } catch (e) {
    if (!e.message.includes('note')) failures.push(`Trial 7: wrong error: ${e.message}`)
  }

  if (failures.length) return { passed: false, message: failures.join(' | ') }
  return { passed: true, message: 'All 7 trials passed (append, order, timestamp, fresh file, accumulation, path, error guard).' }
}
