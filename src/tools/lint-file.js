// ─── lint-file tool ───────────────────────────────────────────────────────────
export const toolMeta = {
  id: 'lint-file',
  name: 'Lint File',
  version: '1.0.0',
  description: 'Run ESLint on a JS/TS file and return errors with line numbers, or confirm no errors.',
  category: 'analysis',
  author: 'BLUSWAN',
}

export async function execute(input, config = {}) {
  const { path } = input
  if (!path) throw new Error('path is required')
  if (!/\.(js|jsx|ts|tsx)$/.test(path)) throw new Error('lint-file only supports .js/.jsx/.ts/.tsx files')

  const { callExecBridge, bridgeAvailable } = config
  if (!bridgeAvailable || !callExecBridge) {
    throw new Error('Exec bridge not available — start the dev server with: npm run dev')
  }

  const { stdout, stderr, exitCode } = await callExecBridge(`npx eslint --format=compact "${path}"`)
  const output = [stdout, stderr].filter(Boolean).join('\n').trim()
  const clean  = exitCode === 0

  return { path, clean, output: output || '(no output)', exitCode }
}

export async function test() {
  const failures = []

  // Trial 1: .py file rejected before any bridge call
  let bridgeCalled = false
  try {
    await execute(
      { path: 'script.py' },
      { bridgeAvailable: true, callExecBridge: async () => { bridgeCalled = true; return { stdout: '', stderr: '', exitCode: 0 } } },
    )
    failures.push('Trial 1: should reject .py extension')
  } catch (e) {
    if (!e.message.includes('.js') && !e.message.includes('supports')) failures.push(`Trial 1: wrong error: ${e.message}`)
    if (bridgeCalled) failures.push('Trial 1: bridge was called despite invalid extension')
  }

  // Trial 2: .css file rejected
  try {
    await execute({ path: 'styles.css' }, { bridgeAvailable: true, callExecBridge: async () => ({}) })
    failures.push('Trial 2: should reject .css extension')
  } catch (e) {
    if (!e.message.includes('supports')) failures.push(`Trial 2: wrong error: ${e.message}`)
  }

  // Trial 3: clean file → clean=true, exitCode=0
  const r3 = await execute(
    { path: 'src/app.jsx' },
    { bridgeAvailable: true, callExecBridge: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
  )
  if (!r3.clean)           failures.push('Trial 3: should be clean when exitCode=0')
  if (r3.exitCode !== 0)   failures.push('Trial 3: exitCode should be 0')
  if (r3.path !== 'src/app.jsx') failures.push('Trial 3: path not echoed')

  // Trial 4: lint errors → clean=false, error output captured
  const lintOutput = 'src/app.jsx: line 10, col 5, Error - no-unused-vars'
  const r4 = await execute(
    { path: 'src/app.jsx' },
    { bridgeAvailable: true, callExecBridge: async () => ({ stdout: lintOutput, stderr: '', exitCode: 1 }) },
  )
  if (r4.clean)                         failures.push('Trial 4: should not be clean when exitCode=1')
  if (!r4.output.includes('no-unused')) failures.push('Trial 4: lint output not captured')
  if (r4.exitCode !== 1)                failures.push('Trial 4: exitCode should be 1')

  // Trial 5: stderr is captured too
  const r5 = await execute(
    { path: 'f.ts' },
    { bridgeAvailable: true, callExecBridge: async () => ({ stdout: '', stderr: 'Cannot find module eslint', exitCode: 2 }) },
  )
  if (!r5.output.includes('Cannot find module')) failures.push('Trial 5: stderr not captured in output')

  // Trial 6: all valid extensions accepted
  for (const ext of ['js', 'jsx', 'ts', 'tsx']) {
    try {
      await execute(
        { path: `file.${ext}` },
        { bridgeAvailable: true, callExecBridge: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      )
    } catch (e) {
      failures.push(`Trial 6: valid extension .${ext} rejected: ${e.message}`)
    }
  }

  // Trial 7: bridge offline throws guidance
  try {
    await execute({ path: 'f.js' }, { bridgeAvailable: false })
    failures.push('Trial 7: should throw when bridge offline')
  } catch (e) {
    if (!e.message.includes('npm run dev')) failures.push(`Trial 7: error should mention npm run dev, got: "${e.message}"`)
  }

  if (failures.length) return { passed: false, message: failures.join(' | ') }
  return { passed: true, message: 'All 7 trials passed (extension guard, clean/error states, stderr capture, all valid extensions, bridge guard).' }
}
