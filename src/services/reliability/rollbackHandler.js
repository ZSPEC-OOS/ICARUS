function uniquePaths(trace = []) {
  return [...new Set(trace.map(t => t.path).filter(Boolean))]
}

export function createRollbackHandler({ executeTool, onEvent = () => {}, memoryGraphService = null }) {
  async function tryGitRollback(trace = []) {
    const paths = uniquePaths(trace)
    if (!paths.length) return { ok: true, strategy: 'noop', steps: [] }
    const cmd = `git checkout -- ${paths.map(p => `"${p}"`).join(' ')}`
    const out = await executeTool('run_command', { cmd })
    const ok = /exit\s+0/i.test(String(out || '')) || /updated|restored|checkout/i.test(String(out || ''))
    return {
      ok,
      strategy: 'git_checkout',
      steps: [{ type: 'run_command', cmd, output: String(out || '').slice(0, 400) }],
    }
  }

  async function applyPatchUndo(trace = []) {
    const steps = []
    for (const mutation of [...trace].reverse()) {
      const { path, beforeExists, beforeContent } = mutation
      if (!path) continue
      if (beforeExists) {
        const result = await executeTool('write_file', {
          path,
          content: beforeContent,
          message: `rollback(${path}): restore previous content`,
        })
        steps.push({ type: 'write_file', path, result: String(result || '').slice(0, 240) })
      } else {
        const result = await executeTool('delete_file', {
          path,
          message: `rollback(${path}): remove file created during failed run`,
        })
        steps.push({ type: 'delete_file', path, result: String(result || '').slice(0, 240) })
      }
    }
    return { ok: true, strategy: 'patch_undo', steps }
  }

  return async function rollback({ trace = [], reason = 'verification_failed' } = {}) {
    onEvent({ type: 'rollback_start', reason })
    let result
    let errors = []

    try {
      result = await tryGitRollback(trace)
      if (!result.ok) result = await applyPatchUndo(trace)
    } catch (err) {
      errors.push(err.message)
      try {
        result = await applyPatchUndo(trace)
      } catch (patchErr) {
        errors.push(patchErr.message)
        result = { ok: false, strategy: 'failed', steps: [] }
      }
    }

    memoryGraphService?.ingestRollbackOutcome?.({
      reason,
      passed: !!result?.ok,
      strategy: result?.strategy || 'unknown',
      trace,
      errors,
    })

    onEvent({
      type: 'rollback_done',
      status: result?.ok ? 'rolled_back' : 'rollback_failed',
      strategy: result?.strategy || 'unknown',
      steps: result?.steps || [],
      errors,
    })

    return {
      rolledBack: !!result?.ok,
      strategy: result?.strategy || 'unknown',
      steps: result?.steps || [],
      errors,
    }
  }
}
