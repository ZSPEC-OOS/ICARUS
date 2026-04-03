// ─── run-command tool ─────────────────────────────────────────────────────────
export const toolMeta = {
  id: 'run-command',
  name: 'Run Command',
  version: '1.0.0',
  description: 'Execute a shell command via the local exec bridge (npm, git, eslint, etc.). Requires npm run dev.',
  category: 'utility',
  author: 'ICARUS',
}

export async function execute(input, config = {}) {
  const { cmd, cwd } = input
  if (!cmd) throw new Error('cmd is required')

  const { callExecBridge, bridgeAvailable } = config
  if (!bridgeAvailable || !callExecBridge) {
    throw new Error('Exec bridge not available — start the dev server with: npm run dev')
  }

  const { stdout, stderr, exitCode } = await callExecBridge(cmd, cwd)
  return { cmd, stdout, stderr, exitCode }
}

export async function test() {
  const failures = []

  // Trial 1: bridge offline throws with guidance
  try {
    await execute({ cmd: 'echo hello' }, { bridgeAvailable: false })
    failures.push('Trial 1: should throw when bridge offline')
  } catch (e) {
    if (!e.message.includes('npm run dev')) failures.push(`Trial 1: error should mention npm run dev, got: "${e.message}"`)
  }

  // Trial 2: missing callExecBridge (even with bridgeAvailable=true) throws
  try {
    await execute({ cmd: 'ls' }, { bridgeAvailable: true })
    failures.push('Trial 2: should throw when callExecBridge missing')
  } catch (e) {
    if (!e.message.toLowerCase().includes('bridge')) failures.push(`Trial 2: wrong error: ${e.message}`)
  }

  // Trial 3: cmd is forwarded exactly to bridge
  let receivedCmd = null
  await execute(
    { cmd: 'npm run build -- --mode production' },
    { bridgeAvailable: true, callExecBridge: async (cmd) => { receivedCmd = cmd; return { stdout: 'ok', stderr: '', exitCode: 0 } } },
  )
  if (receivedCmd !== 'npm run build -- --mode production') failures.push(`Trial 3: cmd not forwarded, got "${receivedCmd}"`)

  // Trial 4: stdout, stderr, exitCode all returned
  const r4 = await execute(
    { cmd: 'mixed' },
    { bridgeAvailable: true, callExecBridge: async () => ({ stdout: 'out', stderr: 'err', exitCode: 2 }) },
  )
  if (r4.stdout !== 'out')  failures.push('Trial 4: stdout not returned')
  if (r4.stderr !== 'err')  failures.push('Trial 4: stderr not returned')
  if (r4.exitCode !== 2)    failures.push('Trial 4: exitCode not returned')

  // Trial 5: cmd is echoed in result
  const r5 = await execute(
    { cmd: 'git status' },
    { bridgeAvailable: true, callExecBridge: async () => ({ stdout: 'clean', stderr: '', exitCode: 0 }) },
  )
  if (r5.cmd !== 'git status') failures.push(`Trial 5: cmd not echoed in result, got "${r5.cmd}"`)

  // Trial 6: missing cmd throws
  try {
    await execute({}, { bridgeAvailable: true, callExecBridge: async () => ({}) })
    failures.push('Trial 6: should throw for missing cmd')
  } catch (e) {
    if (!e.message.includes('cmd')) failures.push(`Trial 6: wrong error: ${e.message}`)
  }

  // Trial 7: cwd is forwarded as second argument to bridge
  let receivedCwd = null
  await execute(
    { cmd: 'ls', cwd: '/tmp' },
    { bridgeAvailable: true, callExecBridge: async (cmd, cwd) => { receivedCwd = cwd; return { stdout: '', stderr: '', exitCode: 0 } } },
  )
  if (receivedCwd !== '/tmp') failures.push(`Trial 7: cwd not forwarded, got "${receivedCwd}"`)

  if (failures.length) return { passed: false, message: failures.join(' | ') }
  return { passed: true, message: 'All 7 trials passed (bridge guard, cmd fidelity, all outputs, cwd forwarding, error guards).' }
}
