// ─── create-pull-request tool ─────────────────────────────────────────────────
export const toolMeta = {
  id: 'create-pull-request',
  name: 'Create Pull Request',
  version: '1.0.0',
  description: 'Create a GitHub pull request from the current working branch to the base branch.',
  category: 'coding',
  author: 'ICARUS',
}

export async function execute(input, config = {}) {
  const { title, body = '', head, base } = input
  if (!title) throw new Error('title is required')
  if (!head)  throw new Error('head (source branch) is required')
  if (!base)  throw new Error('base (target branch) is required')

  const { createPullRequest, repoOwner, repoName, githubToken } = config
  if (!createPullRequest) throw new Error('createPullRequest not provided in config')

  const pr = await createPullRequest({ owner: repoOwner, repo: repoName, title, body, head, base, token: githubToken })
  return { url: pr.url, number: pr.number, title }
}

export async function test() {
  const failures = []
  let lastCall = null

  function makeConfig(overrides = {}) {
    lastCall = null
    return {
      createPullRequest: async (args) => {
        lastCall = args
        return { url: 'https://github.com/acme/repo/pull/42', number: 42, ...overrides }
      },
      repoOwner: 'acme', repoName: 'repo', githubToken: 'tok',
    }
  }

  // Trial 1: all params forwarded correctly
  await execute({ title: 'feat: new feature', head: 'feature/x', base: 'main', body: 'Adds X' }, makeConfig())
  if (lastCall?.title !== 'feat: new feature') failures.push('Trial 1: title not forwarded')
  if (lastCall?.head  !== 'feature/x')         failures.push('Trial 1: head not forwarded')
  if (lastCall?.base  !== 'main')              failures.push('Trial 1: base not forwarded')
  if (lastCall?.body  !== 'Adds X')            failures.push('Trial 1: body not forwarded')
  if (lastCall?.owner !== 'acme')              failures.push('Trial 1: owner not forwarded')
  if (lastCall?.repo  !== 'repo')              failures.push('Trial 1: repo not forwarded')

  // Trial 2: result shape contains url, number, title
  const r2 = await execute({ title: 'fix: bug', head: 'fix/bug', base: 'main' }, makeConfig())
  if (!r2.url?.startsWith('https://')) failures.push('Trial 2: url missing or invalid')
  if (typeof r2.number !== 'number')   failures.push('Trial 2: number should be numeric')
  if (r2.title !== 'fix: bug')         failures.push('Trial 2: title not in result')

  // Trial 3: empty body defaults to empty string (not undefined)
  await execute({ title: 'chore: update', head: 'chore/up', base: 'main' }, makeConfig())
  if (lastCall?.body !== '') failures.push(`Trial 3: body should default to empty string, got "${lastCall?.body}"`)

  // Trial 4: missing title throws
  try {
    await execute({ head: 'f', base: 'main' }, makeConfig())
    failures.push('Trial 4: should throw for missing title')
  } catch (e) {
    if (!e.message.includes('title')) failures.push(`Trial 4: wrong error: ${e.message}`)
  }

  // Trial 5: missing head throws
  try {
    await execute({ title: 'x', base: 'main' }, makeConfig())
    failures.push('Trial 5: should throw for missing head')
  } catch (e) {
    if (!e.message.includes('head')) failures.push(`Trial 5: wrong error: ${e.message}`)
  }

  // Trial 6: missing base throws
  try {
    await execute({ title: 'x', head: 'f' }, makeConfig())
    failures.push('Trial 6: should throw for missing base')
  } catch (e) {
    if (!e.message.includes('base')) failures.push(`Trial 6: wrong error: ${e.message}`)
  }

  // Trial 7: missing createPullRequest throws
  try {
    await execute({ title: 'x', head: 'f', base: 'main' }, { repoOwner: 'x', repoName: 'y', githubToken: '' })
    failures.push('Trial 7: should throw for missing createPullRequest')
  } catch (e) {
    if (!e.message.includes('createPullRequest')) failures.push(`Trial 7: wrong error: ${e.message}`)
  }

  if (failures.length) return { passed: false, message: failures.join(' | ') }
  return { passed: true, message: 'All 7 trials passed (param forwarding, result shape, default body, error guards).' }
}
