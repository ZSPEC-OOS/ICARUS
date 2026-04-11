// ─── useExecBridge ────────────────────────────────────────────────────────────
// React hook wrapping ExecutionSandbox.
// Drop-in replacement for the previous direct-fetch implementation —
// same API surface (bridgeAvailable, callExecBridge, callExecBridgeStream)
// but now routes through the multi-backend ExecutionSandbox abstraction.
//
// Backend selected at startup via VITE_EXEC_BACKEND or auto-detection:
//   vite (dev server)  →  e2b (cloud)  →  docker (local)  →  subprocess (CLI)

import { useState, useEffect, useCallback } from 'react'
import { EXEC_BRIDGE_TIMEOUT_MS } from '../../config/constants.js'
import { executionSandbox } from '../../services/executionSandbox.js'

export function useExecBridge() {
  const [bridgeAvailable, setBridgeAvailable] = useState(null)  // null=probing, true/false

  // Probe on mount — sets bridgeAvailable once the best backend is known.
  useEffect(() => {
    executionSandbox.init().then(ok => setBridgeAvailable(ok))
  }, [])

  // Buffered call — resolves to {stdout, stderr, exitCode}. Never throws.
  const callExecBridge = useCallback(
    (cmd, cwd, timeout = EXEC_BRIDGE_TIMEOUT_MS, stdin = undefined) =>
      executionSandbox.exec(cmd, { cwd, timeout, stdin }),
    [],
  )

  // Streaming call — calls onChunk(text, type) per SSE chunk.
  // Returns {exitCode, output} when the process exits.
  const callExecBridgeStream = useCallback(
    (cmd, cwd, onChunk, timeout = EXEC_BRIDGE_TIMEOUT_MS) =>
      executionSandbox.execStream(cmd, { cwd, timeout }, onChunk),
    [],
  )

  return { bridgeAvailable, callExecBridge, callExecBridgeStream }
}
