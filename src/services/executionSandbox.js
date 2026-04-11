// ─── Execution Sandbox Abstraction ───────────────────────────────────────────
// Unified interface for command execution across multiple backends.
//
// Backends (selected by VITE_EXEC_BACKEND env var, or auto-detected):
//   vite       — Vite dev-server /api/exec plugin (default in dev)
//   e2b        — E2B.dev cloud sandbox (requires VITE_E2B_API_KEY)
//   docker     — Local Docker Engine HTTP API (requires VITE_DOCKER_CONTAINER)
//   subprocess — Node.js relay server (requires VITE_EXEC_RELAY, for CLI mode)
//   none       — Explicit no-op; all calls fail gracefully
//
// Auto-detection probes backends in priority order: vite → e2b → docker → subprocess.
//
// Provider interface:
//   probe()                            → Promise<boolean>
//   exec(cmd, opts)                    → Promise<{stdout, stderr, exitCode}>
//   execStream(cmd, opts, onChunk)     → Promise<{exitCode, output}>

import { EXEC_BRIDGE_TIMEOUT_MS } from '../config/constants.js'

// ── ViteBridgeProvider ────────────────────────────────────────────────────────
// Routes to the Vite dev-server exec plugin at /api/exec and /api/exec-stream.
// This is the default provider in development.
class ViteBridgeProvider {
  async probe() {
    try {
      const r = await fetch('/api/exec')
      const d = r.ok ? await r.json() : null
      return !!(d?.ok)
    } catch { return false }
  }

  async exec(cmd, { cwd, timeout = EXEC_BRIDGE_TIMEOUT_MS, stdin } = {}) {
    try {
      const res = await fetch('/api/exec', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ cmd, cwd, timeout, stdin }),
      })
      if (!res.ok) throw new Error(`bridge HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      return { stdout: '', stderr: err.message, exitCode: 1 }
    }
  }

  async execStream(cmd, { cwd, timeout = EXEC_BRIDGE_TIMEOUT_MS } = {}, onChunk) {
    try {
      const res = await fetch('/api/exec-stream', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ cmd, cwd, timeout }),
      })
      if (!res.ok) return { exitCode: 1, output: `bridge HTTP ${res.status}` }

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = '', output = '', exitCode = 0

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop()
        for (const chunk of parts) {
          const line = chunk.trim()
          if (!line.startsWith('data: ')) continue
          try {
            const { type, data } = JSON.parse(line.slice(6))
            if (type === 'stdout' || type === 'stderr') { output += (data ?? ''); onChunk?.(data ?? '', type) }
            else if (type === 'done')  exitCode = data ?? 0
            else if (type === 'error') { output += (data ?? ''); onChunk?.(data ?? '', 'stderr') }
          } catch {}
        }
      }
      return { exitCode, output }
    } catch (err) {
      return { exitCode: 1, output: err.message }
    }
  }
}

// ── E2BProvider ───────────────────────────────────────────────────────────────
// Routes to an E2B.dev cloud sandbox for production-grade isolated execution.
// Requires VITE_E2B_API_KEY to be set; @e2b/code-interpreter must be installed.
class E2BProvider {
  constructor() {
    this._sandbox = null
    this._Sandbox = null
    this._apiKey  = (typeof import.meta !== 'undefined' ? import.meta.env?.VITE_E2B_API_KEY : null) || ''
  }

  async probe() {
    if (!this._apiKey) return false
    try {
      const mod = await import('@e2b/code-interpreter')
      this._Sandbox = mod.Sandbox
      return true
    } catch { return false }
  }

  async _getSandbox() {
    if (this._sandbox) return this._sandbox
    this._sandbox = await this._Sandbox.create({ apiKey: this._apiKey })
    return this._sandbox
  }

  async exec(cmd, { timeout = EXEC_BRIDGE_TIMEOUT_MS } = {}) {
    try {
      const sb     = await this._getSandbox()
      const result = await sb.process.startAndWait(cmd, { timeout })
      return {
        stdout:   result.stdout  || '',
        stderr:   result.stderr  || '',
        exitCode: result.exitCode ?? 0,
      }
    } catch (err) {
      return { stdout: '', stderr: err.message, exitCode: 1 }
    }
  }

  async execStream(cmd, { timeout = EXEC_BRIDGE_TIMEOUT_MS } = {}, onChunk) {
    try {
      const sb = await this._getSandbox()
      let output = '', exitCode = 0
      const proc = await sb.process.start(cmd, {
        timeout,
        onStdout: (data) => { output += data; onChunk?.(data, 'stdout') },
        onStderr: (data) => { output += data; onChunk?.(data, 'stderr') },
      })
      exitCode = (await proc.wait()).exitCode ?? 0
      return { exitCode, output }
    } catch (err) {
      return { exitCode: 1, output: err.message }
    }
  }
}

// ── DockerProvider ────────────────────────────────────────────────────────────
// Routes commands to a named Docker container via the Docker Engine HTTP API.
// Requires VITE_DOCKER_CONTAINER (container name/id) and optionally
// VITE_DOCKER_HOST (default: http://localhost:2375).
class DockerProvider {
  constructor() {
    this._host      = (typeof import.meta !== 'undefined' ? import.meta.env?.VITE_DOCKER_HOST : null) || 'http://localhost:2375'
    this._container = (typeof import.meta !== 'undefined' ? import.meta.env?.VITE_DOCKER_CONTAINER : null) || ''
  }

  async probe() {
    if (!this._container) return false
    try {
      const r = await fetch(`${this._host}/info`)
      return r.ok
    } catch { return false }
  }

  async exec(cmd, { cwd, timeout = EXEC_BRIDGE_TIMEOUT_MS } = {}) {
    try {
      const createRes = await fetch(`${this._host}/containers/${this._container}/exec`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          Cmd:          ['sh', '-c', cmd],
          WorkingDir:   cwd || '/',
          AttachStdout: true,
          AttachStderr: true,
        }),
      })
      if (!createRes.ok) throw new Error(`Docker exec create: HTTP ${createRes.status}`)
      const { Id: execId } = await createRes.json()

      const startRes = await fetch(`${this._host}/exec/${execId}/start`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ Detach: false }),
        signal:  AbortSignal.timeout(timeout),
      })
      const raw = await startRes.text()
      return { stdout: raw, stderr: '', exitCode: startRes.ok ? 0 : 1 }
    } catch (err) {
      return { stdout: '', stderr: err.message, exitCode: 1 }
    }
  }

  async execStream(cmd, opts = {}, onChunk) {
    // Docker multiplexed streaming requires protocol parsing; delegate to buffered exec.
    const result = await this.exec(cmd, opts)
    if (result.stdout) onChunk?.(result.stdout, 'stdout')
    if (result.stderr) onChunk?.(result.stderr, 'stderr')
    return { exitCode: result.exitCode, output: result.stdout + result.stderr }
  }
}

// ── SubprocessProvider ────────────────────────────────────────────────────────
// Routes to a lightweight Node.js relay server started alongside bluswan-cli.mjs.
// The relay server exposes /exec and /exec-stream at VITE_EXEC_RELAY (default port 4779).
class SubprocessProvider {
  constructor() {
    this._relay = (typeof import.meta !== 'undefined' ? import.meta.env?.VITE_EXEC_RELAY : null) || 'http://localhost:4779'
  }

  async probe() {
    try {
      const r = await fetch(`${this._relay}/health`)
      return r.ok
    } catch { return false }
  }

  async exec(cmd, { cwd, timeout = EXEC_BRIDGE_TIMEOUT_MS, stdin } = {}) {
    try {
      const res = await fetch(`${this._relay}/exec`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ cmd, cwd, timeout, stdin }),
      })
      if (!res.ok) throw new Error(`relay HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      return { stdout: '', stderr: err.message, exitCode: 1 }
    }
  }

  async execStream(cmd, { cwd, timeout = EXEC_BRIDGE_TIMEOUT_MS } = {}, onChunk) {
    try {
      const res = await fetch(`${this._relay}/exec-stream`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ cmd, cwd, timeout }),
      })
      if (!res.ok) return { exitCode: 1, output: `relay HTTP ${res.status}` }

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = '', output = '', exitCode = 0

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop()
        for (const chunk of parts) {
          const line = chunk.trim()
          if (!line.startsWith('data: ')) continue
          try {
            const { type, data } = JSON.parse(line.slice(6))
            if (type === 'stdout' || type === 'stderr') { output += (data ?? ''); onChunk?.(data ?? '', type) }
            else if (type === 'done')  exitCode = data ?? 0
            else if (type === 'error') { output += (data ?? ''); onChunk?.(data ?? '', 'stderr') }
          } catch {}
        }
      }
      return { exitCode, output }
    } catch (err) {
      return { exitCode: 1, output: err.message }
    }
  }
}

// ── NullProvider ──────────────────────────────────────────────────────────────
// Silent no-op when no backend is reachable. Fail-safe — never throws.
class NullProvider {
  async probe()                     { return false }
  async exec()                      { return { stdout: '', stderr: 'No exec backend available', exitCode: 1 } }
  async execStream(_c, _o, _fn)     { return { exitCode: 1, output: 'No exec backend available' } }
}

// ── ExecutionSandbox ──────────────────────────────────────────────────────────
export class ExecutionSandbox {
  constructor() {
    this._provider  = new NullProvider()
    this._available = false
    this._ready     = false
    this._initPromise = null
  }

  /**
   * Probe backends and select the best available one.
   * Safe to call multiple times — subsequent calls reuse the first result.
   * @returns {Promise<boolean>} true if any backend is available
   */
  async init() {
    if (this._ready) return this._available
    if (this._initPromise) return this._initPromise

    this._initPromise = this._doInit()
    return this._initPromise
  }

  async _doInit() {
    const requested = (typeof import.meta !== 'undefined' ? import.meta.env?.VITE_EXEC_BACKEND : null) || 'auto'

    const REGISTRY = {
      vite:       () => new ViteBridgeProvider(),
      e2b:        () => new E2BProvider(),
      docker:     () => new DockerProvider(),
      subprocess: () => new SubprocessProvider(),
      none:       () => new NullProvider(),
    }

    if (requested !== 'auto' && REGISTRY[requested]) {
      const p  = REGISTRY[requested]()
      const ok = await p.probe()
      this._provider  = ok ? p : new NullProvider()
      this._available = ok
    } else {
      // Auto-detect in priority order; stop at first success.
      const order = ['vite', 'e2b', 'docker', 'subprocess']
      for (const key of order) {
        const p = REGISTRY[key]()
        if (await p.probe()) {
          this._provider  = p
          this._available = true
          break
        }
      }
    }

    this._ready = true
    return this._available
  }

  /** True once init() has been called and a usable backend was found. */
  get available() { return this._available }

  /** Run a command and return buffered {stdout, stderr, exitCode}. Never throws. */
  async exec(cmd, opts = {}) {
    if (!this._ready) await this.init()
    return this._provider.exec(cmd, opts)
  }

  /**
   * Run a command with streaming output.
   * @param {string}   cmd
   * @param {object}   opts  — { cwd, timeout }
   * @param {Function} onChunk  — (text: string, type: 'stdout'|'stderr') => void
   * @returns {Promise<{exitCode: number, output: string}>}
   */
  async execStream(cmd, opts = {}, onChunk) {
    if (!this._ready) await this.init()
    return this._provider.execStream(cmd, opts, onChunk)
  }
}

/** Shared singleton — import this everywhere instead of constructing per-component. */
export const executionSandbox = new ExecutionSandbox()
