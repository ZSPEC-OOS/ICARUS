// ─── useExecBridge ────────────────────────────────────────────────────────────
// Provides two exec bridge callers:
//   callExecBridge(cmd, cwd, timeout, stdin)  — buffered, returns {stdout,stderr,exitCode}
//   callExecBridgeStream(cmd, cwd, onChunk, timeout) — SSE streaming, calls onChunk per chunk
// Also probes bridge availability on mount.

import { useState, useEffect, useCallback } from 'react'
import { EXEC_BRIDGE_TIMEOUT_MS } from '../../config/constants.js'

export function useExecBridge() {
  const [bridgeAvailable, setBridgeAvailable] = useState(null)   // null=unknown, true/false

  // Silently probe on mount
  useEffect(() => {
    fetch('/api/exec')
      .then(r => r.ok ? r.json() : null)
      .then(d => setBridgeAvailable(!!(d?.ok)))
      .catch(() => setBridgeAvailable(false))
  }, [])

  // Buffered call — resolves to {stdout, stderr, exitCode}. Never throws.
  const callExecBridge = useCallback(async (cmd, cwd, timeout = EXEC_BRIDGE_TIMEOUT_MS, stdin = undefined) => {
    try {
      const res = await fetch('/api/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd, cwd, timeout, stdin }),
      })
      if (!res.ok) throw new Error(`bridge HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      return { stdout: '', stderr: err.message, exitCode: 1 }
    }
  }, [])

  // Streaming variant — calls onChunk(text, type) per SSE event.
  // Returns { exitCode, output } when the process exits.
  const callExecBridgeStream = useCallback(async (cmd, cwd, onChunk, timeout = EXEC_BRIDGE_TIMEOUT_MS) => {
    try {
      const res = await fetch('/api/exec-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd, cwd, timeout }),
      })
      if (!res.ok) return { exitCode: 1, output: `bridge HTTP ${res.status}` }

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer   = ''
      let output   = ''
      let exitCode = 0

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
  }, [])

  return { bridgeAvailable, callExecBridge, callExecBridgeStream }
}
