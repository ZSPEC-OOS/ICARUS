/**
 * @module qualitySignals
 * Advisory quality checks that run post-completion.
 * Displayed to the user. NEVER block task completion.
 * All checks are deterministic (regex or command) — no LLM self-critique.
 */

// ─── JSDoc Types ──────────────────────────────────────────────────────────────

/**
 * @typedef {Object} QualitySignal
 * @property {string} id
 * @property {string} name
 * @property {'pass'|'warn'|'fail'|'info'} status
 * @property {string} description
 * @property {string} [detail]
 * @property {boolean} blocksCompletion - Always false
 */

/**
 * @typedef {Object} QualityReport
 * @property {QualitySignal[]} signals
 * @property {number} passCount
 * @property {number} warnCount
 * @property {number} failCount
 * @property {string} summary
 */

// ─── Regex Patterns ───────────────────────────────────────────────────────────

const CONSOLE_LOG_RE = /\bconsole\.(log|debug|info|warn|error)\s*\(/g;
const TODO_RE = /\b(TODO|FIXME|HACK|XXX)\b/g;
const UNUSED_IMPORT_RE = /^import\s+(?:\{[^}]+\}|[\w*]+)\s+from\s+['"][^'"]+['"]/gm;

const API_SURFACE_PATHS = [/^src\/services\//, /^src\/core\//];
const MAX_FILE_LINES = 300;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * @param {import('./cycleEngine.js').ExecutionCycle[]} cycles
 * @returns {Set<string>} paths of all files written or edited
 */
function getModifiedPaths(cycles) {
  const paths = new Set();
  for (const cycle of cycles) {
    for (const r of cycle.toolResults ?? []) {
      if ((r.toolName === 'write_file' || r.toolName === 'edit_file') && r.input?.path) {
        paths.add(r.input.path);
      }
    }
  }
  return paths;
}

/**
 * @param {import('./cycleEngine.js').ExecutionCycle[]} cycles
 * @param {string} path
 * @returns {string} last written content for a path
 */
function getLastWrittenContent(cycles, path) {
  let last = '';
  for (const cycle of cycles) {
    for (const r of cycle.toolResults ?? []) {
      if ((r.toolName === 'write_file' || r.toolName === 'edit_file') && r.input?.path === path) {
        last = r.input?.content ?? r.input?.new_str ?? last;
      }
    }
  }
  return last;
}

/** @returns {QualitySignal} */
function signal(id, name, status, description, detail) {
  return { id, name, status, description, ...(detail ? { detail } : {}), blocksCompletion: false };
}

// ─── Individual Signal Checkers ───────────────────────────────────────────────

function checkTestCoverage(plan) {
  const hasCodeDeliverables = plan.deliverables.some((d) => d.type === 'file' || d.type === 'edit');
  const hasTestDeliverables = plan.deliverables.some((d) => d.type === 'test');

  if (!hasCodeDeliverables) {
    return signal('test_coverage', 'Test Coverage', 'pass', 'Code deliverables coverage check', 'No code deliverables — nothing to cover');
  }
  if (hasTestDeliverables) {
    const count = plan.deliverables.filter((d) => d.type === 'test').length;
    return signal('test_coverage', 'Test Coverage', 'pass', 'Code deliverables have corresponding tests', `${count} test deliverable(s) in plan`);
  }
  return signal('test_coverage', 'Test Coverage', 'warn', 'No test deliverables for code changes', 'Consider adding tests for changed code');
}

function checkConsoleLogs(cycles) {
  const modifiedPaths = getModifiedPaths(cycles);
  const filesWithLogs = [];

  for (const path of modifiedPaths) {
    if (!/\.[jt]sx?$/.test(path)) continue;
    const content = getLastWrittenContent(cycles, path);
    if (!content) continue;
    const matches = content.match(CONSOLE_LOG_RE);
    if (matches?.length) {
      filesWithLogs.push(`${path} (${matches.length} call${matches.length > 1 ? 's' : ''})`);
    }
  }

  if (filesWithLogs.length === 0) {
    return signal('console_logs', 'Console Logs', 'pass', 'No debug console.log statements detected');
  }
  return signal('console_logs', 'Console Logs', 'warn', 'Debug console statements found in modified files', filesWithLogs.join(', '));
}

function checkTodoComments(cycles) {
  const modifiedPaths = getModifiedPaths(cycles);
  const filesWithTodos = [];

  for (const path of modifiedPaths) {
    const content = getLastWrittenContent(cycles, path);
    if (!content) continue;
    const matches = content.match(TODO_RE);
    if (matches?.length) {
      const unique = [...new Set(matches)];
      filesWithTodos.push(`${path} (${unique.join(', ')})`);
    }
  }

  if (filesWithTodos.length === 0) {
    return signal('todo_comments', 'TODO Comments', 'pass', 'No TODO/FIXME comments in modified files');
  }
  return signal('todo_comments', 'TODO Comments', 'warn', 'TODO/FIXME comments remain in modified files', filesWithTodos.join(', '));
}

function checkUnusedImports(cycles) {
  const modifiedPaths = getModifiedPaths(cycles);
  const suspiciousFiles = [];

  for (const path of modifiedPaths) {
    if (!/\.[jt]sx?$/.test(path)) continue;
    const content = getLastWrittenContent(cycles, path);
    if (!content) continue;

    // Simple heuristic: extract import names and check if they appear in non-import lines
    const importMatches = [...content.matchAll(/^import\s+\{([^}]+)\}\s+from/gm)];
    const nonImportContent = content.replace(/^import\s+.*$/gm, '');

    let hasUnused = false;
    for (const m of importMatches) {
      const names = m[1].split(',').map((n) => n.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean);
      for (const name of names) {
        if (name && !new RegExp(`\\b${name}\\b`).test(nonImportContent)) {
          hasUnused = true;
          break;
        }
      }
      if (hasUnused) break;
    }

    if (hasUnused) {
      suspiciousFiles.push(path);
    }
  }

  if (suspiciousFiles.length === 0) {
    return signal('unused_imports', 'Unused Imports', 'pass', 'No obviously unused imports detected');
  }
  return signal('unused_imports', 'Unused Imports', 'warn', 'Possible unused imports in modified files', suspiciousFiles.join(', '));
}

function checkLargeFiles(cycles) {
  const modifiedPaths = getModifiedPaths(cycles);
  const largeFiles = [];

  for (const path of modifiedPaths) {
    const content = getLastWrittenContent(cycles, path);
    if (!content) continue;
    const lines = content.split('\n').length;
    if (lines > MAX_FILE_LINES) {
      largeFiles.push(`${path} (${lines} lines)`);
    }
  }

  if (largeFiles.length === 0) {
    return signal('large_files', 'File Size', 'pass', `All modified files within ${MAX_FILE_LINES}-line guideline`);
  }
  return signal('large_files', 'File Size', 'warn', `Modified files exceed ${MAX_FILE_LINES}-line guideline`, largeFiles.join(', '));
}

function checkApiChanges(cycles) {
  const modifiedPaths = getModifiedPaths(cycles);
  const apiFiles = [...modifiedPaths].filter((p) => API_SURFACE_PATHS.some((re) => re.test(p)));

  if (apiFiles.length === 0) {
    return signal('api_changes', 'API Surface', 'pass', 'No changes to API surface paths');
  }
  return signal('api_changes', 'API Surface', 'info', `${apiFiles.length} file(s) in API surface paths changed`, `Modified: ${apiFiles.join(', ')}`);
}

async function checkLintClean(executeTool, cachedResults) {
  // Use cached lint result if available from validation run
  const cached = cachedResults?.find((r) => r.id === 'lint');
  if (cached) {
    return signal('lint_clean', 'Lint', cached.passed ? 'pass' : 'warn', 'Linter result', cached.passed ? undefined : cached.output.split('\n').slice(0, 3).join('\n'));
  }

  try {
    const output = await executeTool('run_command', { command: 'npm run lint --if-present 2>&1 || true' });
    const passed = !output.toLowerCase().includes('error') || output.toLowerCase().includes('0 errors');
    return signal('lint_clean', 'Lint', passed ? 'pass' : 'warn', 'Linter result', passed ? undefined : output.split('\n').filter(Boolean).slice(0, 3).join('\n'));
  } catch {
    return signal('lint_clean', 'Lint', 'info', 'Linter not configured or not available');
  }
}

async function checkTypeClean(executeTool, cachedResults) {
  const cached = cachedResults?.find((r) => r.id === 'build' || r.id === 'typecheck');
  if (cached) {
    return signal('type_clean', 'Type Check', cached.passed ? 'pass' : 'warn', 'Type checker result', cached.passed ? undefined : cached.output.split('\n').slice(0, 3).join('\n'));
  }

  try {
    const output = await executeTool('run_command', { command: 'npx tsc --noEmit 2>&1 || true' });
    const passed = !output.toLowerCase().includes('error') || /^found 0 errors/im.test(output);
    return signal('type_clean', 'Type Check', passed ? 'pass' : 'warn', 'TypeScript type check result', passed ? undefined : output.split('\n').filter(Boolean).slice(0, 3).join('\n'));
  } catch {
    return signal('type_clean', 'Type Check', 'info', 'TypeScript not configured or not available');
  }
}

async function checkBuildClean(executeTool, cachedResults) {
  const cached = cachedResults?.find((r) => r.id === 'build');
  if (cached) {
    return signal('build_clean', 'Build', cached.passed ? 'pass' : 'warn', 'Build result', cached.passed ? undefined : 'Build failed — see validation output');
  }

  try {
    const output = await executeTool('run_command', { command: 'npm run build --if-present 2>&1 || true' });
    const passed = !output.toLowerCase().includes('error') || /build.*success/i.test(output);
    return signal('build_clean', 'Build', passed ? 'pass' : 'warn', 'Build result', passed ? undefined : output.split('\n').filter(Boolean).slice(0, 3).join('\n'));
  } catch {
    return signal('build_clean', 'Build', 'info', 'Build not configured or not available');
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Runs all quality signals and returns a QualityReport.
 * Never throws. All failures become signal entries.
 * Advisory only — never blocks completion.
 *
 * @param {import('./planContract.js').ExecutionPlan} plan
 * @param {import('./cycleEngine.js').ExecutionCycle[]} cycles
 * @param {import('./repoIndex.js').RepoIndex|null} repoIndex
 * @param {(name: string, input: Object) => Promise<string>} executeTool
 * @param {import('./validator.js').ValidationResult[]} [cachedValidationResults]
 * @returns {Promise<QualityReport>}
 */
export async function runQualitySignals(plan, cycles, repoIndex, executeTool, cachedValidationResults) {
  const signals = [];

  // Synchronous checks (deterministic, no I/O)
  try { signals.push(checkTestCoverage(plan)); } catch { /* non-fatal */ }
  try { signals.push(checkConsoleLogs(cycles)); } catch { /* non-fatal */ }
  try { signals.push(checkTodoComments(cycles)); } catch { /* non-fatal */ }
  try { signals.push(checkUnusedImports(cycles)); } catch { /* non-fatal */ }
  try { signals.push(checkLargeFiles(cycles)); } catch { /* non-fatal */ }
  try { signals.push(checkApiChanges(cycles)); } catch { /* non-fatal */ }

  // Async checks (may run commands — use cached results when possible)
  try { signals.push(await checkLintClean(executeTool, cachedValidationResults)); } catch { /* non-fatal */ }
  try { signals.push(await checkTypeClean(executeTool, cachedValidationResults)); } catch { /* non-fatal */ }
  try { signals.push(await checkBuildClean(executeTool, cachedValidationResults)); } catch { /* non-fatal */ }

  // Invariant: no signal ever blocks completion
  for (const s of signals) s.blocksCompletion = false;

  const passCount = signals.filter((s) => s.status === 'pass').length;
  const warnCount = signals.filter((s) => s.status === 'warn').length;
  const failCount = signals.filter((s) => s.status === 'fail').length;

  const parts = [`${passCount} passed`];
  if (warnCount > 0) parts.push(`${warnCount} warning${warnCount > 1 ? 's' : ''}`);
  if (failCount > 0) parts.push(`${failCount} failed`);

  return {
    signals,
    passCount,
    warnCount,
    failCount,
    summary: parts.join(', '),
  };
}

/**
 * Formats a QualityReport as a markdown table for UI display.
 *
 * @param {QualityReport} report
 * @returns {string}
 */
export function formatQualityReport(report) {
  if (!report || report.signals.length === 0) {
    return '## Quality Signals\n\nNo signals recorded.';
  }

  const statusIcon = { pass: '✅ Pass', warn: '⚠️ Warning', fail: '❌ Fail', info: 'ℹ️ Info' };
  const rows = report.signals.map((s) => {
    const icon = statusIcon[s.status] ?? s.status;
    const detail = s.detail ? s.detail.replace(/\|/g, '‖').slice(0, 80) : '—';
    return `| ${s.name} | ${icon} | ${detail} |`;
  });

  const warnings = report.signals.filter((s) => s.status === 'warn');
  const recommendation = warnings.length > 0
    ? `\n**Recommendation:** Fix ${warnings.map((s) => s.name.toLowerCase()).join(', ')} before merging.`
    : '\nAll advisory checks passed.';

  return [
    '## Quality Signals',
    '',
    '| Signal | Status | Detail |',
    '|--------|--------|--------|',
    ...rows,
    '',
    `**Summary:** ${report.summary}`,
    recommendation,
  ].join('\n');
}
