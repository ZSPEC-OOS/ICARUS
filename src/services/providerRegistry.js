// ─── Provider Registry ────────────────────────────────────────────────────────
// Single source of truth for AI provider capabilities, API conventions,
// context window limits, and dev-proxy paths.
//
// All model-agnostic logic should query this registry instead of
// scattering URL-sniffing if/else checks throughout the codebase.

const PROVIDERS = {
  anthropic: {
    name: 'Anthropic',
    matchUrls: ['api.anthropic.com'],
    proxyPath: '/api/proxy/anthropic',
    toolFormat: 'anthropic',
    streamFormat: 'anthropic',
    systemPrompt: 'top-level',   // body.system = prompt
    defaultContextWindow: 200_000,
    models: {
      'claude-opus-4-7':              { contextWindow: 200_000 },
      'claude-sonnet-4-6':            { contextWindow: 200_000 },
      'claude-haiku-4-5-20251001':    { contextWindow: 200_000 },
      'claude-3-7-sonnet-20250219':   { contextWindow: 200_000 },
      'claude-3-5-sonnet-20241022':   { contextWindow: 200_000 },
      'claude-3-5-haiku-20241022':    { contextWindow: 200_000 },
      'claude-3-opus-20240229':       { contextWindow: 200_000 },
      'claude-3-haiku-20240307':      { contextWindow: 200_000 },
    },
  },
  openai: {
    name: 'OpenAI',
    matchUrls: ['api.openai.com'],
    proxyPath: '/api/proxy/openai',
    toolFormat: 'openai',
    streamFormat: 'openai',
    systemPrompt: 'message',     // { role: 'system', content: prompt }
    defaultContextWindow: 128_000,
    models: {
      'gpt-4o':                    { contextWindow: 128_000 },
      'gpt-4o-mini':               { contextWindow: 128_000 },
      'gpt-4-turbo':               { contextWindow: 128_000 },
      'gpt-4-turbo-preview':       { contextWindow: 128_000 },
      'gpt-3.5-turbo':             { contextWindow: 16_385 },
      'o1':                        { contextWindow: 200_000 },
      'o1-mini':                   { contextWindow: 128_000 },
      'o1-preview':                { contextWindow: 128_000 },
      'o3':                        { contextWindow: 200_000 },
      'o3-mini':                   { contextWindow: 200_000 },
      'o4-mini':                   { contextWindow: 200_000 },
    },
  },
  groq: {
    name: 'Groq',
    matchUrls: ['api.groq.com'],
    proxyPath: '/api/proxy/groq',
    toolFormat: 'openai',
    streamFormat: 'openai',
    systemPrompt: 'message',
    defaultContextWindow: 128_000,
    models: {
      'llama3-70b-8192':              { contextWindow: 8_192 },
      'llama3-8b-8192':               { contextWindow: 8_192 },
      'llama-3.1-8b-instant':         { contextWindow: 128_000 },
      'llama-3.3-70b-versatile':      { contextWindow: 128_000 },
      'mixtral-8x7b-32768':           { contextWindow: 32_768 },
      'gemma2-9b-it':                 { contextWindow: 8_192 },
    },
  },
  openrouter: {
    name: 'OpenRouter',
    matchUrls: ['openrouter.ai'],
    proxyPath: '/api/proxy/openrouter',
    toolFormat: 'openai',
    streamFormat: 'openai',
    systemPrompt: 'message',
    defaultContextWindow: 128_000,
  },
  gemini: {
    name: 'Google Gemini',
    matchUrls: ['googleapis.com', 'generativelanguage.googleapis.com'],
    proxyPath: '/api/proxy/gemini',
    toolFormat: 'openai',
    streamFormat: 'openai',
    systemPrompt: 'message',
    defaultContextWindow: 1_000_000,
    models: {
      'gemini-2.0-flash':     { contextWindow: 1_000_000 },
      'gemini-1.5-pro':       { contextWindow: 1_000_000 },
      'gemini-1.5-flash':     { contextWindow: 1_000_000 },
      'gemini-1.0-pro':       { contextWindow: 30_720 },
    },
  },
  mistral: {
    name: 'Mistral',
    matchUrls: ['api.mistral.ai'],
    proxyPath: '/api/proxy/mistral',
    toolFormat: 'openai',
    streamFormat: 'openai',
    systemPrompt: 'message',
    defaultContextWindow: 32_000,
    models: {
      'mistral-large-latest':   { contextWindow: 128_000 },
      'mistral-small-latest':   { contextWindow: 32_000 },
      'codestral-latest':       { contextWindow: 256_000 },
    },
  },
  codestral: {
    name: 'Codestral',
    matchUrls: ['codestral.mistral.ai'],
    proxyPath: '/api/proxy/codestral',
    toolFormat: 'openai',
    streamFormat: 'openai',
    systemPrompt: 'message',
    defaultContextWindow: 256_000,
  },
  deepseek: {
    name: 'DeepSeek',
    matchUrls: ['api.deepseek.com'],
    proxyPath: '/api/proxy/deepseek',
    toolFormat: 'openai',
    streamFormat: 'openai',
    systemPrompt: 'message',
    defaultContextWindow: 64_000,
    models: {
      'deepseek-chat':      { contextWindow: 64_000 },
      'deepseek-reasoner':  { contextWindow: 64_000 },
    },
  },
  xai: {
    name: 'xAI',
    matchUrls: ['api.x.ai'],
    proxyPath: '/api/proxy/xai',
    toolFormat: 'openai',
    streamFormat: 'openai',
    systemPrompt: 'message',
    defaultContextWindow: 131_072,
    models: {
      'grok-3':       { contextWindow: 131_072 },
      'grok-3-mini':  { contextWindow: 131_072 },
      'grok-2':       { contextWindow: 131_072 },
    },
  },
  kimi: {
    name: 'Kimi (Moonshot)',
    matchUrls: ['moonshot.cn'],
    proxyPath: '/api/proxy/moonshot',
    toolFormat: 'openai',
    streamFormat: 'openai',
    systemPrompt: 'message',
    defaultContextWindow: 128_000,
    models: {
      'moonshot-v1-8k':   { contextWindow: 8_192 },
      'moonshot-v1-32k':  { contextWindow: 32_000 },
      'moonshot-v1-128k': { contextWindow: 128_000 },
    },
  },
  ollama: {
    name: 'Ollama',
    matchUrls: ['localhost:11434', '127.0.0.1:11434', '0.0.0.0:11434'],
    toolFormat: 'openai',
    streamFormat: 'openai',
    systemPrompt: 'message',
    defaultContextWindow: 32_000,
  },
}

// ── Core helpers ──────────────────────────────────────────────────────────────

/**
 * Identify which provider a baseUrl belongs to.
 * Returns the provider config object (with `id` injected) or a
 * generic OpenAI-compatible fallback.
 */
export function detectProvider(baseUrl) {
  if (!baseUrl) return { id: 'unknown', ...PROVIDERS.openai }
  for (const [id, cfg] of Object.entries(PROVIDERS)) {
    if (cfg.matchUrls?.some(u => baseUrl.includes(u))) return { id, ...cfg }
  }
  // Unknown URL → treat as OpenAI-compatible (covers LM Studio, Together, etc.)
  return { id: 'openai-compatible', ...PROVIDERS.openai }
}

/**
 * Return the known context window (in tokens) for a given model on a given base URL.
 * Falls back to provider default, then to 128k if nothing matches.
 */
export function getContextWindow(baseUrl, modelId) {
  const provider = detectProvider(baseUrl)
  const modelCfg = provider.models?.[modelId]
  return modelCfg?.contextWindow ?? provider.defaultContextWindow ?? 128_000
}

/**
 * Convert internal Anthropic-style tool definitions to the format expected
 * by the target provider's API.
 *
 * Internal format (Anthropic-native):
 *   { name, description, input_schema }
 *
 * OpenAI format:
 *   { type: 'function', function: { name, description, parameters } }
 */
export function toProviderTools(tools, baseUrl) {
  if (!Array.isArray(tools) || tools.length === 0) return tools
  const provider = detectProvider(baseUrl)
  if (provider.toolFormat === 'anthropic') return tools
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }))
}

/**
 * Apply system prompt to the request body in the format required by the provider.
 *
 * For Anthropic: sets body.system = systemPrompt (top-level string)
 * For OpenAI-compatible: prepends { role: 'system', content } to messages
 *
 * Returns { body, messages } (messages may have been prepended to).
 */
export function applySystemPrompt(body, messages, systemPrompt, baseUrl) {
  if (!systemPrompt) return { body, messages }
  const provider = detectProvider(baseUrl)
  if (provider.systemPrompt === 'top-level') {
    return { body: { ...body, system: systemPrompt }, messages }
  }
  const sysMsg = { role: 'system', content: systemPrompt }
  const alreadyHasSystem = messages[0]?.role === 'system'
  return {
    body,
    messages: alreadyHasSystem ? messages : [sysMsg, ...messages],
  }
}

/**
 * Return the dev-proxy path for a baseUrl, or the original URL if no proxy
 * is configured for it.  Only active in dev (IS_DEV = true).
 */
export function getDevProxyUrl(baseUrl, IS_DEV) {
  if (!IS_DEV) return baseUrl
  const provider = detectProvider(baseUrl)
  return provider.proxyPath ?? baseUrl
}

/**
 * Trim a messages array to fit within a token budget.
 * Uses a 4-char ≈ 1-token heuristic.
 * Always preserves the first two messages (system + first user turn).
 * Inserts a notice when earlier turns are dropped.
 */
export function trimMessagesToContextWindow(messages, baseUrl, modelId, reserveTokens = 4096) {
  const windowTokens = getContextWindow(baseUrl, modelId)
  const budget       = windowTokens - reserveTokens
  const charBudget   = budget * 4   // ~4 chars per token

  const head = messages.slice(0, 2)
  const tail = messages.slice(2)
  if (tail.length === 0) return messages

  let charCount = head.reduce((n, m) => n + msgLen(m), 0)
  const kept = []

  for (let i = tail.length - 1; i >= 0; i--) {
    const len = msgLen(tail[i])
    if (charCount + len > charBudget && kept.length > 0) break
    charCount += len
    kept.unshift(tail[i])
  }

  const dropped = tail.length - kept.length
  if (dropped === 0) return messages

  const notice = {
    role: 'user',
    content: `[${dropped} earlier turn${dropped !== 1 ? 's' : ''} pruned — context window limit reached]`,
  }
  return [...head, notice, ...kept]
}

function msgLen(msg) {
  if (!msg?.content) return 0
  if (typeof msg.content === 'string') return msg.content.length
  try { return JSON.stringify(msg.content).length } catch { return 0 }
}

export { PROVIDERS }
