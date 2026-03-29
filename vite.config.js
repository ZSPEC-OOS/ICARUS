import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { getMetricsDashboard } from './src/services/efficiency/metricsService.js'

let spawn = null

async function ensureSpawn() {
  if (spawn) return spawn
  try {
    ;({ spawn } = await import('node:child_process'))
  } catch {
    spawn = null
  }
  return spawn
}

// Dev-only exec bridge â lets the LOGIK terminal and Tools tab run real shell
// commands on your machine during `vite dev`. Never included in production builds.
function tokenize(cmdStr) {
  const tokens = []
  let cur = ''
  let quote = null
  for (const ch of cmdStr.trim()) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === ' ' || ch === '\t') {
      if (cur) { tokens.push(cur); cur = '' }
    } else {
      cur += ch
    }
  }
  if (cur) tokens.push(cur)
  return tokens
}

function execBridgePlugin() {
  return {
    name: 'logik-exec-bridge',
    apply: 'serve',
    configureServer(server) {
      if (!spawn) return
      server.middlewares.use('/api/exec-stream', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
          let parsed
          try { parsed = JSON.parse(body) } catch { res.statusCode = 400; res.end('Bad JSON'); return }
          const { cmd: cmdStr, cwd, timeout = 60000 } = parsed
          if (!cmdStr) { res.statusCode = 400; res.end('Missing cmd'); return }
          const tokens = tokenize(cmdStr)
          if (tokens.length === 0) { res.statusCode = 400; res.end('Empty command'); return }
          const [cmd, ...args] = tokens
          const workDir = cwd || process.cwd()
          res.setHeader('Content-Type',  'text/event-stream')
          res.setHeader('Cache-Control', 'no-cache')
          res.setHeader('Connection',    'keep-alive')
          res.setHeader('Access-Control-Allow-Origin', '*')
          const send = (type, data) => res.write(`data: ${JSON.stringify({ type, data })}\n\n`)
          const child = spawn(cmd, args, { cwd: workDir, shell: false, env: process.env })
          if (parsed.stdin != null) { child.stdin.write(String(parsed.stdin)); child.stdin.end() }
          child.stdout.on('data', d => send('stdout', d.toString()))
          child.stderr.on('data', d => send('stderr', d.toString()))
          const timer = setTimeout(() => { child.kill('SIGTERM'); send('stderr', '\n[exec-bridge] timeout') }, timeout)
          child.on('close', code => { clearTimeout(timer); send('done', code ?? 1); res.end() })
          child.on('error', err  => { clearTimeout(timer); send('error', err.message); res.end() })
        })
      })

      server.middlewares.use('/api/exec', (req, res) => {
        if (req.method === 'GET') {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: true, version: '1.0' }))
          return
        }
        if (req.method !== 'POST') { res.statusCode = 405; res.end('Method Not Allowed'); return }
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
          let parsed
          try { parsed = JSON.parse(body) } catch { res.statusCode = 400; res.end('Bad JSON'); return }
          const { cmd: cmdStr, cwd, timeout = 60000 } = parsed
          if (!cmdStr || typeof cmdStr !== 'string') { res.statusCode = 400; res.end('Missing cmd'); return }
          const tokens = tokenize(cmdStr)
          if (tokens.length === 0) { res.statusCode = 400; res.end('Empty command'); return }
          const [cmd, ...args] = tokens
          const workDir = cwd || process.cwd()
          let stdout = ''
          let stderr = ''
          const child = spawn(cmd, args, { cwd: workDir, shell: false, env: process.env })
          if (parsed.stdin != null) { child.stdin.write(String(parsed.stdin)); child.stdin.end() }
          child.stdout.on('data', d => { stdout += d.toString() })
          child.stderr.on('data', d => { stderr += d.toString() })
          const timer = setTimeout(() => { child.kill('SIGTERM'); stderr += `\n[exec-bridge] timeout after ${timeout}ms` }, timeout)
          child.on('close', (code) => {
            clearTimeout(timer)
            res.setHeader('Content-Type', 'application/json')
            res.setHeader('Access-Control-Allow-Origin', '*')
            res.end(JSON.stringify({ stdout: stdout.slice(0, 100_000), stderr: stderr.slice(0, 10_000), exitCode: code ?? 1 }))
          })
          child.on('error', (err) => {
            clearTimeout(timer)
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ stdout: '', stderr: err.message, exitCode: 127 }))
          })
        })
      })

      server.middlewares.use('/api/metrics/dashboard', (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end('Method Not Allowed'); return }
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.end(JSON.stringify(getMetricsDashboard()))
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), execBridgePlugin()],

  server: {
    proxy: {
      // Proxy external AI API calls through Vite's Node server to avoid CORS
      '/api/proxy/moonshot': {
        target: 'https://api.moonshot.cn',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/proxy\/moonshot/, '/v1'),
      },
      '/api/proxy/anthropic': {
        target: 'https://api.anthropic.com',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/proxy\/anthropic/, '/v1'),
      },
      '/api/proxy/openai': {
        target: 'https://api.openai.com',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/proxy\/openai/, '/v1'),
      },
      // Gemini uses Google's OpenAI-compatible endpoint (/v1beta/openai/...)
      '/api/proxy/gemini': {
        target: 'https://generativelanguage.googleapis.com',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/proxy\/gemini/, '/v1beta/openai'),
      },
      // ââ New providers âââââââââââââââââââââââââââââââââââââââââââââââââââââ
      '/api/proxy/groq': {
        target: 'https://api.groq.com',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/proxy\/groq/, '/openai/v1'),
      },
      '/api/proxy/mistral': {
        target: 'https://api.mistral.ai',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/proxy\/mistral/, '/v1'),
      },
      '/api/proxy/codestral': {
        target: 'https://codestral.mistral.ai',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/proxy\/codestral/, '/v1'),
      },
      '/api/proxy/deepseek': {
        target: 'https://api.deepseek.com',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/proxy\/deepseek/, '/v1'),
      },
      '/api/proxy/xai': {
        target: 'https://api.x.ai',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/proxy\/xai/, '/v1'),
      },
      '/api/proxy/openrouter': {
        target: 'https://openrouter.ai',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/proxy\/openrouter/, '/api/v1'),
      },
      '/api/proxy/tavily': {
        target: 'https://api.tavily.com',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/proxy\/tavily/, ''),
      },
    },
  },
})
