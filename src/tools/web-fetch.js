// ─── web-fetch tool ───────────────────────────────────────────────────────────
export const toolMeta = {
  id: 'web-fetch',
  name: 'Web Fetch',
  version: '1.0.0',
  description: 'Fetch a URL and return its text content. Best for reading documentation, API specs, or raw files.',
  category: 'utility',
  author: 'BLUSWAN',
}

export async function execute(input, config = {}) {
  const { url } = input
  if (!url) throw new Error('url is required')
  if (!url.startsWith('http')) throw new Error('url must start with http:// or https://')

  const { callExecBridge } = config

  // If exec bridge is available, use it for HTML-to-text conversion
  if (callExecBridge) {
    const { stdout, exitCode } = await callExecBridge(
      `curl -sL --max-time 15 "${url.replace(/"/g, '\\"')}"`,
    )
    if (exitCode !== 0) throw new Error(`Fetch failed (exit ${exitCode})`)
    return { url, content: stdout }
  }

  // Fallback: browser fetch
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
  const text = await res.text()
  return { url, content: text }
}

export async function test() {
  const failures = []

  // Trial 1: missing url throws
  try {
    await execute({})
    failures.push('Trial 1: should throw for missing url')
  } catch (e) {
    if (!e.message.includes('url')) failures.push(`Trial 1: wrong error: ${e.message}`)
  }

  // Trial 2: non-http url throws
  try {
    await execute({ url: 'ftp://example.com/file' })
    failures.push('Trial 2: should throw for non-http url')
  } catch (e) {
    if (!e.message.includes('http')) failures.push(`Trial 2: wrong error: ${e.message}`)
  }

  // Trial 3: exec bridge path — content and url echoed correctly
  const r3 = await execute(
    { url: 'https://example.com' },
    { callExecBridge: async () => ({ stdout: '<html><body>Hello World</body></html>', exitCode: 0 }) },
  )
  if (r3.url !== 'https://example.com') failures.push('Trial 3: url not echoed')
  if (!r3.content.includes('Hello World')) failures.push('Trial 3: content not returned from bridge')

  // Trial 4: exec bridge non-zero exit throws
  try {
    await execute(
      { url: 'https://example.com' },
      { callExecBridge: async () => ({ stdout: '', exitCode: 1 }) },
    )
    failures.push('Trial 4: should throw on non-zero exit code')
  } catch (e) {
    if (!e.message.includes('exit')) failures.push(`Trial 4: wrong error: ${e.message}`)
  }

  // Trial 5: live browser fetch — actually call a reliable public endpoint
  try {
    const r5 = await execute({ url: 'https://api.github.com' })
    if (!r5.content || r5.content.length < 10) {
      failures.push('Trial 5: live fetch returned empty content')
    } else if (!r5.url.startsWith('https://')) {
      failures.push('Trial 5: url not echoed from live fetch')
    }
    // Verify response looks like GitHub API JSON
    try {
      const parsed = JSON.parse(r5.content)
      if (typeof parsed !== 'object') failures.push('Trial 5: GitHub API response is not JSON object')
    } catch {
      failures.push('Trial 5: GitHub API response could not be parsed as JSON')
    }
  } catch (e) {
    failures.push(`Trial 5: live fetch threw: ${e.message}`)
  }

  if (failures.length) return { passed: false, message: failures.join(' | ') }
  return { passed: true, message: 'All 5 trials passed (url guard, protocol guard, bridge path, bridge error, live HTTP fetch to api.github.com).' }
}
