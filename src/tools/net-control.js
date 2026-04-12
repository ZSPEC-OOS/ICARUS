// ─── net-control tool ─────────────────────────────────────────────────────────
export const toolMeta = {
  id: 'net-control',
  name: 'NetControl',
  version: '1.0.0',
  description: 'Run network control checks: DNS resolve, TCP port probe, and HTTP reachability.',
  category: 'utility',
  author: 'BLUSWAN',
}

function normalizeMode(mode) {
  return String(mode || 'http').trim().toLowerCase()
}

function clampTimeout(timeoutMs) {
  const n = Number(timeoutMs)
  if (!Number.isFinite(n)) return 8000
  return Math.max(500, Math.min(30000, Math.round(n)))
}

export async function execute(input = {}, config = {}) {
  const mode = normalizeMode(input.mode)
  const timeoutMs = clampTimeout(input.timeout_ms)
  const url = typeof input.url === 'string' ? input.url.trim() : ''
  const host = typeof input.host === 'string' ? input.host.trim() : ''
  const port = Number(input.port)

  const callExecBridge = config.callExecBridge
  const fetchImpl = config.fetchImpl || fetch

  if (mode === 'http') {
    if (!url) throw new Error('url is required for mode="http"')
    if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http:// or https://')

    const started = Date.now()
    const res = await fetchImpl(url, { method: 'GET' })
    return {
      mode,
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      latencyMs: Date.now() - started,
      target: url,
    }
  }

  if (!host) throw new Error('host is required for non-http modes')

  if (!callExecBridge) {
    throw new Error('mode requires exec bridge support in this environment')
  }

  if (mode === 'dns') {
    const cmd = `getent hosts "${host.replace(/"/g, '\\"')}"`
    const { stdout, stderr, exitCode } = await callExecBridge(cmd)
    return {
      mode,
      ok: exitCode === 0,
      target: host,
      output: (stdout || stderr || '').trim(),
      exitCode,
    }
  }

  if (mode === 'tcp') {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('port must be an integer between 1 and 65535 for mode="tcp"')
    }
    const safeHost = host.replace(/"/g, '\\"')
    const cmd = `timeout ${Math.ceil(timeoutMs / 1000)} bash -lc 'echo > /dev/tcp/${safeHost}/${port}'`
    const { stdout, stderr, exitCode } = await callExecBridge(cmd)
    return {
      mode,
      ok: exitCode === 0,
      target: `${host}:${port}`,
      output: (stdout || stderr || '').trim(),
      exitCode,
      timeoutMs,
    }
  }

  throw new Error('mode must be one of: http, dns, tcp')
}

export async function test() {
  const failures = []

  const http = await execute(
    { mode: 'http', url: 'https://api.github.com' },
    { fetchImpl: async () => ({ ok: true, status: 200, statusText: 'OK' }) },
  )
  if (!Number.isInteger(http.status) || !http.target) failures.push('HTTP mode returned invalid response shape')

  const dns = await execute(
    { mode: 'dns', host: 'example.com' },
    { callExecBridge: async () => ({ stdout: '93.184.216.34 example.com', stderr: '', exitCode: 0 }) },
  )
  if (!dns.ok || !dns.output.includes('example.com')) failures.push('DNS mode bridge mapping failed')

  try {
    await execute({ mode: 'tcp', host: 'localhost', port: 70000 }, { callExecBridge: async () => ({ stdout: '', stderr: '', exitCode: 0 }) })
    failures.push('TCP mode should reject invalid port')
  } catch (err) {
    if (!String(err.message).includes('port')) failures.push(`TCP guard gave wrong error: ${err.message}`)
  }

  if (failures.length) return { passed: false, message: failures.join(' | ') }
  return { passed: true, message: 'NetControl self-test passed (http, dns, and tcp validation).' }
}
