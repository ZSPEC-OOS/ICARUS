// ─── read-file tool ───────────────────────────────────────────────────────────
export const toolMeta = {
  id: 'read-file',
  name: 'Read File',
  version: '1.0.0',
  description: 'Read the contents of a file from the connected GitHub repository, with optional line range.',
  category: 'coding',
  author: 'ICARUS',
}

export async function execute(input, config = {}) {
  const { path, start_line, end_line } = input
  if (!path) throw new Error('path is required')
  const { getFileContent, repoOwner, repoName, baseBranch, githubToken } = config
  if (!getFileContent) throw new Error('getFileContent not provided in config')
  const raw = await getFileContent({ owner: repoOwner, repo: repoName, path, branch: baseBranch, token: githubToken })
  let content = raw
  if ((start_line || end_line) && typeof raw === 'string') {
    const lines = raw.split('\n')
    const s = (start_line || 1) - 1
    const e = end_line ? end_line : lines.length
    content = lines.slice(s, e).join('\n')
  }
  return { path, content }
}

export async function test() {
  const TEN_LINES = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n')
  const failures = []

  function makeConfig(content) {
    return {
      getFileContent: async ({ path }) => content,
      repoOwner: 'test', repoName: 'repo', baseBranch: 'main', githubToken: '',
    }
  }

  // Trial 1: full file returned when no range given
  const r1 = await execute({ path: 'src/app.js' }, makeConfig(TEN_LINES))
  if (r1.content !== TEN_LINES) failures.push('Trial 1: full content mismatch')
  if (r1.path !== 'src/app.js')  failures.push('Trial 1: path not echoed in result')

  // Trial 2: start_line only — returns from line 5 to end
  const r2 = await execute({ path: 'f.js', start_line: 5 }, makeConfig(TEN_LINES))
  const lines2 = r2.content.split('\n')
  if (!lines2[0].includes('line5')) failures.push(`Trial 2: first line should be line5, got "${lines2[0]}"`)
  if (!lines2[lines2.length - 1].includes('line10')) failures.push(`Trial 2: last line should be line10, got "${lines2[lines2.length - 1]}"`)

  // Trial 3: end_line only — returns from line 1 to 3
  const r3 = await execute({ path: 'f.js', end_line: 3 }, makeConfig(TEN_LINES))
  const lines3 = r3.content.split('\n')
  if (lines3.length !== 3) failures.push(`Trial 3: expected 3 lines, got ${lines3.length}`)
  if (!lines3[2].includes('line3')) failures.push(`Trial 3: last line should be line3, got "${lines3[2]}"`)

  // Trial 4: start_line + end_line — slice out lines 3–5
  const r4 = await execute({ path: 'f.js', start_line: 3, end_line: 5 }, makeConfig(TEN_LINES))
  const lines4 = r4.content.split('\n')
  if (lines4.length !== 3) failures.push(`Trial 4: expected 3 lines, got ${lines4.length}`)
  if (!lines4[0].includes('line3')) failures.push(`Trial 4: should start at line3, got "${lines4[0]}"`)
  if (!lines4[2].includes('line5')) failures.push(`Trial 4: should end at line5, got "${lines4[2]}"`)

  // Trial 5: single line (start=end)
  const r5 = await execute({ path: 'f.js', start_line: 7, end_line: 7 }, makeConfig(TEN_LINES))
  if (r5.content.trim() !== 'line7') failures.push(`Trial 5: single line should be "line7", got "${r5.content}"`)

  // Trial 6: missing path throws
  try {
    await execute({}, makeConfig(TEN_LINES))
    failures.push('Trial 6: should have thrown for missing path')
  } catch (e) {
    if (!e.message.includes('path')) failures.push(`Trial 6: wrong error: ${e.message}`)
  }

  // Trial 7: missing getFileContent throws
  try {
    await execute({ path: 'f.js' }, { repoOwner: 'x', repoName: 'y', baseBranch: 'main', githubToken: '' })
    failures.push('Trial 7: should have thrown for missing getFileContent')
  } catch (e) {
    if (!e.message.includes('getFileContent')) failures.push(`Trial 7: wrong error: ${e.message}`)
  }

  if (failures.length) return { passed: false, message: failures.join(' | ') }
  return { passed: true, message: 'All 7 trials passed (full read, start-only, end-only, range, single line, error guards).' }
}
