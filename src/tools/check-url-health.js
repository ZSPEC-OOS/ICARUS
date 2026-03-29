// ─── check-url-health tool ───────────────────────────────────────────────────
export const toolMeta = {
  id: 'check-url-health',
  name: 'Check URL Health',
  version: '1.0.0',
  description: 'Probe a URL with timeout handling and return status, latency, and basic diagnostics.',
  category: 'utility',
  author: 'LOGIK',
}

export async function execute(input = {}, config = {}) {
  const { url, timeout_ms = 8000, method = 'GET' } = input
  if (!url) throw new Error('url is required')

  const fetchImpl = config.fetchImpl || fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.max(500, Math.min(timeout_ms, 30000)))
  const started = Date.now()

  try {
    const res = await fetchImpl(url, { method, signal: controller.signal })
    const latencyMs = Date.now() - started
    return {
      url,
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      latencyMs,
      redirected: res.redirected,
      finalUrl: res.url,
    }
  } catch (err) {
    return {
      url,
      ok: false,
      status: 0,
      error: err.name === 'AbortError' ? 'timeout' : err.message,
      latencyMs: Date.now() - started,
    }
  } finally {
    clearTimeout(timeout)
  }
}

export async function test() {
  const failures = []

  const okFetch = async () => ({ ok: true, status: 200, statusText: 'OK', redirected: false, url: 'https://x.dev' })
  const r1 = await execute({ url: 'https://x.dev' }, { fetchImpl: okFetch })
  if (!r1.ok || r1.status !== 200) failures.push('Trial 1: success response not mapped')

  const errFetch = async () => { throw new Error('network down') }
  const r2 = await execute({ url: 'https://x.dev' }, { fetchImpl: errFetch })
  if (r2.ok || r2.status !== 0 || !r2.error.includes('network')) failures.push('Trial 2: error response not mapped')

  try {
    await execute({}, { fetchImpl: okFetch })
    failures.push('Trial 3: missing url should throw')
  } catch (e) {
    if (!e.message.includes('url')) failures.push(`Trial 3: wrong error: ${e.message}`)
  }

  if (failures.length) return { passed: false, message: failures.join(' | ') }
  return { passed: true, message: 'All 3 trials passed (success path, error path, input guard).' }
}
