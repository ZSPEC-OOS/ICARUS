// ââ agentLoop â the core observe â decide â act cycle ââââââââââââââââââââââââ
//
// Drives one full agent session:
//   1. Sends the task + tool schemas to the model
//   2. Executes each tool the model requests
//   3. Feeds results back and loops until the model signals it is done
//   4. Emits structured events so the UI can render live progress
//
// Events emitted via onEvent(event):
//   { type: 'turn',       turn: number }
//   { type: 'text_delta', delta: string }            â streaming token
//   { type: 'tool_start', name, input }              â about to execute
//   { type: 'tool_done',  name, result, error? }     â result received
//   { type: 'file_write', path, action }             â file was changed
//   { type: 'done',       text, filesChanged: [] }   â session complete
//   { type: 'error',      message }                  â fatal error

import { callWithToolsStreaming } from './aiService.js'
import { AGENT_MAX_TURNS, AGENT_KEEP_TURNS } from '../config/constants.js'
import { resolveEnhancerConfig } from './enhancers/config.js'
import { enforceStructuredPrompt } from './enhancers/structuredPrompting.js'
import { runCritiquePass } from './enhancers/critiqueMiddleware.js'
import { memoryGraphService } from './memoryGraphService.js'

// ââ Session diary â Claude Code /compact pattern ââââââââââââââââââââââââââââââ
// Accumulates a lightweight log of what has happened in the session.
// When context pruning would silently drop turns, the diary is injected instead
// as a compact digest so the model retains awareness of prior progress.
function makeSessionDiary() {
  const filesRead    = new Set()
  const filesChanged = []    // [{path, action}] in order
  const textSnippets = []    // first sentence of each model turn (capped at 120 chars)

  return {
    onFileRead(path)          { filesRead.add(path) },
    onFileWrite(path, action) { filesChanged.push({ path, action }) },
    onModelText(text) {
      // Capture the first meaningful sentence of each model turn as a progress note
      const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 120)
      if (snippet.length > 20) textSnippets.push(snippet)
    },
    hasContent() {
      return filesRead.size > 0 || filesChanged.length > 0 || textSnippets.length > 0
    },
    buildDigest(droppedTurns) {
      const lines = [
        `[SESSION DIGEST â ${droppedTurns} earlier turn${droppedTurns !== 1 ? 's' : ''} compacted to free context space]`,
      ]
      if (filesRead.size > 0)
        lines.push(`Files read: ${[...filesRead].slice(0, 20).join(', ')}`)
      if (filesChanged.length > 0) {
        const summary = filesChanged.map(f => `${f.path} (${f.action})`).join(', ')
        lines.push(`Files changed: ${summary}`)
      }
      if (textSnippets.length > 0) {
        lines.push('Key progress notes:')
        textSnippets.slice(-6).forEach(s => lines.push(`  â¢ ${s}`))
      }
      return lines.join('\n')
    },
  }
}

// ââ Helpers to build the next conversation turn âââââââââââââââââââââââââââââââ

// Aider-style per-turn reminder â injected into the conversation whenever an
// edit_file call failed, keeping the exact-match rule continuously in scope.
const EDIT_FAILURE_REMINDER =
  '[REMINDER] edit_file requires exact whitespace in old_str. ' +
  'Use grep to find the exact text, or read_file with start_line/end_line. ' +
  'The diagnostic above shows the nearest matching lines.'

// Anthropic expects tool results inside a user message as content blocks.
// OpenAI expects each result as a message with role 'tool'.
// We detect which format to use from the provider field set by callWithTools.
function buildToolResultMessages(toolCalls, results, isAnthropic, rawAssistantContent) {
  // Detect whether any edit_file calls failed â if so, append a reminder
  const hadEditFailure = toolCalls.some((tc, i) =>
    tc.name === 'edit_file' && String(results[i] ?? '').startsWith('edit_file failed')
  )

  if (isAnthropic) {
    return [
      { role: 'assistant', content: rawAssistantContent },
      {
        role: 'user',
        content: [
          ...toolCalls.map((tc, i) => ({
            type:        'tool_result',
            tool_use_id: tc.id,
            content:     String(results[i] ?? ''),
          })),
          ...(hadEditFailure ? [{ type: 'text', text: EDIT_FAILURE_REMINDER }] : []),
        ],
      },
    ]
  }

  // OpenAI / Kimi â use rawAssistantContent directly to preserve any extra fields
  // (e.g. reasoning_content required by Kimi K2.5 thinking mode in multi-turn history)
  return [
    rawAssistantContent,
    ...toolCalls.map((tc, i) => ({
      role:         'tool',
      tool_call_id: tc.id,
      content:      String(results[i] ?? ''),
    })),
    ...(hadEditFailure ? [{ role: 'user', content: EDIT_FAILURE_REMINDER }] : []),
  ]
}

// Prune old messages to keep context window bounded.
// Always preserves the initial system+task messages (first 2) and the last
// AGENT_KEEP_TURNS turn pairs.
// When a diary is supplied and turns are actually dropped, injects a compact
// digest (Claude Code /compact pattern) so the model retains session context.
function pruneMessages(messages, diary = null, isAnthropic = false) {
  const head = messages.slice(0, 2)
  const tail = messages.slice(2)
  const keep = AGENT_KEEP_TURNS * 2   // each turn = 1 assistant + 1 user
  if (tail.length <= keep) return messages

  // Turns are about to be dropped â inject a digest if we have one
  const droppedCount = Math.floor((tail.length - keep) / 2)
  let trimmed = tail.slice(-keep)

  // OpenAI format: a tool-use turn is 1 assistant message + N role:'tool' messages.
  // Slicing by a fixed count can cut mid-turn, leaving orphaned role:'tool' messages
  // whose tool_call_id references a now-pruned assistant message — causing a 400 error.
  // Fix: drop any leading role:'tool' messages that lost their assistant message.
  if (!isAnthropic) {
    const firstNonTool = trimmed.findIndex(m => m.role !== 'tool')
    if (firstNonTool > 0) trimmed = trimmed.slice(firstNonTool)
  }

  if (diary?.hasContent()) {
    const digestMsg = { role: 'user', content: diary.buildDigest(droppedCount) }
    return [...head, digestMsg, ...trimmed]
  }
  return [...head, ...trimmed]
}

// ââ Loop detection ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// If the agent calls the exact same set of tools with the same inputs 3 turns
// in a row it has likely entered an infinite loop.  We inject a recovery note
// into the conversation so the model tries a different approach.
const LOOP_WINDOW = 3
const CACHEABLE_TOOLS = new Set([
  'analyze_codebase',
  'read_file',
  'read_many_files',
  'list_directory',
  'search_files',
  'grep',
])

function toolSignature(toolCalls) {
  return toolCalls
    .map(tc => `${tc.name}:${JSON.stringify(tc.input).slice(0, 100)}`)
    .sort()
    .join('|')
}

// ââ Main entry point ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
export async function runAgentLoop({
  task,
  systemPrompt,
  tools,
  executeTool,          // async (name, input) => string
  modelConfig,
  onEvent,
  signal,
  conversationHistory,  // optional prior turns [{role,content}] for context continuity
  enhancerConfig: enhancerConfigOverrides,
}) {
  // Detect once â avoids repeated URL-sniffing in every turn.
  // Supports proxy setups by checking the provider field if present, then URL.
  const isAnthropic = modelConfig.provider === 'anthropic' ||
    (!modelConfig.provider && modelConfig.baseUrl?.includes('api.anthropic.com'))

  const enhancerConfig = resolveEnhancerConfig(enhancerConfigOverrides)
  memoryGraphService.init()
  const filesChanged = []
  const recentSigs   = []   // rolling window of tool-call signatures for loop detection
  const diary        = makeSessionDiary()   // Claude Code-style session digest
  const toolResultCache = new Map()

  // Initial message â system prompt is injected as first user message
  // (both Anthropic and OpenAI accept a system field or a leading user message)
  let messages = [
    ...(isAnthropic
      ? []   // Anthropic: pass systemPrompt via the `system` field below
      : [{ role: 'system', content: systemPrompt }]),
    ...(conversationHistory?.length
      ? conversationHistory   // prior session turns for context continuity
      : []),
    {
      role: 'user',
      content: enhancerConfig.structuredPrompting.enabled
        ? enforceStructuredPrompt(task).promptText
        : task,
    },
  ]

  // Anthropic tool call needs system at top level, not in messages
  const anthropicSystemField = isAnthropic ? systemPrompt : undefined

  for (let turn = 1; turn <= AGENT_MAX_TURNS; turn++) {
    if (signal?.aborted) {
      onEvent({ type: 'done', text: 'Agent stopped.', filesChanged })
      return
    }
    onEvent({ type: 'turn', turn })

    // ââ Call the model ââââââââââââââââââââââââââââââââââââââââââââââââââââ
    let response
    try {
      response = await callWithToolsStreaming(
        modelConfig,
        messages,
        tools,
        signal,
        anthropicSystemField,
        (delta) => onEvent({ type: 'text_delta', delta }),
      )
    } catch (err) {
      if (err.name === 'AbortError') {
        onEvent({ type: 'done', text: 'Agent stopped.', filesChanged })
        return
      }
      onEvent({ type: 'error', message: err.message })
      return
    }

    // ââ Emit token usage (Claude Code-style âin âout accounting) âââââââââ
    if (response.usage?.input || response.usage?.output) {
      onEvent({ type: 'usage', inputTokens: response.usage.input, outputTokens: response.usage.output })
    }

    // ââ Record model text in diary for compaction ââââââââââââââââââââââ
    if (response.text) diary.onModelText(response.text)

    // ââ Model is done âââââââââââââââââââââââââââââââââââââââââââââââââââââ
    if (response.isDone || response.toolCalls.length === 0) {
      let finalText = response.text
      if (enhancerConfig.critique.enabled) {
        const critique = runCritiquePass({ draftText: response.text, config: enhancerConfig.critique })
        onEvent({ type: 'critique', critique })
        if (!critique.passed || critique.issues.length) {
          finalText = `${response.text}

[Self-check]
${critique.summary}`
        }
        memoryGraphService.ingestCritiqueOutcome({
          task,
          critiqueSummary: critique.summary,
          passed: critique.passed,
        })
      }
      onEvent({ type: 'done', text: finalText, filesChanged })
      return
    }

    // ââ Execute tools in parallel âââââââââââââââââââââââââââââââââââââââââ
    // Emit tool_start for all tools immediately, then run concurrently.
    // Each tool gets a unique ID so UI can match start/done events correctly.
    if (signal?.aborted) {
      onEvent({ type: 'done', text: 'Agent stopped.', filesChanged })
      return
    }
    const toolCallIds = new Map()
    response.toolCalls.forEach(tc => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
      toolCallIds.set(tc, id)
      onEvent({ type: 'tool_start', id, name: tc.name, input: tc.input })
    })

    const settled = await Promise.allSettled(
      response.toolCalls.map(async (tc) => {
        const id = toolCallIds.get(tc)
        const cacheKey = `${tc.name}:${JSON.stringify(tc.input || {})}`
        try {
          if (CACHEABLE_TOOLS.has(tc.name) && toolResultCache.has(cacheKey)) {
            const cached = toolResultCache.get(cacheKey)
            onEvent({ type: 'tool_done', id, name: tc.name, result: cached, error: null, cached: true })
            return cached
          }

          const result = await executeTool(tc.name, tc.input)
          if (CACHEABLE_TOOLS.has(tc.name)) toolResultCache.set(cacheKey, result)

          if (tc.name === 'write_file' || tc.name === 'edit_file' || tc.name === 'delete_file' || tc.name === 'revert_file') {
            const path = tc.input.path
            if (!filesChanged.includes(path)) filesChanged.push(path)
            const action = tc.name === 'write_file' ? 'write' : tc.name === 'delete_file' ? 'delete' : 'edit'
            onEvent({ type: 'file_write', path, action })
            diary.onFileWrite(path, action)
            toolResultCache.clear() // file system changed — drop stale read/search cache
            memoryGraphService.ingestFileChange({
              path,
              action,
              content: String(result || '').slice(0, 500),
              source: 'agent_loop',
            })
          } else if (tc.name === 'read_file' || tc.name === 'read_many_files') {
            const paths = tc.name === 'read_many_files' ? (tc.input.paths || []) : [tc.input.path]
            paths.forEach(p => diary.onFileRead(p))
          }
          onEvent({ type: 'tool_done', id, name: tc.name, result, error: null })
          return result
        } catch (err) {
          onEvent({ type: 'tool_done', id, name: tc.name, result: `ERROR: ${err.message}`, error: err.message })
          return `ERROR: ${err.message}`
        }
      })
    )
    const results = settled.map(r => r.status === 'fulfilled' ? r.value : `ERROR: ${r.reason}`)

    // ââ Append assistant + tool results to conversation, then prune âââââââ
    const nextMessages = buildToolResultMessages(
      response.toolCalls, results, isAnthropic, response._raw,
    )
    messages = pruneMessages([...messages, ...nextMessages], diary, isAnthropic)

    // ââ Loop detection ââââââââââââââââââââââââââââââââââââââââââââââââââââ
    const sig = toolSignature(response.toolCalls)
    recentSigs.push(sig)
    if (recentSigs.length > LOOP_WINDOW) recentSigs.shift()
    if (recentSigs.length === LOOP_WINDOW && recentSigs.every(s => s === sig)) {
      recentSigs.length = 0   // reset so we only fire once per loop cycle
      const recoveryNote = 'â  You appear to be repeating the same tool calls. Try a completely different approach, re-read the relevant files, or conclude with what you have found so far.'
      messages.push({ role: 'user', content: recoveryNote })
      onEvent({ type: 'text_delta', delta: '\n[Loop detected â injecting recovery prompt]\n' })
    }
  }

  // Hit MAX_TURNS â emit whatever we have
  onEvent({ type: 'done', text: `Reached maximum turn limit (${AGENT_MAX_TURNS}).`, filesChanged })
}
