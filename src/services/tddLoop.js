// ─── TDD Loop ─────────────────────────────────────────────────────────────────
// Closed-loop Test-Driven Development orchestrator.
//
// Workflow:
//   WRITE  — generate a failing-test scaffold for the spec (if testFilePath given)
//   RUN    — execute the test command via the exec bridge
//   PARSE  — extract pass/fail counts and individual failure details
//   FIX    — append a structured fix-hint comment to the impl file so the model
//            can read it on the next turn and patch the implementation
//   REPEAT — loop until all tests pass or maxIterations is exhausted
//
// The TDD loop does NOT manage its own reliability FSM — it operates inside the
// EXECUTE phase of the outer FSM and feeds its passRate directly into the
// existing `test_pass_rate` gate in gateEvaluators.js.
//
// Integration:
//   • agentExecutor.js — exposed as `run_tdd_loop` tool
//   • agentLoop.js     — optionally triggered when task role = 'test-writer'

import { TDD_MAX_ITERATIONS, TDD_TEST_TIMEOUT_MS } from '../config/constants.js'

// ── Test output parser ────────────────────────────────────────────────────────

/**
 * Parse raw test runner output into structured pass/fail metrics.
 * Handles: Vitest, Jest, Node built-in test runner, Pytest.
 *
 * @param {string} output  Raw stdout+stderr from the test command
 * @returns {TestMetrics}
 */
export function parseTestOutput(output = '') {
  const text     = String(output)
  const failures = []
  let passed     = 0
  let failed     = 0

  // ── Exit-code fallback (used when no summary line is found) ───────────────
  const exitMatch = text.match(/exit\s+(-?\d+)/i)
  const exitCode  = exitMatch ? Number(exitMatch[1]) : null

  // ── Vitest / Jest: "Tests  3 passed | 1 failed" or "Tests: 3 passed, 1 failed, 4 total" ──
  const jestLine = text.match(/Tests?\s*(?:Results?)?\s*[:|]\s*([\d]+\s+\w+(?:[,|]\s*[\d]+\s+\w+)*)/i)
  if (jestLine) {
    const p = jestLine[1].match(/(\d+)\s+pass(?:ed)?/i)
    const f = jestLine[1].match(/(\d+)\s+fail(?:ed)?/i)
    if (p) passed = Number(p[1])
    if (f) failed = Number(f[1])
  }

  // ── Pytest: "3 passed, 1 failed in 0.5s" ─────────────────────────────────
  if (!passed && !failed) {
    const pytestLine = text.match(/(\d+)\s+passed(?:[,\s]+(\d+)\s+failed)?/i)
    if (pytestLine) {
      passed = Number(pytestLine[1]) || 0
      failed = pytestLine[2] ? Number(pytestLine[2]) : 0
    }
  }

  // ── Node built-in test runner: "# pass N" / "# fail N" ───────────────────
  if (!passed && !failed) {
    const np = text.match(/^# pass\s+(\d+)/im)
    const nf = text.match(/^# fail\s+(\d+)/im)
    if (np) passed = Number(np[1])
    if (nf) failed = Number(nf[1])
  }

  // ── Exit-code fallback ────────────────────────────────────────────────────
  if (!passed && !failed && exitCode !== null) {
    passed = exitCode === 0 ? 1 : 0
    failed = exitCode !== 0 ? 1 : 0
  }

  // ── Failure block extraction ──────────────────────────────────────────────

  // Jest / Vitest: "● Suite > test name\n..."
  for (const m of text.matchAll(/●\s+([^\n]+)\n([\s\S]*?)(?=\n●|\n\nTest Suites|$)/g)) {
    const name      = m[1].trim()
    const body      = m[2] || ''
    const errorLine = body.split('\n').find(l => /Error:|expect\(|Received|AssertionError/i.test(l))?.trim() || ''
    failures.push({ name, error: errorLine.slice(0, 200), raw: body.slice(0, 500) })
  }

  // Pytest: "FAILED path/test.py::Class::method - AssertionError: …"
  for (const m of text.matchAll(/^FAILED\s+([\w/.:_-]+)(?:\s+-\s+(.+))?/gm)) {
    if (!failures.find(f => f.name === m[1])) {
      failures.push({ name: m[1], error: (m[2] || '').slice(0, 200), raw: '' })
    }
  }

  // Node test runner: "not ok N - test name"
  for (const m of text.matchAll(/^not ok\s+\d+\s+-\s+(.+)$/gm)) {
    if (!failures.find(f => f.name === m[1].trim())) {
      failures.push({ name: m[1].trim(), error: '', raw: '' })
    }
  }

  const total    = passed + failed
  const passRate = total > 0
    ? passed / total
    : (exitCode === 0 ? 1 : 0)

  return { passed, failed, total, passRate, failures }
}

// ── Loop runner ───────────────────────────────────────────────────────────────

/**
 * Run the TDD loop until tests go green or maxIterations is exhausted.
 *
 * @param {object}   opts
 * @param {string}   opts.spec            Feature / behaviour description
 * @param {string}   opts.testCmd         Shell command to execute tests (e.g. 'npm test')
 * @param {string}   [opts.testFilePath]  Path to generate/write the test file
 * @param {string}   [opts.implFilePath]  Path to the implementation being developed
 * @param {Function} opts.executeTool     agentExecutor rawExecuteTool(name, input) → string
 * @param {Function} [opts.onEvent]       Event callback for UI / trace
 * @param {number}   [opts.maxIterations]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<TDDResult>}
 */
export async function runTDDLoop({
  spec,
  testCmd,
  testFilePath,
  implFilePath,
  executeTool,
  onEvent    = () => {},
  maxIterations = TDD_MAX_ITERATIONS,
  signal,
}) {
  const filesChanged = []
  let   iteration    = 0
  let   lastOutput   = ''
  let   lastMetrics  = { passed: 0, failed: 0, total: 0, passRate: 0, failures: [] }

  onEvent({ type: 'tdd_start', spec, testCmd, testFilePath, implFilePath, maxIterations })

  // ── Step 1: write failing-test scaffold ─────────────────────────────────
  if (testFilePath) {
    try {
      onEvent({ type: 'tdd_phase', phase: 'write_tests', iteration: 0 })
      const scaffold = _buildTestScaffold(spec, testFilePath, implFilePath)
      await executeTool('write_file', {
        path:    testFilePath,
        content: scaffold,
        message: `test: TDD scaffold for ${spec.slice(0, 60)}`,
      })
      filesChanged.push(testFilePath)
      onEvent({ type: 'tdd_tests_written', path: testFilePath })
    } catch (err) {
      onEvent({ type: 'tdd_error', phase: 'write_tests', error: err.message })
      // Non-fatal — continue with the run/fix cycle
    }
  }

  // ── Steps 2–N: run → parse → fix cycle ───────────────────────────────────
  while (iteration < maxIterations) {
    if (signal?.aborted) {
      onEvent({ type: 'tdd_done', status: 'aborted', iterations: iteration, passRate: lastMetrics.passRate, filesChanged })
      return { status: 'aborted', iterations: iteration, passRate: lastMetrics.passRate, lastOutput, filesChanged }
    }

    iteration++
    onEvent({ type: 'tdd_phase', phase: 'run_tests', iteration })

    try {
      lastOutput  = await executeTool('run_command', { cmd: testCmd, timeout: TDD_TEST_TIMEOUT_MS })
    } catch (err) {
      lastOutput = `exec error: ${err.message}`
    }
    lastMetrics = parseTestOutput(lastOutput)

    onEvent({
      type:       'tdd_run',
      iteration,
      passed:     lastMetrics.passed,
      failed:     lastMetrics.failed,
      passRate:   lastMetrics.passRate,
      failures:   lastMetrics.failures.slice(0, 5),
      output:     lastOutput.slice(0, 800),
    })

    // ✅ All tests green
    if (lastMetrics.passRate >= 1 && lastMetrics.total > 0) {
      onEvent({ type: 'tdd_done', status: 'green', iterations: iteration, passRate: 1, filesChanged })
      return { status: 'green', iterations: iteration, passRate: 1, lastOutput, filesChanged }
    }

    // No parseable test output — bail to avoid infinite loops
    if (lastMetrics.total === 0 && iteration >= 2) {
      onEvent({ type: 'tdd_done', status: 'no_output', iterations: iteration, passRate: 0, filesChanged,
        reason: 'No test results detected. Verify the test command and runner are configured correctly.' })
      return { status: 'no_output', iterations: iteration, passRate: 0, lastOutput, filesChanged }
    }

    // ── Fix phase: append hint comment so next model turn can patch impl ──
    if (implFilePath && lastMetrics.failures.length > 0) {
      onEvent({ type: 'tdd_phase', phase: 'fix', iteration })
      const hint = _buildFixHint(lastMetrics.failures, implFilePath)

      try {
        // Append a structured comment that the agent will read on the next turn.
        // The comment is self-describing so the model knows exactly what to do.
        const safeHint = hint.replace(/"/g, "'").replace(/\n/g, ' ')
        await executeTool('run_command', {
          cmd: `printf '\\n// TDD-FIX [iteration ${iteration}]: ${safeHint}\\n' >> ${implFilePath}`,
        })
        filesChanged.push(implFilePath)
        onEvent({ type: 'tdd_fix', iteration, hint })
      } catch {
        // exec bridge unavailable in production — emit event so model reads output
        onEvent({ type: 'tdd_fix', iteration, hint, bridgeUnavailable: true })
      }
    }
  }

  // Max iterations reached without going green
  onEvent({ type: 'tdd_done', status: 'red', iterations: iteration, passRate: lastMetrics.passRate, filesChanged })
  return { status: 'red', iterations: iteration, passRate: lastMetrics.passRate, lastOutput, filesChanged }
}

// ── Test scaffold builder ─────────────────────────────────────────────────────

function _buildTestScaffold(spec, testFilePath, implFilePath) {
  const isTS    = /\.(ts|tsx)$/.test(testFilePath)
  const isPy    = testFilePath.endsWith('.py')
  const heading = spec.slice(0, 100).replace(/'/g, "\\'")

  if (isPy) {
    const implMod = implFilePath
      ? implFilePath.replace(/\.py$/, '').replace(/\//g, '.')
      : 'your_module'
    return [
      'import pytest',
      `# from ${implMod} import ...  # TODO: import what you are testing`,
      '',
      `class Test${_toPascalCase(spec.slice(0, 30))}:`,
      `    """${heading}"""`,
      '',
      '    def test_placeholder(self):',
      '        """TDD placeholder — replace with a real failing assertion."""',
      '        assert False, "Implement this test first, then make it pass"',
    ].join('\n')
  }

  const importLine = implFilePath
    ? `// import { TODO } from '${implFilePath.replace(/\.(ts|tsx|js|jsx|mjs)$/, '')}'`
    : `// import { TODO } from './your-module'  // TODO: import the module under test`

  const describeWord = isTS ? `describe` : `describe`
  return [
    isTS
      ? `import { describe, it, expect } from 'vitest'`
      : `import { describe, it, expect } from 'vitest'`,
    importLine,
    '',
    `${describeWord}('${heading}', () => {`,
    `  it('should fulfil the spec (TDD placeholder — replace with a real assertion)', () => {`,
    `    // TODO: write the failing assertion here, then implement the code to make it pass`,
    `    expect(true).toBe(false)  // remove this line once real assertions are in place`,
    `  })`,
    `})`,
  ].join('\n')
}

// ── Fix-hint builder ──────────────────────────────────────────────────────────

function _buildFixHint(failures, implFilePath) {
  const names  = failures.slice(0, 3).map(f => f.name).join(', ')
  const errors = failures.slice(0, 2).map(f => f.error).filter(Boolean).join('; ')
  return `Failing tests: ${names}${errors ? ` — ${errors}` : ''}. Fix ${implFilePath} to make them pass.`
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function _toPascalCase(str) {
  return str.replace(/(?:^|\s+|[-_])(\w)/g, (_, c) => c.toUpperCase()).replace(/\W/g, '')
}

/**
 * @typedef {{
 *   passed:   number,
 *   failed:   number,
 *   total:    number,
 *   passRate: number,
 *   failures: { name: string, error: string, raw: string }[],
 * }} TestMetrics
 *
 * @typedef {{
 *   status:       'green'|'red'|'no_output'|'aborted',
 *   iterations:   number,
 *   passRate:     number,
 *   lastOutput:   string,
 *   filesChanged: string[],
 * }} TDDResult
 */
