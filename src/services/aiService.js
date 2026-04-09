const MODELS_KEY    = 'wrkflow:models'       // localStorage  — config only, NO api keys
const KEYS_SS_KEY   = 'wrkflow:keys'         // sessionStorage — api keys (primary, clears on tab close)
const KEYS_LS_KEY   = 'wrkflow:keysbak'      // localStorage  — api keys encrypted backup (iOS resilience)
const SESSION_KEY_K = 'wrkflow:sk'           // sessionStorage — per-session random cipher key

// Lazily generate or recall a cryptographically-random per-session key.
// The key lives only in sessionStorage (cleared when the tab closes) and is
// never embedded in source code — makes offline rainbow-table attacks infeasible.
function getSessionKey() {
  try {
    let sk = sessionStorage.getItem(SESSION_KEY_K)
    if (!sk) {
      const raw = new Uint8Array(32)
      crypto.getRandomValues(raw)
      sk = Array.from(raw).map(b => String.fromCharCode(b)).join('')
      sessionStorage.setItem(SESSION_KEY_K, btoa(sk))
    } else {
      sk = atob(sk)
    }
    return sk
  } catch {
    // Fallback: fixed key (same behaviour as before, but only reached in restricted environments)
    return 'icarus-fallback-key-xor'
  }
}

function encrypt(text) {
  if (!text) return ''
  const key = getSessionKey()
  return btoa(text.split('').map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ key.charCodeAt(i % key.length))).join(''))
}

function decrypt(text) {
  if (!text) return ''
  try {
    const key = getSessionKey()
    return atob(text).split('').map((c, i) => String.fromCharCode(c.charCodeAt(0) ^ key.charCodeAt(i % key.length))).join('')
  } catch {
    return ''
  }
}

const DEFAULT_MODELS = []

// ── Preset catalogue — used by the "Add Model" button in Settings ─────────────
// Organised by provider.  baseUrl must include any path prefix the provider
// puts before /chat/completions (e.g. Groq uses /openai/v1, xAI uses /v1).
export const MODEL_PRESETS = [
  // ── Anthropic ──────────────────────────────────────────────────────────────
  { id: 'preset-claude-opus-46',   name: 'Claude Opus 4.6',      apiKey: '', baseUrl: 'https://api.anthropic.com/v1',                         modelId: 'claude-opus-4-6'            },
  { id: 'preset-claude-sonnet-46', name: 'Claude Sonnet 4.6',    apiKey: '', baseUrl: 'https://api.anthropic.com/v1',                         modelId: 'claude-sonnet-4-6'          },
  { id: 'preset-claude-haiku-45',  name: 'Claude Haiku 4.5',     apiKey: '', baseUrl: 'https://api.anthropic.com/v1',                         modelId: 'claude-haiku-4-5-20251001'  },
  // ── OpenAI ─────────────────────────────────────────────────────────────────
  { id: 'preset-gpt-4-1',          name: 'GPT-4.1',              apiKey: '', baseUrl: 'https://api.openai.com/v1',                            modelId: 'gpt-4.1'                    },
  { id: 'preset-gpt-4o',           name: 'GPT-4o',               apiKey: '', baseUrl: 'https://api.openai.com/v1',                            modelId: 'gpt-4o'                     },
  { id: 'preset-gpt-4o-mini',      name: 'GPT-4o mini',          apiKey: '', baseUrl: 'https://api.openai.com/v1',                            modelId: 'gpt-4o-mini'                },
  { id: 'preset-o4-mini',          name: 'o4-mini',              apiKey: '', baseUrl: 'https://api.openai.com/v1',                            modelId: 'o4-mini'                    },
  { id: 'preset-o3',               name: 'o3',                   apiKey: '', baseUrl: 'https://api.openai.com/v1',                            modelId: 'o3'                         },
  // ── Google Gemini (OpenAI-compat endpoint) ─────────────────────────────────
  { id: 'preset-gemini-25-pro',    name: 'Gemini 2.5 Pro',       apiKey: '', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', modelId: 'gemini-2.5-pro-preview-03-25' },
  { id: 'preset-gemini-20-flash',  name: 'Gemini 2.0 Flash',     apiKey: '', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', modelId: 'gemini-2.0-flash'             },
  { id: 'preset-gemini-15-pro',    name: 'Gemini 1.5 Pro',       apiKey: '', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', modelId: 'gemini-1.5-pro'               },
  // ── Groq (free tier, fast inference) ─────────────────────────────────────
  { id: 'preset-groq-llama33',     name: 'Llama 3.3 70B (Groq)', apiKey: '', baseUrl: 'https://api.groq.com/openai/v1',                       modelId: 'llama-3.3-70b-versatile'    },
  { id: 'preset-groq-deepseek',    name: 'DeepSeek R1 (Groq)',   apiKey: '', baseUrl: 'https://api.groq.com/openai/v1',                       modelId: 'deepseek-r1-distill-llama-70b' },
  // ── Mistral ────────────────────────────────────────────────────────────────
  { id: 'preset-mistral-large',    name: 'Mistral Large',        apiKey: '', baseUrl: 'https://api.mistral.ai/v1',                            modelId: 'mistral-large-latest'       },
  { id: 'preset-codestral',        name: 'Codestral',            apiKey: '', baseUrl: 'https://codestral.mistral.ai/v1',                      modelId: 'codestral-latest'           },
  // ── DeepSeek ───────────────────────────────────────────────────────────────
  { id: 'preset-deepseek-v3',      name: 'DeepSeek V3',          apiKey: '', baseUrl: 'https://api.deepseek.com/v1',                          modelId: 'deepseek-chat'              },
  { id: 'preset-deepseek-r1',      name: 'DeepSeek R1',          apiKey: '', baseUrl: 'https://api.deepseek.com/v1',                          modelId: 'deepseek-reasoner'          },
  // ── xAI / Grok ─────────────────────────────────────────────────────────────
  { id: 'preset-grok-3',           name: 'Grok 3',               apiKey: '', baseUrl: 'https://api.x.ai/v1',                                  modelId: 'grok-3'                     },
  { id: 'preset-grok-3-mini',      name: 'Grok 3 Mini',          apiKey: '', baseUrl: 'https://api.x.ai/v1',                                  modelId: 'grok-3-mini'                },
  // ── OpenRouter (meta-router — one key, hundreds of models) ─────────────────
  { id: 'preset-openrouter',       name: 'OpenRouter',           apiKey: '', baseUrl: 'https://openrouter.ai/api/v1',                         modelId: 'meta-llama/llama-3.3-70b-instruct:free' },
  // ── Ollama (local — no key needed) ─────────────────────────────────────────
  { id: 'preset-ollama',           name: 'Ollama (local)',        apiKey: 'ollama', baseUrl: 'http://localhost:11434/v1',                     modelId: 'llama3.2'                   },
]

// IDs that were once automatically included but have since been removed from
// DEFAULT_MODELS.  They are silently stripped from saved localStorage configs
// on next load so users don't see orphaned entries they never manually added.
const LEGACY_PRESET_IDS = new Set([
  'preset-kimi-k2-5',
])

export function loadModels() {
  try {
    // Load model configs (without API keys) from localStorage
    const raw    = localStorage.getItem(MODELS_KEY)
    const parsed = raw !== null ? JSON.parse(raw) : null

    // Migration: strip legacy presets that were removed from DEFAULT_MODELS
    const migrated = parsed
      ? parsed.filter(m => !LEGACY_PRESET_IDS.has(m.id))
      : null

    const configs = migrated || DEFAULT_MODELS

    // Load API keys — sessionStorage (primary) with localStorage backup fallback for iOS
    let keys = {}
    try {
      const keysRaw = sessionStorage.getItem(KEYS_SS_KEY)
      if (keysRaw) {
        const decrypted = JSON.parse(decrypt(keysRaw))
        keys = decrypted || {}
      } else {
        // sessionStorage was cleared (iOS tab kill) — recover from localStorage backup
        const bakRaw = localStorage.getItem(KEYS_LS_KEY)
        if (bakRaw) {
          const bakDecrypted = JSON.parse(decrypt(bakRaw))
          keys = bakDecrypted || {}
          // Re-seed sessionStorage from backup so future reads are fast
          sessionStorage.setItem(KEYS_SS_KEY, encrypt(JSON.stringify(keys)))
        }
      }
    } catch {}

    // Merge: sessionStorage key wins; fall back to any key still in localStorage config (migration)
    return configs.map(m => ({ ...m, apiKey: keys[m.id] ?? m.apiKey ?? '' }))
  } catch {
    return DEFAULT_MODELS
  }
}

export function saveModels(models) {
  // Persist config (no API keys) to localStorage
  const configs = models.map(({ apiKey, ...rest }) => rest)
  localStorage.setItem(MODELS_KEY, JSON.stringify(configs))

  // Persist API keys — sessionStorage (primary) + localStorage backup (iOS resilience)
  const keys = {}
  models.forEach(m => { if (m.apiKey) keys[m.id] = m.apiKey })
  const encrypted = encrypt(JSON.stringify(keys))
  sessionStorage.setItem(KEYS_SS_KEY, encrypted)
  try { localStorage.setItem(KEYS_LS_KEY, encrypted) } catch {}
}

// ── Web-search API key (Tavily) ───────────────────────────────────────────────
const SEARCH_KEY_SS = 'icarus:searchkey'

export function loadSearchKey() {
  try {
    const raw = sessionStorage.getItem(SEARCH_KEY_SS)
    return raw ? decrypt(raw) : ''
  } catch { return '' }
}

export function saveSearchKey(key) {
  try {
    if (key) sessionStorage.setItem(SEARCH_KEY_SS, encrypt(key))
    else      sessionStorage.removeItem(SEARCH_KEY_SS)
  } catch {}
}

// Wipe all stored API keys from both storages
export function clearApiKeys() {
  sessionStorage.removeItem(KEYS_SS_KEY)
  try {
    const raw = localStorage.getItem(MODELS_KEY)
    if (raw) {
      const models = JSON.parse(raw)
      localStorage.setItem(MODELS_KEY, JSON.stringify(
        models.map(({ apiKey, ...rest }) => rest)
      ))
    }
  } catch {}
}

// ── Test connection ───────────────────────────────────────────────────────────
// Sends a minimal non-streaming request to verify the API key and endpoint work.
// Returns { ok: true, model, ms, warning? } or { ok: false, error }
export async function testModelConnection(modelConfig) {
  const { apiKey, baseUrl, modelId } = modelConfig || {}
  if (!apiKey)   return { ok: false, error: 'No API key entered' }
  if (!baseUrl)  return { ok: false, error: 'No base URL configured' }
  if (!modelId)  return { ok: false, error: 'No model ID configured' }

  // Validate that baseUrl is a well-formed absolute URL
  let parsedUrl
  try {
    parsedUrl = new URL(baseUrl)
    if (!parsedUrl.protocol.startsWith('http')) throw new Error('not http')
  } catch {
    return { ok: false, error: `Invalid base URL — must be a full URL (e.g. https://api.openai.com/v1)` }
  }

  // In dev mode, the Vite proxy strips the URL path and replaces it with the
  // correct /v1 prefix automatically.  This means a test against a broken path
  // like https://api.anthropic.com/v99-BROKEN will PASS even though the real
  // URL is wrong — the proxy silently fixes it.  Detect this and warn the user
  // so they aren't misled into thinking a broken URL is working.
  let warning = null
  if (IS_DEV) {
    const proxied = devProxyUrl(baseUrl)
    if (proxied !== baseUrl) {
      // The proxy will override the URL path — check if the configured path looks right.
      // Most providers use /v1 (or a subpath of it) as the base.
      const path = parsedUrl.pathname.replace(/\/$/, '')
      const looksValid =
        path === '/v1' ||
        path.startsWith('/v1/') ||
        path.endsWith('/v1') ||
        path.includes('/v1beta') ||
        path.includes('/openai/v1')
      if (!looksValid) {
        warning =
          `Dev proxy overrode the URL path — test passed but the configured path "${parsedUrl.pathname}" looks wrong. ` +
          `It would fail in production. Expected something like /v1.`
      }
    }
  }

  const t0 = Date.now()
  try {
    const isAnthropic = isAnthropicUrl(baseUrl)
    let url, options

    if (isAnthropic) {
      ;({ url, options } = buildAnthropicRequest(baseUrl, apiKey, modelId, {
        max_tokens: 16,
        stream: false,
        messages: [{ role: 'user', content: 'Hi' }],
      }, modelConfig))
    } else {
      ;({ url, options } = buildOpenAIRequest(baseUrl, apiKey, modelId, {
        max_tokens: 16,
        stream: false,
        messages: [{ role: 'user', content: 'Hi' }],
      }, modelConfig))
    }

    const res = await fetch(url, options)
    const ms  = Date.now() - t0
    if (!res.ok) {
      const text = await res.text()
      let msg = `HTTP ${res.status}`
      try {
        const parsed = JSON.parse(text)
        msg = parsed?.error?.message || parsed?.message || msg
      } catch {}
      return { ok: false, error: msg }
    }
    return { ok: true, model: modelId, ms, warning }
  } catch (e) {
    const isCors = e.message === 'Failed to fetch' || e.name === 'TypeError'
    return {
      ok: false,
      error: isCors
        ? 'Network error — likely a CORS block. Restart the dev server so the new proxy takes effect.'
        : e.message,
    }
  }
}

// Test Tavily web-search API key with a minimal search request
export async function testSearchConnection(apiKey) {
  if (!apiKey) return { ok: false, error: 'No API key entered' }
  const t0 = Date.now()
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query: 'test', max_results: 1 }),
    })
    const ms = Date.now() - t0
    if (!res.ok) {
      const text = await res.text()
      let msg = `HTTP ${res.status}`
      try { msg = JSON.parse(text)?.detail || msg } catch {}
      return { ok: false, error: msg }
    }
    return { ok: true, ms }
  } catch (e) {
    return { ok: false, error: e.message || 'Network error' }
  }
}

function isAnthropicUrl(baseUrl) {
  return baseUrl.includes('api.anthropic.com')
}

// ── Proxy detection ───────────────────────────────────────────────────────────
// When the Firebase Cloud Function is deployed, VITE_AI_PROXY_URL is set to
// https://us-central1-wolfkrow-ea567.cloudfunctions.net/api
// The proxy holds all API keys as Firebase Secrets — the browser key field
// can be left blank and the model will still work.
const PROXY_URL = import.meta.env?.VITE_AI_PROXY_URL || null

// In dev mode Vite proxies these paths through Node to avoid browser CORS blocks.
// In production the app must be served with a reverse proxy or use PROXY_URL.
const IS_DEV = import.meta.env?.DEV ?? false
function devProxyUrl(baseUrl) {
  if (!IS_DEV) return baseUrl
  if (baseUrl.includes('moonshot.cn'))           return '/api/proxy/moonshot'
  if (baseUrl.includes('api.anthropic.com'))     return '/api/proxy/anthropic'
  if (baseUrl.includes('api.openai.com'))        return '/api/proxy/openai'
  if (baseUrl.includes('googleapis.com'))        return '/api/proxy/gemini'
  if (baseUrl.includes('api.groq.com'))          return '/api/proxy/groq'
  if (baseUrl.includes('codestral.mistral.ai'))  return '/api/proxy/codestral'
  if (baseUrl.includes('api.mistral.ai'))        return '/api/proxy/mistral'
  if (baseUrl.includes('api.deepseek.com'))      return '/api/proxy/deepseek'
  if (baseUrl.includes('api.x.ai'))              return '/api/proxy/xai'
  if (baseUrl.includes('openrouter.ai'))         return '/api/proxy/openrouter'
  return baseUrl
}

import { THINKING_BUDGET_TOKENS, STREAM_CHUNK_TIMEOUT_MS } from '../config/constants.js'

// Per-chunk read timeout — prevents a stalled stream from hanging the agent loop
// indefinitely.  If no data arrives within this window the stream is aborted.
function readChunkWithTimeout(reader) {
  let timeoutId
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Stream stalled — no data received for ${STREAM_CHUNK_TIMEOUT_MS / 1000} s`)),
      STREAM_CHUNK_TIMEOUT_MS
    )
  })
  return Promise.race([reader.read(), timeoutPromise]).finally(() => clearTimeout(timeoutId))
}

// Detect provider name from baseUrl for the proxy request
function detectProvider(baseUrl) {
  if (baseUrl.includes('anthropic.com'))    return 'anthropic'
  if (baseUrl.includes('moonshot.cn'))      return 'kimi'
  if (baseUrl.includes('openai.com'))       return 'openai'
  if (baseUrl.includes('googleapis.com'))   return 'gemini'
  return 'openai'   // default: treat any other URL as OpenAI-compatible
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const DEFAULT_MAX_TOKENS = 8192

async function fetchWithRetry(url, options, maxRetries = 4) {
  let delay = 2000
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options)
      if (res.status === 429 && attempt < maxRetries) {
        const retryAfter = res.headers.get('retry-after')
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : delay
        await sleep(waitMs)
        delay = Math.min(delay * 2, 30000)
        continue
      }
      return res
    } catch (err) {
      // AbortError must propagate immediately — never retry a user-initiated abort
      if (err.name === 'AbortError') throw err
      // Network error / DNS failure etc.
      if (attempt < maxRetries) {
        await sleep(delay)
        delay = Math.min(delay * 2, 30000)
        continue
      }
      throw err
    }
  }
}

async function readSSEStream(res, onChunk, extractDelta, signal) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fullText = ''

  while (true) {
    if (signal?.aborted) {
      reader.cancel()
      break
    }
    let done, value
    try {
      ;({ done, value } = await readChunkWithTimeout(reader))
    } catch (err) {
      reader.cancel()
      throw err
    }
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6)
      if (data === '[DONE]') continue
      try {
        const delta = extractDelta(JSON.parse(data))
        if (delta) {
          fullText += delta
          onChunk?.(fullText)
        }
      } catch (e) {
        console.warn('[ICARUS] readSSEStream: skipped malformed event —', e.message, '| data:', data?.slice(0, 80))
      }
    }
  }

  return fullText
}

// Build request options — routes through Firebase proxy when VITE_AI_PROXY_URL is set.
// modelConfig is passed through to apply temperature and extended-thinking settings.
function buildAnthropicRequest(baseUrl, apiKey, modelId, body, modelConfig = {}) {
  // Apply temperature — extended thinking requires temperature = 1
  if (modelConfig.enableThinking) {
    body.thinking  = { type: 'enabled', budget_tokens: modelConfig.thinkingBudget || THINKING_BUDGET_TOKENS }
    body.temperature = 1   // required by Anthropic when thinking is enabled
  } else if (modelConfig.temperature !== undefined) {
    body.temperature = modelConfig.temperature
  }

  if (PROXY_URL) {
    return {
      url: `${PROXY_URL}/proxy`,
      options: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'anthropic', body: { model: modelId, ...body } }),
      },
    }
  }
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2024-06-01',
    'anthropic-dangerous-allow-browser': 'true',
  }
  if (modelConfig.enableThinking) {
    headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14'
  }
  return {
    url: `${devProxyUrl(baseUrl)}/messages`,
    options: {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: modelId, ...body }),
    },
  }
}

function buildOpenAIRequest(baseUrl, apiKey, modelId, body, modelConfig = {}) {
  if (modelConfig.temperature !== undefined) {
    body.temperature = modelConfig.temperature
  }
  // Kimi K2.5 extended thinking — Moonshot API flag
  if (modelConfig.enableThinking && baseUrl.includes('moonshot.cn')) {
    body.enable_thinking = true
  }
  if (PROXY_URL) {
    return {
      url: `${PROXY_URL}/proxy`,
      options: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: detectProvider(baseUrl), body: { model: modelId, ...body } }),
      },
    }
  }
  return {
    url: `${devProxyUrl(baseUrl)}/chat/completions`,
    options: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: modelId, ...body }),
    },
  }
}

async function runAnthropicPrompt(modelConfig, messages, onChunk, signal) {
  const { apiKey, baseUrl, modelId } = modelConfig
  const { url, options } = buildAnthropicRequest(baseUrl, apiKey, modelId, {
    max_tokens: modelConfig.maxTokens || DEFAULT_MAX_TOKENS, stream: true, messages,
  }, modelConfig)

  const res = await fetchWithRetry(url, { ...options, signal })
  if (!res.ok) { const err = await res.text(); throw new Error(`AI API error ${res.status}: ${err}`) }

  return readSSEStream(
    res, onChunk,
    (parsed) => parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta'
      ? parsed.delta.text : null,
    signal,
  )
}

async function runOpenAIPrompt(modelConfig, messages, onChunk, signal) {
  const { apiKey, baseUrl, modelId } = modelConfig
  const { url, options } = buildOpenAIRequest(baseUrl, apiKey, modelId, { stream: true, messages }, modelConfig)

  const res = await fetchWithRetry(url, { ...options, signal })
  if (!res.ok) { const err = await res.text(); throw new Error(`AI API error ${res.status}: ${err}`) }

  return readSSEStream(res, onChunk, (parsed) => parsed.choices?.[0]?.delta?.content ?? null, signal)
}

// ── Streaming SSE readers for tool-use responses ─────────────────────────────

async function readAnthropicToolStream(res, signal, onTextDelta) {
  const reader  = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer    = ''
  let fullText  = ''
  // Track all content blocks by index so we can reconstruct _raw in the correct
  // order.  Anthropic requires thinking blocks to be present in subsequent turns
  // when extended thinking is active — stripping them causes a 400 on turn 2+.
  const blocks     = {}   // index → block object (any type)
  const toolBlocks = {}   // index → { id, name, jsonParts[] }  (subset of blocks)
  let stopReason   = null
  // Claude Code-style token usage tracking — captured from message_start / message_delta
  const usage      = { input: 0, output: 0 }

  while (true) {
    if (signal?.aborted) { reader.cancel(); break }
    let done, value
    try {
      ;({ done, value } = await readChunkWithTimeout(reader))
    } catch (err) {
      reader.cancel()
      throw err
    }
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6)
      if (data === '[DONE]') continue
      try {
        const ev = JSON.parse(data)
        if (ev.type === 'message_start') {
          // Capture input token count from the opening message envelope
          if (ev.message?.usage?.input_tokens) usage.input = ev.message.usage.input_tokens
        } else if (ev.type === 'content_block_start') {
          const cb = ev.content_block
          if (cb?.type === 'tool_use') {
            toolBlocks[ev.index] = { id: cb.id, name: cb.name, jsonParts: [] }
            blocks[ev.index] = { _toolIndex: ev.index }  // placeholder; filled after parse
          } else if (cb?.type === 'thinking') {
            blocks[ev.index] = { type: 'thinking', thinking: '' }
          } else if (cb?.type === 'text') {
            blocks[ev.index] = { type: 'text', text: '' }
          }
        } else if (ev.type === 'content_block_delta') {
          if (ev.delta?.type === 'text_delta') {
            fullText += ev.delta.text
            onTextDelta?.(ev.delta.text)
            if (blocks[ev.index]) blocks[ev.index].text = (blocks[ev.index].text || '') + ev.delta.text
          } else if (ev.delta?.type === 'thinking_delta' && blocks[ev.index]) {
            blocks[ev.index].thinking = (blocks[ev.index].thinking || '') + ev.delta.thinking
          } else if (ev.delta?.type === 'input_json_delta' && toolBlocks[ev.index]) {
            toolBlocks[ev.index].jsonParts.push(ev.delta.partial_json)
          }
        } else if (ev.type === 'message_delta') {
          stopReason = ev.delta?.stop_reason
          // Capture output token count from the closing delta
          if (ev.usage?.output_tokens) usage.output = ev.usage.output_tokens
        }
      } catch {}
    }
  }

  const toolCalls = Object.values(toolBlocks).map(b => {
    let input = {}
    try { input = JSON.parse(b.jsonParts.join('')) } catch {}
    return { id: b.id, name: b.name, input }
  })

  // _raw: content block array Anthropic needs back in the next assistant message.
  // Must include thinking blocks (if any) in their original index order.
  const _raw = Object.entries(blocks)
    .sort(([a], [b]) => Number(a) - Number(b))
    .flatMap(([, block]) => {
      if (block._toolIndex !== undefined) {
        const tc = toolCalls.find(t => toolBlocks[block._toolIndex]?.id === t.id)
        if (!tc) return []
        return [{ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input }]
      }
      if (block.type === 'thinking' && block.thinking) return [block]
      if (block.type === 'text' && block.text) return [{ type: 'text', text: block.text }]
      return []
    })

  return { text: fullText, toolCalls, isDone: stopReason === 'end_turn' || toolCalls.length === 0, _raw, usage }
}

async function readOpenAIToolStream(res, signal, onTextDelta) {
  const reader  = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer    = ''
  let fullText  = ''
  let reasoningContent = ''
  const tcMap   = {}   // index → { id, name, argParts[] }
  let finishReason = null
  // Claude Code-style token usage (sent in the final chunk when stream_options.include_usage=true)
  const usage   = { input: 0, output: 0 }

  while (true) {
    if (signal?.aborted) { reader.cancel(); break }
    let done, value
    try {
      ;({ done, value } = await readChunkWithTimeout(reader))
    } catch (err) {
      reader.cancel()
      throw err
    }
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6)
      if (data === '[DONE]') continue
      try {
        const ev     = JSON.parse(data)
        // Capture usage from the final summary chunk (stream_options.include_usage=true)
        if (ev.usage) {
          if (ev.usage.prompt_tokens)     usage.input  = ev.usage.prompt_tokens
          if (ev.usage.completion_tokens) usage.output = ev.usage.completion_tokens
        }
        const choice = ev.choices?.[0]
        if (!choice) continue
        const delta  = choice.delta
        if (delta?.content) {
          fullText += delta.content
          onTextDelta?.(delta.content)
        }
        // Kimi K2.5 thinking mode — accumulate reasoning_content
        if (delta?.reasoning_content) {
          reasoningContent += delta.reasoning_content
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!tcMap[tc.index]) tcMap[tc.index] = { id: '', name: '', argParts: [] }
            if (tc.id)                   tcMap[tc.index].id = tc.id
            if (tc.function?.name)       tcMap[tc.index].name = tc.function.name
            if (tc.function?.arguments)  tcMap[tc.index].argParts.push(tc.function.arguments)
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason
      } catch {}
    }
  }

  const toolCalls = Object.values(tcMap).map((tc, i) => {
    let input = {}
    try { input = JSON.parse(tc.argParts.join('')) } catch {}
    // Guarantee a non-empty ID — Kimi sometimes omits it after the first delta chunk.
    // The ID in _raw.tool_calls MUST match tool_call_id in tool results, so we
    // derive a stable fallback and apply it to both sides.
    const id = tc.id || `call_${i}_${tc.name || 'tool'}`
    return { id, name: tc.name, input }
  })

  const _raw = {
    role: 'assistant',
    content: fullText || null,
    tool_calls: toolCalls.length > 0
      ? toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.input) } }))
      : undefined,
  }
  // Preserve reasoning_content for providers that require it in multi-turn history (e.g. Kimi K2.5 thinking mode)
  if (reasoningContent) _raw.reasoning_content = reasoningContent

  // isDone when no tool calls to execute — finish_reason can be 'stop', 'tool_calls',
  // or null (stream cut off). We drive the loop by tool call presence, not reason string.
  return { text: fullText, toolCalls, isDone: toolCalls.length === 0, _raw, usage }
}

// ── callWithToolsStreaming — streaming tool-use call ──────────────────────────
// Same interface as callWithTools but streams text tokens via onTextDelta(delta).
export async function callWithToolsStreaming(modelConfig, messages, tools, signal, systemPrompt, onTextDelta) {
  const { apiKey, baseUrl, modelId } = modelConfig
  const isAnthropic = isAnthropicUrl(baseUrl)

  if (isAnthropic) {
    const body = { max_tokens: modelConfig.maxTokens || DEFAULT_MAX_TOKENS, stream: true, tools, messages }
    if (systemPrompt) body.system = systemPrompt
    const { url, options } = buildAnthropicRequest(baseUrl, apiKey, modelId, body, modelConfig)
    const res = await fetchWithRetry(url, { ...options, signal })
    if (!res.ok) { const err = await res.text(); throw new Error(`AI API error ${res.status}: ${err}`) }
    return readAnthropicToolStream(res, signal, onTextDelta)
  }

  const openAITools = tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }))
  const { url, options } = buildOpenAIRequest(baseUrl, apiKey, modelId, {
    stream: true, tools: openAITools, tool_choice: 'auto', messages,
    stream_options: { include_usage: true },  // Claude Code-style per-turn token accounting
  }, modelConfig)
  const res = await fetchWithRetry(url, { ...options, signal })
  if (!res.ok) { const err = await res.text(); throw new Error(`AI API error ${res.status}: ${err}`) }
  return readOpenAIToolStream(res, signal, onTextDelta)
}

// ── callWithTools — non-streaming call with function/tool schemas ─────────────
// Used by the agentic loop.  Returns a normalised response:
//   { text, toolCalls: [{id, name, input}], isDone, _raw }
// Works with both Anthropic (tool_use blocks) and OpenAI (tool_calls array).
export async function callWithTools(modelConfig, messages, tools, signal, systemPrompt) {
  const { apiKey, baseUrl, modelId } = modelConfig
  const isAnthropic = isAnthropicUrl(baseUrl)

  if (isAnthropic) {
    const body = { max_tokens: modelConfig.maxTokens || DEFAULT_MAX_TOKENS, tools, messages }
    if (systemPrompt) body.system = systemPrompt
    const { url, options } = buildAnthropicRequest(baseUrl, apiKey, modelId, body, modelConfig)
    const res = await fetchWithRetry(url, { ...options, signal })
    if (!res.ok) { const err = await res.text(); throw new Error(`AI API error ${res.status}: ${err}`) }
    const data = await res.json()
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
    const toolCalls = (data.content || [])
      .filter(b => b.type === 'tool_use')
      .map(b => ({ id: b.id, name: b.name, input: b.input }))
    return { text, toolCalls, isDone: data.stop_reason === 'end_turn', _raw: data.content }
  }

  // OpenAI / Kimi / any compatible
  const openAITools = tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }))
  const { url, options } = buildOpenAIRequest(baseUrl, apiKey, modelId, {
    tools: openAITools,
    tool_choice: 'auto',
    messages,
  }, modelConfig)
  const res = await fetchWithRetry(url, { ...options, signal })
  if (!res.ok) { const err = await res.text(); throw new Error(`AI API error ${res.status}: ${err}`) }
  const data = await res.json()
  const choice = data.choices?.[0]
  const text = choice?.message?.content || ''
  const toolCalls = (choice?.message?.tool_calls || []).map(tc => ({
    id: tc.id,
    name: tc.function.name,
    input: (() => { try { return JSON.parse(tc.function.arguments || '{}') } catch { return {} } })(),
  }))
  return { text, toolCalls, isDone: choice?.finish_reason === 'stop', _raw: choice?.message }
}

// Convert Anthropic-style content blocks to OpenAI-compatible format
function toOpenAIContent(content) {
  if (typeof content === 'string') return content
  return content.map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text }
    if (block.type === 'image') {
      return {
        type: 'image_url',
        image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
      }
    }
    if (block.type === 'document') {
      try {
        const text = atob(block.source.data)
        return { type: 'text', text }
      } catch {
        return { type: 'text', text: '' }
      }
    }
    return { type: 'text', text: '' }
  })
}

export async function runPrompt(modelConfig, content, context = [], onChunk, signal) {
  const { baseUrl } = modelConfig

  if (isAnthropicUrl(baseUrl)) {
    const messages = [...context, { role: 'user', content }]
    return runAnthropicPrompt(modelConfig, messages, onChunk, signal)
  }

  // OpenAI path: convert content blocks
  const openAIContext = context.map((msg) => ({
    ...msg,
    content: toOpenAIContent(msg.content),
  }))
  const messages = [...openAIContext, { role: 'user', content: toOpenAIContent(content) }]
  return runOpenAIPrompt(modelConfig, messages, onChunk, signal)
}

// A wrapper that retries failed prompt calls (network errors, rate limits) up to maxRetries.
export async function runPromptWithRetry(modelConfig, content, context = [], onChunk, signal, maxRetries = 2) {
  let lastErr = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await runPrompt(modelConfig, content, context, onChunk, signal)
    } catch (err) {
      lastErr = err
      // If aborted, propagate immediately
      if (err.name === 'AbortError') throw err
      // If this was last attempt, throw
      if (attempt === maxRetries) throw err
      // Otherwise wait and retry
      await sleep(1000 * Math.pow(2, attempt))
    }
  }
  throw lastErr
}

// ── countTokensAnthropic — estimate token count before sending ────────────────
// Returns { inputTokens } or throws on error.  Only works for Anthropic models.
// Safe to call at any time — does NOT consume output tokens.
export async function countTokensAnthropic(modelConfig, messages, systemPrompt) {
  const { apiKey, baseUrl, modelId } = modelConfig
  if (!isAnthropicUrl(baseUrl)) throw new Error('countTokensAnthropic: only supported for Anthropic models')

  const body = { model: modelId, messages }
  if (systemPrompt) body.system = systemPrompt

  if (PROXY_URL) {
    const res = await fetchWithRetry(`${PROXY_URL}/proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'anthropic', endpoint: '/v1/messages/count_tokens', body }),
    })
    if (!res.ok) { const err = await res.text(); throw new Error(`Token count error ${res.status}: ${err}`) }
    const data = await res.json()
    return { inputTokens: data.input_tokens }
  }

  const res = await fetchWithRetry(`${baseUrl}/messages/count_tokens`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2024-06-01',
      'anthropic-dangerous-allow-browser': 'true',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) { const err = await res.text(); throw new Error(`Token count error ${res.status}: ${err}`) }
  const data = await res.json()
  return { inputTokens: data.input_tokens }
}

// ── callForStructuredOutput — JSON extraction via Anthropic tool_use ──────────
// Asks the model to fill a named tool schema and returns the parsed input object.
// toolName:   string  — name of the tool (e.g. 'extract_plan')
// toolSchema: object  — JSON Schema for the tool's input_schema
// prompt:     string  — user instruction
// systemPrompt: string | undefined
// Returns the parsed object on success, throws on error.
export async function callForStructuredOutput(modelConfig, toolName, toolSchema, prompt, systemPrompt) {
  const { apiKey, baseUrl, modelId } = modelConfig
  if (!isAnthropicUrl(baseUrl)) throw new Error('callForStructuredOutput: only supported for Anthropic models')

  const tools = [{ name: toolName, description: toolSchema.description || toolName, input_schema: toolSchema }]
  const messages = [{ role: 'user', content: prompt }]
  const body = {
    max_tokens: modelConfig.maxTokens || DEFAULT_MAX_TOKENS,
    tools,
    tool_choice: { type: 'tool', name: toolName },
    messages,
  }
  if (systemPrompt) body.system = systemPrompt

  const { url, options } = buildAnthropicRequest(baseUrl, apiKey, modelId, body)
  const res = await fetchWithRetry(url, options)
  if (!res.ok) { const err = await res.text(); throw new Error(`AI API error ${res.status}: ${err}`) }
  const data = await res.json()
  const toolUse = (data.content || []).find(b => b.type === 'tool_use' && b.name === toolName)
  if (!toolUse) throw new Error(`callForStructuredOutput: model did not call tool '${toolName}'`)
  return toolUse.input
}
