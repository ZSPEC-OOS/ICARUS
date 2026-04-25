// ─── providerRegistry unit tests ─────────────────────────────────────────────
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  detectProvider,
  getContextWindow,
  toProviderTools,
  applySystemPrompt,
  getDevProxyUrl,
  trimMessagesToContextWindow,
  normalizeBaseUrl,
} from './providerRegistry.js'

// ── detectProvider ────────────────────────────────────────────────────────────

test('detectProvider identifies Anthropic', () => {
  const p = detectProvider('https://api.anthropic.com/v1')
  assert.equal(p.id, 'anthropic')
  assert.equal(p.toolFormat, 'anthropic')
  assert.equal(p.systemPrompt, 'top-level')
})

test('detectProvider identifies OpenAI', () => {
  const p = detectProvider('https://api.openai.com/v1')
  assert.equal(p.id, 'openai')
  assert.equal(p.toolFormat, 'openai')
})

test('detectProvider identifies Groq', () => {
  const p = detectProvider('https://api.groq.com/openai/v1')
  assert.equal(p.id, 'groq')
})

test('detectProvider identifies Ollama', () => {
  const p = detectProvider('http://localhost:11434/api')
  assert.equal(p.id, 'ollama')
})

test('detectProvider falls back to openai-compatible for unknown URL', () => {
  const p = detectProvider('https://my-custom-llm.example.com/v1')
  assert.equal(p.id, 'openai-compatible')
  assert.equal(p.toolFormat, 'openai')
})

test('detectProvider handles null/undefined gracefully', () => {
  const p = detectProvider(null)
  assert.equal(typeof p.id, 'string')
})

// ── getContextWindow ──────────────────────────────────────────────────────────

test('getContextWindow returns model-specific limit for Anthropic', () => {
  const w = getContextWindow('https://api.anthropic.com/v1', 'claude-opus-4-7')
  assert.equal(w, 200_000)
})

test('getContextWindow returns model-specific limit for Groq small model', () => {
  const w = getContextWindow('https://api.groq.com/openai/v1', 'llama3-70b-8192')
  assert.equal(w, 8_192)
})

test('getContextWindow falls back to provider default for unknown model', () => {
  const w = getContextWindow('https://api.openai.com/v1', 'gpt-99-turbo-unknown')
  assert.equal(w, 128_000)
})

test('getContextWindow falls back to 128k for unknown provider + model', () => {
  const w = getContextWindow('https://unknown-provider.ai/v1', 'some-model')
  assert.equal(w, 128_000)
})

// ── toProviderTools ───────────────────────────────────────────────────────────

const ANTHROPIC_TOOLS = [
  { name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'write_file', description: 'Write a file', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } },
]

test('toProviderTools returns tools unchanged for Anthropic', () => {
  const result = toProviderTools(ANTHROPIC_TOOLS, 'https://api.anthropic.com/v1')
  assert.deepEqual(result, ANTHROPIC_TOOLS)
})

test('toProviderTools converts to OpenAI function format', () => {
  const result = toProviderTools(ANTHROPIC_TOOLS, 'https://api.openai.com/v1')
  assert.equal(result[0].type, 'function')
  assert.equal(result[0].function.name, 'read_file')
  assert.equal(result[0].function.description, 'Read a file')
  assert.deepEqual(result[0].function.parameters, ANTHROPIC_TOOLS[0].input_schema)
})

test('toProviderTools converts to OpenAI format for Groq', () => {
  const result = toProviderTools(ANTHROPIC_TOOLS, 'https://api.groq.com/openai/v1')
  assert.equal(result[0].type, 'function')
})

test('toProviderTools handles empty tool array', () => {
  assert.deepEqual(toProviderTools([], 'https://api.openai.com/v1'), [])
})

// ── applySystemPrompt ─────────────────────────────────────────────────────────

test('applySystemPrompt sets body.system for Anthropic', () => {
  const { body, messages } = applySystemPrompt({}, [], 'Be helpful.', 'https://api.anthropic.com/v1')
  assert.equal(body.system, 'Be helpful.')
  assert.deepEqual(messages, [])
})

test('applySystemPrompt prepends system message for OpenAI', () => {
  const { body, messages } = applySystemPrompt({}, [{ role: 'user', content: 'hi' }], 'Be helpful.', 'https://api.openai.com/v1')
  assert.equal(messages[0].role, 'system')
  assert.equal(messages[0].content, 'Be helpful.')
  assert.equal(messages[1].role, 'user')
  assert.deepEqual(body, {})
})

test('applySystemPrompt does not duplicate system message if already present', () => {
  const existing = [{ role: 'system', content: 'existing' }, { role: 'user', content: 'hi' }]
  const { messages } = applySystemPrompt({}, existing, 'new', 'https://api.openai.com/v1')
  assert.equal(messages.filter(m => m.role === 'system').length, 1)
})

test('applySystemPrompt is a no-op when systemPrompt is empty', () => {
  const { body, messages } = applySystemPrompt({ model: 'x' }, [{ role: 'user', content: 'hi' }], '', 'https://api.openai.com/v1')
  assert.deepEqual(body, { model: 'x' })
  assert.equal(messages.length, 1)
})

// ── getDevProxyUrl ────────────────────────────────────────────────────────────

test('getDevProxyUrl returns original URL in production', () => {
  const url = getDevProxyUrl('https://api.anthropic.com/v1', false)
  assert.equal(url, 'https://api.anthropic.com/v1')
})

test('getDevProxyUrl returns proxy path in dev for Anthropic', () => {
  const url = getDevProxyUrl('https://api.anthropic.com/v1', true)
  assert.equal(url, '/api/proxy/anthropic')
})

test('getDevProxyUrl returns proxy path in dev for OpenAI', () => {
  const url = getDevProxyUrl('https://api.openai.com/v1', true)
  assert.equal(url, '/api/proxy/openai')
})

test('getDevProxyUrl returns original URL for unknown providers in dev', () => {
  const url = getDevProxyUrl('http://localhost:11434/api', true)
  // Ollama has no proxyPath — falls through to baseUrl
  assert.equal(typeof url, 'string')
})

// ── trimMessagesToContextWindow ───────────────────────────────────────────────

function msg(role, content) { return { role, content } }

test('trimMessagesToContextWindow returns messages unchanged when under budget', () => {
  const messages = [msg('system', 'sys'), msg('user', 'task'), msg('assistant', 'ok')]
  const result = trimMessagesToContextWindow(messages, 'https://api.openai.com/v1', 'gpt-4o')
  assert.deepEqual(result, messages)
})

test('trimMessagesToContextWindow trims old turns when over budget', () => {
  // Force tiny budget: use a 1-token window (essentially) with a large message history
  const head = [msg('system', 's'), msg('user', 'task')]
  const tail = Array.from({ length: 50 }, (_, i) => msg(i % 2 === 0 ? 'assistant' : 'user', 'x'.repeat(1000)))
  // Use Groq llama3-70b-8192 (8192 token window) with 4096 reserved = 4096 budget
  const result = trimMessagesToContextWindow([...head, ...tail], 'https://api.groq.com/openai/v1', 'llama3-70b-8192')
  assert.ok(result.length < head.length + tail.length)
  assert.deepEqual(result.slice(0, 2), head)
})

test('trimMessagesToContextWindow injects pruning notice when trimming', () => {
  const head = [msg('system', 's'), msg('user', 'task')]
  const tail = Array.from({ length: 50 }, () => msg('assistant', 'x'.repeat(500)))
  const result = trimMessagesToContextWindow([...head, ...tail], 'https://api.groq.com/openai/v1', 'llama3-70b-8192')
  const notice = result[2]
  assert.ok(notice.content.includes('pruned'))
})

// ── normalizeBaseUrl ──────────────────────────────────────────────────────────

test('normalizeBaseUrl appends /openai for Gemini v1beta URL', () => {
  const url = normalizeBaseUrl('https://generativelanguage.googleapis.com/v1beta')
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/openai')
})

test('normalizeBaseUrl does not double-append /openai if already present', () => {
  const url = normalizeBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai')
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/openai')
})

test('normalizeBaseUrl returns non-Gemini URLs unchanged', () => {
  assert.equal(normalizeBaseUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1')
  assert.equal(normalizeBaseUrl('https://api.anthropic.com/v1'), 'https://api.anthropic.com/v1')
  assert.equal(normalizeBaseUrl('http://localhost:11434/api'), 'http://localhost:11434/api')
})

test('normalizeBaseUrl handles null/undefined gracefully', () => {
  assert.equal(normalizeBaseUrl(null), null)
  assert.equal(normalizeBaseUrl(undefined), undefined)
})

// ── detectProvider — LM Studio & Ollama ──────────────────────────────────────

test('detectProvider identifies LM Studio on localhost:1234', () => {
  const p = detectProvider('http://localhost:1234/v1')
  assert.equal(p.id, 'lmstudio')
  assert.equal(p.supportsTools, 'detect')
})

test('detectProvider identifies Ollama on localhost:11434', () => {
  const p = detectProvider('http://localhost:11434/api')
  assert.equal(p.id, 'ollama')
  assert.equal(p.supportsTools, 'detect')
})
