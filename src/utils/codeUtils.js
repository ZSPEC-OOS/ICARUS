// ─── Code utilities ───────────────────────────────────────────────────────────
// Pure functions extracted from Icarus.jsx — no React, no side-effects.
// Safe to import from any component or service.

import { SANDBOX_JS_TIMEOUT_MS, SANDBOX_PY_TIMEOUT_MS, PYODIDE_VERSION } from '../config/constants.js'

export const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/pyodide.js`

// ── Language detection ────────────────────────────────────────────────────────
const EXT_MAP = {
  js:'javascript', jsx:'javascript', ts:'typescript', tsx:'typescript',
  py:'python', go:'go', rs:'rust', java:'java', rb:'ruby', css:'css',
  html:'html', json:'json', md:'markdown', sh:'bash', yaml:'yaml',
  yml:'yaml', vue:'vue', svelte:'svelte', c:'c', cpp:'cpp', h:'c',
  hpp:'cpp', php:'php', kt:'kotlin', scala:'scala',
}

export function detectLanguage(filePath, code) {
  if (filePath) {
    const ext = filePath.split('.').pop()?.toLowerCase()
    if (EXT_MAP[ext]) return EXT_MAP[ext]
  }
  if (code) {
    if (code.includes('def ') && code.includes(':')) return 'python'
    if (code.includes('package main') || /\bfunc\b/.test(code)) return 'go'
    if (code.includes('fn ') && code.includes('->')) return 'rust'
    if (code.includes('const ') || code.includes('=>')) return 'javascript'
    if (code.includes('public class') || code.includes('import java')) return 'java'
    if (code.includes('class ') && code.includes('def ')) return 'ruby'
    if (code.includes('#include') || code.includes('int main')) return 'c'
    if (code.includes('<?php')) return 'php'
  }
  return 'javascript'
}

// ── Code block extraction ─────────────────────────────────────────────────────
// Strips surrounding markdown fences if present.
export function extractCode(raw) {
  if (!raw) return ''
  const m = raw.match(/```(?:[a-zA-Z]*\n)?([\s\S]*?)```/)
  return m ? m[1].trim() : raw.trim()
}

// ── Syntax highlighter ────────────────────────────────────────────────────────
// Lightweight client-side highlighter — no external dep, matches existing tokens.
export function highlightCode(code, language) {
  if (!code) return ''
  let esc = code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  const lang = (language || '').toLowerCase()

  if (lang === 'html' || lang === 'xml') {
    esc = esc
      .replace(/(&lt;\/?[a-zA-Z][a-zA-Z0-9:-]*)/g, '<span class="lk-kw">$1</span>')
      .replace(/((?:class|id|href|src|type|rel|style|alt|data-[a-z-]+)=)/g, '<span class="lk-attr">$1</span>')
      .replace(/(&quot;[^&]*&quot;)/g, '<span class="lk-str">$1</span>')
    return esc
  }

  esc = esc.replace(/(&#39;[^&\n]*&#39;|&quot;[^&\n]*&quot;|`[^`\n]*`)/g, '<span class="lk-str">$1</span>')
  esc = esc.replace(/(\/\/[^\n]*)/g, '<span class="lk-cmt">$1</span>').replace(/(#[^\n]*)/g, '<span class="lk-cmt">$1</span>')

  const pyKw = ['def','class','import','from','return','if','elif','else','for','while','in','not','and','or','True','False','None','async','await','with','as','pass','raise','try','except','finally','lambda','yield']
  const jsKw = ['const','let','var','function','return','if','else','for','while','class','import','export','default','new','this','async','await','try','catch','throw','typeof','instanceof','null','undefined','true','false','from','extends','super','static','interface','type','enum','void']
  const kws  = lang === 'python' ? pyKw : jsKw
  esc = esc.replace(new RegExp(`\\b(${kws.join('|')})\\b`, 'g'), '<span class="lk-kw">$1</span>')
  esc = esc.replace(/\b(\d+\.?\d*)\b/g, '<span class="lk-num">$1</span>')
  return esc
}

// ── EDIT block application ────────────────────────────────────────────────────
// Model outputs blocks like:  EDIT_START\nOLD:\n<text>\nNEW:\n<text>\nEDIT_END
export function applyEditBlocks(existing, response) {
  const re = /EDIT_START\s*\nOLD:\s*\n([\s\S]*?)\nNEW:\s*\n([\s\S]*?)\nEDIT_END/g
  let result = existing
  const edits = []
  let match
  while ((match = re.exec(response)) !== null) {
    const oldStr = match[1].replace(/\n$/, '')
    const newStr = match[2].replace(/\n$/, '')
    const occurrences = oldStr ? result.split(oldStr).length - 1 : 0
    let applied = occurrences > 0
    if (applied) {
      // Replace only the first occurrence to match typical surgical-edit intent.
      // If oldStr appears more than once, warn via the edits record so callers can surface it.
      const idx = result.indexOf(oldStr)
      result = result.slice(0, idx) + newStr + result.slice(idx + oldStr.length)
      if (occurrences > 1) {
        // Flag duplicate matches so the repair engine / activity log can warn the user
        edits.push({ old: oldStr, new: newStr, applied: true, duplicateMatch: true })
        continue
      }
    } else {
      // Fuzzy fallback: match by trimming leading whitespace on each line
      const normOld    = oldStr.split('\n').map(l => l.trimStart()).join('\n')
      const normResult = result.split('\n').map(l => l.trimStart()).join('\n')
      if (normResult.includes(normOld)) {
        const startIdx    = normResult.indexOf(normOld)
        const linesBefore = normResult.slice(0, startIdx).split('\n').length - 1
        const oldLineCount = normOld.split('\n').length
        const origLines   = result.split('\n')
        const slicedOld   = origLines.slice(linesBefore, linesBefore + oldLineCount).join('\n')
        if (slicedOld) {
          result  = result.slice(0, result.indexOf(slicedOld)) + newStr +
                    result.slice(result.indexOf(slicedOld) + slicedOld.length)
          applied = true
        }
      }
    }
    edits.push({ old: oldStr, new: newStr, applied })
  }
  return { result, edits }
}

// ── Sandbox HTML builders ─────────────────────────────────────────────────────

export function buildPyodideSandboxHtml(code) {
  const pyCode = JSON.stringify(code)
  return `<!DOCTYPE html><html><head><script src="${PYODIDE_CDN}"><\/script><script>
const __log=[];
window.addEventListener('error',e=>{__log.push({level:'error',text:e.error?.stack||e.message});parent.postMessage({done:true,log:__log},'*');},true);
const __t=setTimeout(()=>{__log.push({level:'warn',text:'[timeout] 20 s limit reached'});parent.postMessage({done:true,log:__log},'*');},${SANDBOX_PY_TIMEOUT_MS});
async function main(){
  try{
    const py=await loadPyodide();
    py.setStdout({batched:t=>__log.push({level:'log',text:t})});
    py.setStderr({batched:t=>__log.push({level:'error',text:t})});
    await py.runPythonAsync(${pyCode});
    clearTimeout(__t);parent.postMessage({done:true,log:__log},'*');
  }catch(e){clearTimeout(__t);__log.push({level:'error',text:String(e)});parent.postMessage({done:true,log:__log},'*');}
}
main()
<\/script></head><body></body></html>`
}

export function buildSandboxHtml(code, setup = '') {
  const escaped  = (code + '').replace(/<\/script>/gi, '<\\/script>')
  const setupEsc = (setup + '').replace(/<\/script>/gi, '<\\/script>')
  return `<!DOCTYPE html><html><head><script>
const __log=[];
['log','warn','error','info'].forEach(m=>{
  const o=console[m].bind(console);
  console[m]=(...a)=>{__log.push({level:m,text:a.map(x=>typeof x==='object'?JSON.stringify(x,null,2):String(x)).join(' ')});o(...a);};
});
window.addEventListener('error',e=>{__log.push({level:'error',text:e.error?.stack||e.message});parent.postMessage({done:true,log:__log},'*');},true);
const __t=setTimeout(()=>{__log.push({level:'warn',text:'[timeout] 5 s limit reached'});parent.postMessage({done:true,log:__log},'*');},${SANDBOX_JS_TIMEOUT_MS});
try{
  ${setupEsc}
  ${escaped}
  clearTimeout(__t);parent.postMessage({done:true,log:__log},'*');
}catch(e){clearTimeout(__t);__log.push({level:'error',text:e.stack||e.message});parent.postMessage({done:true,log:__log},'*');}
<\/script></head><body></body></html>`
}

// ── Code completeness detection ───────────────────────────────────────────────
// Returns true if the code looks complete — no trailing stubs, balanced braces.

const TRUNCATION_RE = [
  /\.\.\.\s*$/m,
  /\/\/\s*\.\.\./,
  /#\s*\.\.\./,
  /\/\/\s*TODO/i,
  /#\s*TODO/i,
  /\/\/\s*(rest|remaining)\s*(of|to)/i,
  /#\s*(rest|remaining)\s*(of|to)/i,
  /\/\/\s*implement\s*(here|this|rest|remaining)/i,
  /#\s*implement\s*(here|this|rest|remaining)/i,
  /\[rest of (the )?implementation\]/i,
  /\[add (remaining|more)\]/i,
  /\/\/ your code (here|goes here)/i,
  /# your code (here|goes here)/i,
  /\/\/ \.\.\. (more|rest|other)/i,
]

const BRACE_LANGS = new Set(['javascript', 'typescript', 'java', 'go', 'rust', 'css'])

export function isCodeComplete(code, lang) {
  if (!code || code.trim().length < 30) return false
  if (TRUNCATION_RE.some(re => re.test(code))) return false

  if (BRACE_LANGS.has(lang)) {
    let depth = 0
    let inStr = null
    for (let i = 0; i < code.length; i++) {
      const ch = code[i]
      if (inStr) {
        if (ch === inStr && code[i - 1] !== '\\') inStr = null
      } else if (ch === '"' || ch === "'" || ch === '`') {
        inStr = ch
      } else if (ch === '{') {
        depth++
      } else if (ch === '}') {
        depth--
      }
    }
    if (depth !== 0) return false
  }
  return true
}

// ── Language-specific remediation checklists ──────────────────────────────────
export const LANG_CHECKLIST = {
  python:     'Check for: undefined variables, missing imports, wrong indentation, mismatched brackets, str+int errors, f-string syntax, missing colons after def/if/for/with.',
  go:         'Check for: unused imports, undefined identifiers, missing return statements, nil pointer dereferences, wrong error handling, incorrect struct fields.',
  rust:       'Check for: missing semicolons, borrow errors, unused variables, missing match arms, use-before-declaration, missing trait imports.',
  java:       'Check for: missing semicolons, undeclared variables, wrong method signatures, missing imports, type mismatches, unclosed braces.',
  ruby:       'Check for: undefined methods, missing end keywords, wrong block syntax, undefined variables, wrong argument count.',
  css:        'Check for: unclosed braces, invalid property names, missing semicolons, invalid color values, incorrect selector syntax.',
  javascript: null,  // handled by sandbox execution
  typescript: null,  // handled by sandbox execution
  c:          'Check for: missing semicolons, undeclared variables, wrong function signatures, missing includes, type mismatches, unclosed braces.',
  cpp:        'Check for: missing semicolons, undeclared variables, wrong function signatures, missing includes, type mismatches, unclosed braces, namespace issues.',
  php:        'Check for: missing semicolons, undeclared variables, wrong function calls, missing includes, syntax errors.',
  kotlin:     'Check for: missing semicolons, undeclared variables, wrong function signatures, null safety issues.',
  scala:      'Check for: missing semicolons, undeclared variables, wrong method signatures, type mismatches.',
}

// Languages where autoRemediate is useful (sandbox or checklist)
export const REMEDIATABLE = new Set([
  'javascript','typescript','python','go','rust','java','ruby',
  'css','c','cpp','php','kotlin','scala',
])

// ── Test file path derivation ─────────────────────────────────────────────────
// src/foo/bar.js → src/foo/bar.test.js
export function testFilePath(fp) {
  if (!fp) return ''
  return fp.replace(/(\.[^./]+)$/, '.test$1')
}

// ── GitHub URL parser ─────────────────────────────────────────────────────────
export function parseGitHubUrl(url) {
  const clean = url.trim().replace(/^https?:\/\//, '').replace(/\.git$/, '')
  const m = clean.match(/^(?:github\.com\/)?([^/?\s]+)\/([^/?\s#]+)/)
  return m ? { owner: m[1], repo: m[2] } : null
}
