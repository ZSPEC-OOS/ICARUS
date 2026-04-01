#!/usr/bin/env node
// ─── Logik CLI — headless agent runner + trace replay ─────────────────────────
//
// Usage:
//   node src/cli/logik-cli.mjs run "<task>" [options]
//   node src/cli/logik-cli.mjs plan "<task>" [options]
//   node src/cli/logik-cli.mjs replay <traceId>
//   node src/cli/logik-cli.mjs traces [--limit=N]
//
// Options:
//   --model=<id|name>      Model ID or name (default: env LOGIK_MODEL_ID)
//   --api-key=<key>        API key          (default: env LOGIK_API_KEY)
//   --base-url=<url>       API base URL     (default: env LOGIK_BASE_URL)
//   --dir=<path>           Working directory for file ops (default: cwd)
//   --config=<path>        JSON config file: { apiKey, baseUrl, modelId }
//   --dry-run              Print plan only — do not execute file writes
//   --no-color             Disable ANSI colours
//
// Environment variables:
//   LOGIK_MODEL_ID         e.g. claude-sonnet-4-6
//   LOGIK_API_KEY          Provider API key
//   LOGIK_BASE_URL         e.g. https://api.anthropic.com/v1
//   LOGIK_WORK_DIR         Defaults to process.cwd()

import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, join, dirname, relative } from 'node:path'
import { createInterface } from 'node:readline'
import process from 'node:process'

// ── Dynamic imports (services use browser-compatible exports) ─────────────────
// We load services dynamically so path resolution works from any cwd.
const __dirname_cli = dirname(new URL(import.meta.url).pathname)
const SRC = resolve(__dirname_cli, '..')

const { runAgentLoop }     = await import(`${SRC}/services/agentLoop.js`)
const { AGENT_TOOLS }      = await import(`${SRC}/services/agentTools.js`)
const traceStore           = await import(`${SRC}/services/toolTraceStore.js`)

// ── ANSI helpers ──────────────────────────────────────────────────────────────
let useColor = process.stdout.isTTY && !process.argv.includes('--no-color')

const C = {
  reset:   useColor ? '\x1b[0m'  : '',
  bold:    useColor ? '\x1b[1m'  : '',
  dim:     useColor ? '\x1b[2m'  : '',
  green:   useColor ? '\x1b[32m' : '',
  yellow:  useColor ? '\x1b[33m' : '',
  blue:    useColor ? '\x1b[34m' : '',
  cyan:    useColor ? '\x1b[36m' : '',
  red:     useColor ? '\x1b[31m' : '',
  magenta: useColor ? '\x1b[35m' : '',
}

const fmt = {
  ok:   (s) => `${C.green}${s}${C.reset}`,
  warn: (s) => `${C.yellow}${s}${C.reset}`,
  err:  (s) => `${C.red}${s}${C.reset}`,
  dim:  (s) => `${C.dim}${s}${C.reset}`,
  bold: (s) => `${C.bold}${s}${C.reset}`,
  info: (s) => `${C.cyan}${s}${C.reset}`,
  role: (s) => `${C.magenta}${s}${C.reset}`,
}

// ── Arg parser ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { _: [], flags: {}, opts: {} }
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq === -1) {
        args.flags[arg.slice(2)] = true
      } else {
        args.opts[arg.slice(2, eq)] = arg.slice(eq + 1)
      }
    } else {
      args._.push(arg)
    }
  }
  return args
}

// ── Config resolution ─────────────────────────────────────────────────────────
async function resolveModelConfig(args) {
  // 1. Explicit config file
  if (args.opts.config) {
    const raw = await readFile(resolve(args.opts.config), 'utf8')
    return JSON.parse(raw)
  }

  // 2. Auto-detect .logik/config.json in cwd or ancestors
  let dir = process.cwd()
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, '.logik', 'config.json')
    if (existsSync(candidate)) {
      const raw = await readFile(candidate, 'utf8')
      const cfg = JSON.parse(raw)
      process.stderr.write(fmt.dim(`[config] loaded ${candidate}\n`))
      return cfg
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  // 3. CLI flags / environment variables
  const apiKey  = args.opts['api-key']  || process.env.LOGIK_API_KEY  || ''
  const baseUrl = args.opts['base-url'] || process.env.LOGIK_BASE_URL || 'https://api.anthropic.com/v1'
  const modelId = args.opts['model']    || process.env.LOGIK_MODEL_ID || 'claude-sonnet-4-6'

  if (!apiKey) {
    console.error(fmt.err('Error: No API key found. Set LOGIK_API_KEY or use --api-key=<key>.'))
    console.error(fmt.dim('  Alternatively create .logik/config.json: { "apiKey": "...", "baseUrl": "...", "modelId": "..." }'))
    process.exit(1)
  }

  return { apiKey, baseUrl, modelId }
}

// ── Local file executor ───────────────────────────────────────────────────────
// Provides the same interface as agentExecutor but operates on the local filesystem.

function makeLocalExecutor(workDir) {
  async function safeRead(path) {
    const abs = resolve(workDir, path)
    if (!abs.startsWith(workDir)) throw new Error(`Path outside work dir: ${path}`)
    try { return await readFile(abs, 'utf8') } catch { return `File not found: ${path}` }
  }

  async function safeWrite(path, content) {
    const abs = resolve(workDir, path)
    if (!abs.startsWith(workDir)) throw new Error(`Path outside work dir: ${path}`)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
    return `Written: ${path}`
  }

  return async function executeTool(name, input) {
    switch (name) {
      case 'read_file':
        return safeRead(input.path)

      case 'read_many_files':
        return (await Promise.all((input.paths || []).map(p => safeRead(p)))).join('\n\n---\n\n')

      case 'write_file':
        return safeWrite(input.path, input.content || '')

      case 'edit_file': {
        const existing = await safeRead(input.path)
        if (String(existing).startsWith('File not found:')) return existing
        if (!String(existing).includes(input.old_str || '')) {
          return `edit_file failed: old_str not found in ${input.path}`
        }
        const updated = String(existing).replace(input.old_str, input.new_str || '')
        await safeWrite(input.path, updated)
        return `Edited: ${input.path}`
      }

      case 'delete_file': {
        const abs = resolve(workDir, input.path)
        if (!abs.startsWith(workDir)) throw new Error(`Path outside work dir: ${input.path}`)
        const { unlink } = await import('node:fs/promises')
        await unlink(abs).catch(() => {})
        return `Deleted: ${input.path}`
      }

      case 'list_directory': {
        const abs = resolve(workDir, input.path || '.')
        const entries = await readdir(abs, { withFileTypes: true }).catch(() => [])
        return entries.map(e => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`).join('\n')
      }

      case 'search_files': {
        // Simple recursive grep
        const pattern = new RegExp(input.pattern || '', 'i')
        const results = []
        async function walk(dir) {
          const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
          for (const e of entries) {
            if (e.name.startsWith('.')) continue
            const p = join(dir, e.name)
            if (e.isDirectory()) { await walk(p); continue }
            const content = await readFile(p, 'utf8').catch(() => '')
            const lines = content.split('\n')
            lines.forEach((line, i) => {
              if (pattern.test(line)) results.push(`${relative(workDir, p)}:${i + 1}: ${line.trim()}`)
            })
          }
        }
        await walk(resolve(workDir, input.path || '.'))
        return results.slice(0, 200).join('\n') || 'No matches.'
      }

      case 'grep': {
        const pattern = new RegExp(input.pattern || '', 'i')
        const abs = resolve(workDir, input.path || '.')
        const content = await readFile(abs, 'utf8').catch(() => '')
        const matches = content.split('\n')
          .map((line, i) => pattern.test(line) ? `${i + 1}: ${line}` : null)
          .filter(Boolean)
        return matches.join('\n') || 'No matches.'
      }

      case 'run_command':
        // Run shell commands via child_process in CLI mode
        try {
          const { execFile } = await import('node:child_process')
          const { promisify } = await import('node:util')
          const execFileAsync = promisify(execFile)
          const parts = (input.command || '').split(/\s+/)
          const { stdout, stderr } = await execFileAsync(parts[0], parts.slice(1), {
            cwd: workDir,
            timeout: 30000,
            maxBuffer: 1024 * 1024,
          })
          return `${stdout}${stderr}`
        } catch (err) {
          return `Command failed: ${err.message}`
        }

      default:
        return `Tool '${name}' not supported in CLI mode.`
    }
  }
}

// ── Event renderer (stdout) ───────────────────────────────────────────────────
function makeEventRenderer(verbosity = 'normal') {
  return function onEvent(ev) {
    switch (ev.type) {
      case 'turn':
        process.stdout.write(fmt.dim(`\n[turn ${ev.turn}] `))
        break
      case 'text_delta':
        process.stdout.write(ev.delta || '')
        break
      case 'tool_start':
        if (verbosity !== 'quiet') {
          process.stdout.write(`\n  ${fmt.info('●')} ${ev.name}(${JSON.stringify(ev.input || {}).slice(0, 80)})\n`)
        }
        break
      case 'tool_done':
        if (ev.error && verbosity !== 'quiet') {
          process.stdout.write(`    ${fmt.err('✗')} ${ev.error}\n`)
        }
        break
      case 'file_write':
        process.stdout.write(`  ${fmt.ok('✏')} ${ev.action}: ${ev.path}\n`)
        break
      case 'orchestration':
        process.stdout.write(
          `\n  ${fmt.role('◈')} role=${fmt.bold(ev.role)} conf=${Math.round((ev.confidence ?? 0) * 100)}%` +
          ` model=${ev.modelId || '—'} strategy=${ev.strategy}\n`
        )
        break
      case 'orchestration_fallback':
        process.stdout.write(
          `  ${fmt.warn('⚠')} fallback: ${ev.fromModelId} → ${ev.toModelId} (${ev.error})\n`
        )
        break
      case 'orchestration_ensemble':
        process.stdout.write(
          `  ${fmt.info('≡')} ensemble: [${(ev.modelsUsed || []).join(', ')}]\n`
        )
        break
      case 'usage':
        if (verbosity === 'verbose') {
          process.stdout.write(fmt.dim(`  ↑${ev.inputTokens || 0} ↓${ev.outputTokens || 0}\n`))
        }
        break
      case 'error':
        process.stderr.write(`${fmt.err('Error:')} ${ev.message}\n`)
        break
      case 'done':
        process.stdout.write(`\n${fmt.ok('✓')} Agent complete. Files: ${(ev.filesChanged || []).join(', ') || 'none'}\n`)
        break
      default:
        break
    }
  }
}

// ── Subcommands ───────────────────────────────────────────────────────────────

async function cmdRun(task, args) {
  const modelConfig = await resolveModelConfig(args)
  const workDir     = resolve(args.opts.dir || process.env.LOGIK_WORK_DIR || process.cwd())
  const isDryRun    = args.flags['dry-run']
  const verbosity   = args.flags.quiet ? 'quiet' : args.flags.verbose ? 'verbose' : 'normal'

  console.log(`${fmt.bold('Logik CLI')} — ${fmt.info('run')} mode`)
  console.log(`  Task:  ${task.slice(0, 120)}`)
  console.log(`  Model: ${modelConfig.modelId}`)
  console.log(`  Dir:   ${workDir}`)
  if (isDryRun) console.log(`  ${fmt.warn('DRY RUN — file writes will be skipped')}`)
  console.log('')

  const ctrl = new AbortController()
  process.on('SIGINT', () => { ctrl.abort(); process.stdout.write('\n[aborted]\n') })

  const executor = makeLocalExecutor(workDir)
  const wrappedExecutor = isDryRun
    ? async (name, input) => {
        if (['write_file', 'edit_file', 'delete_file'].includes(name)) {
          process.stdout.write(fmt.dim(`  [dry-run] ${name}(${input.path})\n`))
          return `[dry-run] skipped: ${name}`
        }
        return executor(name, input)
      }
    : executor

  const tools = AGENT_TOOLS
  const systemPrompt = `You are Logik, an expert coding assistant. Work in the directory: ${workDir}. Follow project conventions.`

  await runAgentLoop({
    task,
    systemPrompt,
    tools,
    executeTool: wrappedExecutor,
    modelConfig,
    onEvent: makeEventRenderer(verbosity),
    signal: ctrl.signal,
  })
}

async function cmdPlan(task, args) {
  // Plan mode: agent may only read files, not write them
  const modelConfig = await resolveModelConfig(args)
  const workDir     = resolve(args.opts.dir || process.env.LOGIK_WORK_DIR || process.cwd())

  console.log(`${fmt.bold('Logik CLI')} — ${fmt.info('plan')} mode`)
  console.log(`  Task:  ${task.slice(0, 120)}`)
  console.log(`  Model: ${modelConfig.modelId}`)
  console.log('')

  const READONLY_TOOLS = new Set([
    'read_file', 'read_many_files', 'list_directory', 'search_files', 'grep',
  ])
  const readonlyTools = AGENT_TOOLS.filter(t => READONLY_TOOLS.has(t.name))
  const executor = makeLocalExecutor(workDir)
  const ctrl = new AbortController()
  process.on('SIGINT', () => ctrl.abort())

  await runAgentLoop({
    task: `[PLAN MODE — analysis only, no file writes]\n${task}`,
    systemPrompt: `You are Logik in plan mode. Analyze the codebase in ${workDir} and output a detailed plan. Do NOT write any files.`,
    tools: readonlyTools,
    executeTool: executor,
    modelConfig,
    onEvent: makeEventRenderer('normal'),
    signal: ctrl.signal,
  })
}

async function cmdReplay(traceId, args) {
  const workDir  = resolve(args.opts.dir || process.env.LOGIK_WORK_DIR || process.cwd())
  const executor = makeLocalExecutor(workDir)

  console.log(`${fmt.bold('Logik CLI')} — ${fmt.info('replay')} trace ${traceId}`)
  try {
    const result = await traceStore.replayTrace(traceId, executor)
    console.log(fmt.ok('✓ Replay complete'))
    console.log(`  Tool:      ${result.toolName}`)
    console.log(`  Recorded:  ${result.originalTimestamp}`)
    console.log(`  Output:\n${String(result.output).slice(0, 600)}`)
  } catch (err) {
    console.error(fmt.err(`Replay failed: ${err.message}`))
    process.exit(1)
  }
}

async function cmdTraces(args) {
  const limit = parseInt(args.opts.limit || '20', 10)
  // traceStore stores in localStorage — in CLI we read from the disk file if available
  const tracePath = resolve(process.env.LOGIK_WORK_DIR || process.cwd(), '.logik', 'traces.jsonl')
  if (!existsSync(tracePath)) {
    console.log(fmt.dim('No trace file found at .logik/traces.jsonl'))
    console.log(fmt.dim('Traces are written by the web UI to localStorage and optionally to disk.'))
    return
  }
  const raw = await readFile(tracePath, 'utf8')
  const entries = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const recent = entries.slice(-limit).reverse()
  console.log(`${fmt.bold('Recent traces')} (${recent.length} of ${entries.length}):`)
  for (const e of recent) {
    const icon = e.type === 'orchestration_decision' ? fmt.role('◈') :
                 e.status === 'error'                ? fmt.err('✗')  : fmt.ok('✓')
    const label = e.type === 'orchestration_decision'
      ? `${e.role} → ${e.modelId} (${Math.round((e.confidence ?? 0) * 100)}%)`
      : `${e.toolName}`
    console.log(`  ${icon} ${fmt.dim(e.traceId)} ${label} ${fmt.dim(e.timestamp)}`)
  }
}

// ── Help ──────────────────────────────────────────────────────────────────────
function printHelp() {
  console.log(`
${fmt.bold('logik-cli')} — headless agent runner + trace replay

${fmt.bold('USAGE')}
  logik-cli run "<task>"   [options]   Run agent on a task
  logik-cli plan "<task>"  [options]   Analyse only, no file writes
  logik-cli replay <id>    [options]   Re-execute a recorded tool trace
  logik-cli traces         [options]   List recent trace entries

${fmt.bold('OPTIONS')}
  --model=<id>          Model ID / name  (env: LOGIK_MODEL_ID)
  --api-key=<key>       API key          (env: LOGIK_API_KEY)
  --base-url=<url>      API base URL     (env: LOGIK_BASE_URL)
  --dir=<path>          Working directory (env: LOGIK_WORK_DIR, default: cwd)
  --config=<path>       JSON config file { apiKey, baseUrl, modelId }
  --dry-run             Skip file writes (run mode only)
  --verbose             Extra token usage output
  --quiet               Suppress tool call lines
  --no-color            Disable ANSI colours
  --limit=N             Max traces to show (traces command, default: 20)

${fmt.bold('ZERO-CONFIG ONBOARDING')}
  1. Create .logik/config.json in your project root:
     ${fmt.dim('{ "apiKey": "sk-...", "baseUrl": "https://api.anthropic.com/v1", "modelId": "claude-sonnet-4-6" }')}
  2. Run: ${fmt.info('logik-cli run "add error handling to utils/api.js"')}

${fmt.bold('EXAMPLES')}
  logik-cli run "fix the authentication bug in auth/login.js"
  logik-cli plan "refactor the data layer to use a repository pattern"
  logik-cli run "write tests for src/utils/" --dry-run
  logik-cli replay trace_1h2x3y_abc123
  LOGIK_API_KEY=sk-... logik-cli run "create a CI workflow" --model=claude-haiku-4-5-20251001
`)
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2)
  const args = parseArgs(argv)
  const [subcmd, ...rest] = args._

  if (!subcmd || args.flags.help || subcmd === 'help') {
    printHelp()
    process.exit(0)
  }

  try {
    switch (subcmd) {
      case 'run': {
        const task = rest.join(' ').trim()
        if (!task) { console.error(fmt.err('Error: task is required — logik-cli run "<task>"')); process.exit(1) }
        await cmdRun(task, args)
        break
      }
      case 'plan': {
        const task = rest.join(' ').trim()
        if (!task) { console.error(fmt.err('Error: task is required — logik-cli plan "<task>"')); process.exit(1) }
        await cmdPlan(task, args)
        break
      }
      case 'replay': {
        const traceId = rest[0]
        if (!traceId) { console.error(fmt.err('Error: traceId is required — logik-cli replay <traceId>')); process.exit(1) }
        await cmdReplay(traceId, args)
        break
      }
      case 'traces':
        await cmdTraces(args)
        break
      default:
        console.error(fmt.err(`Unknown command: ${subcmd}`))
        printHelp()
        process.exit(1)
    }
  } catch (err) {
    console.error(fmt.err(`Fatal: ${err.message}`))
    if (process.env.DEBUG) console.error(err.stack)
    process.exit(1)
  }
}

main()
