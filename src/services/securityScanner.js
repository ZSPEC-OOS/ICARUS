// ─── Security Scanner ─────────────────────────────────────────────────────────
// Scans AI-generated file mutations for security issues before they are
// committed.  Operates as a reliability gate: scanMutations() is called in
// gateEvaluators.js after the EXECUTE phase and before VERIFY completes.
//
// Three scan categories:
//
//   1. Secrets — hardcoded credentials, API keys, private keys, connection
//      strings.  These are "critical" severity — they must block the commit.
//
//   2. Code vulnerabilities — OWASP Top 10 patterns: XSS sinks, eval/new
//      Function, command injection, SQL injection, path traversal, open
//      redirects.  Severity depends on context: "high" when the dangerous
//      pattern is clearly introduced (not pre-existing), "medium" otherwise.
//
//   3. New dependencies — newly added entries in package.json dependencies /
//      devDependencies.  Flagged as "info" so the model is aware without
//      blocking (no CVE DB lookup in-browser, but at least surfaces the addition).
//
// Integration: gateEvaluators.js calls scanMutations(executionTrace.mutations)
// and adds the result as a `security_scan` gate entry.

// ── Secret patterns ───────────────────────────────────────────────────────────
// Each entry: { id, severity, pattern, description }

const SECRET_RULES = [
  { id: 'openai_key',    severity: 'critical', pattern: /\bsk-[a-zA-Z0-9]{20,}\b/,              description: 'OpenAI API key' },
  { id: 'github_token',  severity: 'critical', pattern: /\bghp_[a-zA-Z0-9]{36}\b/,              description: 'GitHub personal access token' },
  { id: 'github_oauth',  severity: 'critical', pattern: /\bgho_[a-zA-Z0-9]{36}\b/,              description: 'GitHub OAuth token' },
  { id: 'aws_key',       severity: 'critical', pattern: /\bAKIA[0-9A-Z]{16}\b/,                 description: 'AWS access key ID' },
  { id: 'stripe_live',   severity: 'critical', pattern: /\bsk_live_[a-zA-Z0-9]{24,}\b/,         description: 'Stripe live secret key' },
  { id: 'private_key',   severity: 'critical', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, description: 'PEM private key block' },
  { id: 'anthropic_key', severity: 'critical', pattern: /\bsk-ant-[a-zA-Z0-9-]{30,}\b/,        description: 'Anthropic API key' },
  { id: 'generic_apikey',severity: 'high',
    pattern: /(?:api[_-]?key|apikey|access[_-]?token|secret[_-]?key)\s*[:=]\s*['"`]([a-zA-Z0-9_\-./+]{20,})['"`]/i,
    description: 'Hardcoded API key or secret token' },
  { id: 'password_hardcoded', severity: 'high',
    pattern: /\bpassword\s*[:=]\s*['"`][^'"`\s]{8,}['"`]/i,
    description: 'Hardcoded password in source code' },
  { id: 'connection_string', severity: 'high',
    pattern: /(?:mongodb|postgresql|postgres|mysql|redis|amqp):\/\/[^:]+:[^@\s]+@/i,
    description: 'Connection string with embedded credentials' },
  { id: 'jwt_secret',    severity: 'high',
    pattern: /jwt[_-]?secret\s*[:=]\s*['"`][^'"`]{12,}['"`]/i,
    description: 'Hardcoded JWT secret' },
]

// ── Vulnerability patterns ────────────────────────────────────────────────────

const VULN_RULES = [
  {
    id:          'xss_innerhtml',
    severity:    'high',
    pattern:     /\.innerHTML\s*[+]?=(?!\s*['"`]\s*['"`])/,
    description: 'XSS: innerHTML assignment with non-literal value',
    owasp:       'A03:Injection',
  },
  {
    id:          'xss_dangerous_html',
    severity:    'high',
    pattern:     /dangerouslySetInnerHTML\s*=\s*\{\s*\{?\s*__html\s*:/,
    description: 'XSS: React dangerouslySetInnerHTML usage',
    owasp:       'A03:Injection',
  },
  {
    id:          'xss_document_write',
    severity:    'high',
    pattern:     /\bdocument\.write\s*\(/,
    description: 'XSS: document.write() is unsafe',
    owasp:       'A03:Injection',
  },
  {
    id:          'eval_usage',
    severity:    'high',
    pattern:     /(?<!\w)eval\s*\(/,
    description: 'Code injection: eval() with dynamic input',
    owasp:       'A03:Injection',
  },
  {
    id:          'new_function',
    severity:    'high',
    pattern:     /\bnew\s+Function\s*\(/,
    description: 'Code injection: new Function() constructor',
    owasp:       'A03:Injection',
  },
  {
    id:          'cmd_injection_exec',
    severity:    'high',
    pattern:     /child_process\.\w+\s*\(\s*[^'"`\n]{0,30}\+/,
    description: 'Command injection: child_process call with concatenated input',
    owasp:       'A03:Injection',
  },
  {
    id:          'sql_concatenation',
    severity:    'high',
    pattern:     /(?:query|execute|db\.run)\s*\(\s*(?:`[^`]*\$\{|['"][^'"]*'\s*\+)/i,
    description: 'SQL injection: query built with string concatenation or template literal',
    owasp:       'A03:Injection',
  },
  {
    id:          'path_traversal',
    severity:    'medium',
    pattern:     /(?:readFile|writeFile|readFileSync|writeFileSync|createReadStream)\s*\([^)]*\.\.\//,
    description: 'Path traversal: file operation with ".." in path',
    owasp:       'A01:BrokenAccessControl',
  },
  {
    id:          'open_redirect',
    severity:    'medium',
    pattern:     /(?:res\.redirect|window\.location(?:\.href)?\s*=)\s*(?:req\.|request\.|params\.|query\.)/,
    description: 'Open redirect: redirect target derived from request input',
    owasp:       'A01:BrokenAccessControl',
  },
  {
    id:          'insecure_random',
    severity:    'medium',
    pattern:     /Math\.random\s*\(\s*\)\s*(?:\*|\.toString).*(?:token|key|secret|password|nonce|salt)/i,
    description: 'Insecure random: Math.random() used for security-sensitive value',
    owasp:       'A02:CryptographicFailures',
  },
  {
    id:          'prototype_pollution',
    severity:    'medium',
    pattern:     /\[['"`]?__proto__['"`]?\]\s*=|\bObject\.assign\s*\(\s*(?:\{\s*\}|target),\s*(?:req\.|input\.)/,
    description: 'Prototype pollution risk: user-controlled key merged into object',
    owasp:       'A08:SoftwareIntegrityFailures',
  },
]

// ── New dependency detector ───────────────────────────────────────────────────

function scanNewDependencies(beforeContent, afterContent) {
  const issues = []
  try {
    const before = JSON.parse(beforeContent)
    const after  = JSON.parse(afterContent)
    const beforeDeps = { ...before.dependencies, ...before.devDependencies }
    const afterDeps  = { ...after.dependencies, ...after.devDependencies }
    for (const [pkg, ver] of Object.entries(afterDeps)) {
      if (!(pkg in beforeDeps)) {
        issues.push({
          severity:    'info',
          type:        'new_dependency',
          file:        'package.json',
          line:        null,
          pattern:     pkg,
          snippet:     `"${pkg}": "${ver}"`,
          description: `New dependency added: ${pkg}@${ver}. Verify this package is trusted and necessary.`,
          owasp:       'A06:VulnerableComponents',
        })
      }
    }
  } catch { /* malformed JSON — skip */ }
  return issues
}

// ── Line scanner ──────────────────────────────────────────────────────────────

function scanLines(content, rules, filePath) {
  const lines   = String(content).split('\n')
  const issues  = []

  for (const rule of rules) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // Skip obvious comments and test files to reduce false positives
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue
      if (/\.test\.[jt]sx?$|\.spec\.[jt]sx?$|__tests__/.test(filePath)) continue

      if (rule.pattern.test(line)) {
        issues.push({
          severity:    rule.severity,
          type:        rule.id,
          file:        filePath,
          line:        i + 1,
          pattern:     rule.pattern.toString().slice(1, 60),
          snippet:     line.trim().slice(0, 140).replace(/sk-[a-zA-Z0-9]{6,}/g, 'sk-[REDACTED]'),
          description: rule.description,
          owasp:       rule.owasp || null,
        })
      }
    }
  }

  return issues
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Scan all file mutations produced by an agent execution trace.
 *
 * @param {object[]} mutations  executionTrace.mutations from agentLoop
 * @returns {ScanResult}
 */
export function scanMutations(mutations = []) {
  const allIssues = []

  for (const mutation of mutations) {
    // Only scan content that was actually written (skip deletes and unchanged)
    const content = mutation?.afterContent
    const filePath = mutation?.path || ''
    if (!content || mutation?.action === 'delete') continue

    allIssues.push(
      ...scanLines(content, SECRET_RULES, filePath),
      ...scanLines(content, VULN_RULES,   filePath),
    )

    // New-dependency check: only when package.json was modified
    if (filePath.endsWith('package.json') && mutation?.beforeContent) {
      allIssues.push(...scanNewDependencies(mutation.beforeContent, content))
    }
  }

  const critical = allIssues.filter(i => i.severity === 'critical')
  const high     = allIssues.filter(i => i.severity === 'high')
  const medium   = allIssues.filter(i => i.severity === 'medium')
  const info     = allIssues.filter(i => i.severity === 'info')

  const passed   = critical.length === 0 && high.length === 0

  return {
    passed,
    issues:   allIssues,
    critical: critical.length,
    high:     high.length,
    medium:   medium.length,
    info:     info.length,
    summary:  allIssues.length === 0
      ? 'No security issues detected.'
      : `${allIssues.length} issue${allIssues.length !== 1 ? 's' : ''} found: ` +
        [
          critical.length ? `${critical.length} critical` : null,
          high.length     ? `${high.length} high`         : null,
          medium.length   ? `${medium.length} medium`     : null,
          info.length     ? `${info.length} info`         : null,
        ].filter(Boolean).join(', '),
  }
}

/**
 * Convenience: scan a single file's content directly (for use outside the
 * gate, e.g. the `security_scan` tool in agentExecutor).
 *
 * @param {string} content
 * @param {string} filePath
 * @returns {ScanResult}
 */
export function scanFile(content, filePath) {
  return scanMutations([{ afterContent: content, action: 'write', path: filePath, beforeContent: null }])
}

/**
 * @typedef {{
 *   passed:   boolean,
 *   issues:   SecurityIssue[],
 *   critical: number,
 *   high:     number,
 *   medium:   number,
 *   info:     number,
 *   summary:  string,
 * }} ScanResult
 *
 * @typedef {{
 *   severity:    'critical'|'high'|'medium'|'info',
 *   type:        string,
 *   file:        string,
 *   line:        number|null,
 *   pattern:     string,
 *   snippet:     string,
 *   description: string,
 *   owasp:       string|null,
 * }} SecurityIssue
 */
