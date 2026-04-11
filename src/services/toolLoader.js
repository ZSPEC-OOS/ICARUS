// ─── toolLoader.js — Modular Tool Registry ────────────────────────────────────
// Manages built-in tools (from /src/tools/) and user-installed tools
// (stored in localStorage as serialized module code).
//
// Tool module contract:
//   export const toolMeta = { id, name, version, description, category, author }
//   export async function execute(input, config) { … return result }
//   export async function test()  { … return { passed: boolean, message: string } }

import * as builtins from '../tools/index.js'
import { withToolContractValidation } from '../tools/index.js'
import { normalizeToolName, schemaVersion } from '../tools/contracts.js'
import { fnv1a32 } from '../utils/fnv.js'
import { KEYS } from '../shared/storageKeys.js'

const USER_TOOLS_KEY = KEYS.LS.USER_TOOLS

function readUserToolEntries() {
  try { return JSON.parse(localStorage.getItem(USER_TOOLS_KEY)) || [] } catch { return [] }
}

function writeUserToolEntries(entries) {
  localStorage.setItem(USER_TOOLS_KEY, JSON.stringify(entries))
}

// ── Validation ────────────────────────────────────────────────────────────────
export function validateToolModule(mod) {
  const errors = []
  if (!mod.toolMeta)               errors.push('Missing export: toolMeta')
  if (typeof mod.execute !== 'function') errors.push('Missing export: execute (async function)')
  if (typeof mod.test    !== 'function') errors.push('Missing export: test (async function)')
  if (mod.toolMeta) {
    const { id, name, version, description, category } = mod.toolMeta
    if (!id)          errors.push('toolMeta.id is required')
    if (!name)        errors.push('toolMeta.name is required')
    if (!version)     errors.push('toolMeta.version is required')
    if (!description) errors.push('toolMeta.description is required')
    if (!['coding', 'utility', 'analysis'].includes(category)) {
      errors.push(`toolMeta.category must be one of: coding, utility, analysis (got "${category}")`)
    }
  }
  return errors
}

// ── Checksum (FNV-1a 32-bit, hex string) ─────────────────────────────────────
function checksum(str) {
  return (fnv1a32(str) >>> 0).toString(16)
}

// ── Parse built-in modules ────────────────────────────────────────────────────
function loadBuiltins() {
  return Object.values(builtins)
    .filter(mod => mod?.toolMeta && typeof mod?.execute === 'function')
    .map(mod => ({
    ...mod.toolMeta,
    _execute: withToolContractValidation(normalizeToolName(mod.toolMeta.id), mod.execute),
    _test:    mod.test,
    _schemaVersion: schemaVersion(),
    _builtin: true,
    _checksum: null,
  }))
}

// ── Load user tools from localStorage ────────────────────────────────────────
function loadUserTools() {
  try {
    const stored = JSON.parse(localStorage.getItem(USER_TOOLS_KEY)) || []
    return stored.map(entry => {
      try {
        const mod = evalToolSource(entry.source)
        const errors = validateToolModule(mod)
        if (errors.length) return null
        return {
          ...mod.toolMeta,
          _execute:  mod.execute,
          _test:     mod.test,
          _builtin:  false,
          _checksum: entry.checksum,
          _source:   entry.source,
          _installedAt: entry.installedAt,
        }
      } catch { return null }
    }).filter(Boolean)
  } catch { return [] }
}

// ── Safely evaluate a tool's source code ─────────────────────────────────────
// Uses Function constructor to parse ES module-like code.
// Transforms export declarations into plain assignments so we can eval them.
function evalToolSource(source) {
  // Strip import statements (user tools should be self-contained)
  let code = source
    .replace(/^\s*import\s+.*?from\s+['"][^'"]+['"]\s*;?\s*$/gm, '// [import removed]')

  // Transform: export const X = …  → const X = …; __exports__.X = X
  // Transform: export async function X(  → async function X(  then __exports__.X = X
  code = code
    .replace(/\bexport\s+(const|let|var)\s+(\w+)/g, (_, kw, name) => `${kw} ${name}; __exports__['${name}'] = ${name}; void 0; const __dummy_${name}_`)
    .replace(/\bexport\s+(async\s+)?function\s+(\w+)/g, (_, asyncKw, name) => `${asyncKw || ''}function ${name}`)

  // After replacing, re-attach function names to __exports__
  const fnNames = []
  source.replace(/\bexport\s+(?:async\s+)?function\s+(\w+)/g, (_, n) => fnNames.push(n))

  const assigns = fnNames.map(n => `__exports__['${n}'] = ${n};`).join('\n')

  // Remove the broken const __dummy_ lines we inserted
  code = code.replace(/;\s*const __dummy_\w+_/g, '')

  const wrapped = `
    const __exports__ = {};
    ${code}
    ${assigns}
    return __exports__;
  `

  // eslint-disable-next-line no-new-func
  const fn = new Function(wrapped)
  return fn()
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Return all registered tools (built-in + user-installed). */
export function getAllTools() {
  return [...loadBuiltins(), ...loadUserTools()]
}

export function getUserToolEntries() {
  return readUserToolEntries()
}

export function setUserToolEntries(entries = []) {
  try { writeUserToolEntries(Array.isArray(entries) ? entries : []) } catch {}
}

/** Install a tool from its source code string. Returns { ok, errors, tool }. */
export function installTool(source) {
  let mod
  try {
    mod = evalToolSource(source)
  } catch (e) {
    return { ok: false, errors: [`Parse error: ${e.message}`], tool: null }
  }

  const errors = validateToolModule(mod)
  if (errors.length) return { ok: false, errors, tool: null }

  const stored = readUserToolEntries()

  // Replace existing tool with same id
  const idx = stored.findIndex(e => {
    try { return evalToolSource(e.source)?.toolMeta?.id === mod.toolMeta.id } catch { return false }
  })

  const entry = { source, checksum: checksum(source), installedAt: new Date().toISOString() }
  if (idx >= 0) stored[idx] = entry
  else stored.push(entry)

  try {
    writeUserToolEntries(stored)
  } catch {
    return { ok: false, errors: ['localStorage quota exceeded'], tool: null }
  }

  return {
    ok: true,
    errors: [],
    tool: { ...mod.toolMeta, _checksum: entry.checksum, _installedAt: entry.installedAt, _builtin: false },
  }
}

/** Install or replace a user tool at a fixed slot index (0-based). */
export function installToolAtSlot(source, slotIndex, maxSlots = 3) {
  let mod
  try {
    mod = evalToolSource(source)
  } catch (e) {
    return { ok: false, errors: [`Parse error: ${e.message}`], tool: null }
  }
  const errors = validateToolModule(mod)
  if (errors.length) return { ok: false, errors, tool: null }
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= maxSlots) {
    return { ok: false, errors: [`Slot index out of range (0-${maxSlots - 1})`], tool: null }
  }

  const entry = { source, checksum: checksum(source), installedAt: new Date().toISOString() }
  const stored = readUserToolEntries()

  // Remove duplicates by tool id first, then set the target slot.
  const deduped = stored.filter(e => {
    try { return evalToolSource(e.source)?.toolMeta?.id !== mod.toolMeta.id } catch { return false }
  })
  const next = deduped.slice(0, maxSlots)
  while (next.length < maxSlots) next.push(null)
  next[slotIndex] = entry

  try {
    writeUserToolEntries(next.filter(Boolean))
  } catch {
    return { ok: false, errors: ['localStorage quota exceeded'], tool: null }
  }

  return {
    ok: true,
    errors: [],
    tool: { ...mod.toolMeta, _checksum: entry.checksum, _installedAt: entry.installedAt, _builtin: false },
  }
}

/** Uninstall a user tool by id. Returns true if removed. */
export function uninstallTool(id) {
  const stored = readUserToolEntries()
  const next = stored.filter(e => {
    try { return evalToolSource(e.source)?.toolMeta?.id !== id } catch { return true }
  })
  if (next.length === stored.length) return false
  try { writeUserToolEntries(next) } catch {}
  return true
}

/** Run a tool's execute() with the given input and config. */
export async function executeTool(id, input, config = {}) {
  const all = getAllTools()
  const tool = all.find(t => t.id === id)
  if (!tool) throw new Error(`Tool not found: ${id}`)
  return tool._execute(input, config)
}

/** Run a tool's test() and return { passed, message }. */
export async function testTool(id) {
  const all = getAllTools()
  const tool = all.find(t => t.id === id)
  if (!tool) return { passed: false, message: `Tool not found: ${id}` }
  try {
    return await tool._test()
  } catch (e) {
    return { passed: false, message: `Uncaught error: ${e.message}` }
  }
}

/** Export a tool's source code as a downloadable Blob. */
export function exportToolSource(id) {
  const userTools = loadUserTools()
  const tool = userTools.find(t => t.id === id)
  if (tool?._source) return tool._source

  // Built-in: synthesize minimal source from meta
  const builtin = loadBuiltins().find(t => t.id === id)
  if (builtin) {
    return `// ${builtin.name} v${builtin.version} — built-in tool (no editable source)\nexport const toolMeta = ${JSON.stringify(builtin, (k, v) => k.startsWith('_') ? undefined : v, 2)};\n`
  }
  return null
}
