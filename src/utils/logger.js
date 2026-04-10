// ─── Structured logger ────────────────────────────────────────────────────────
// createLogger(moduleName) returns a module-scoped {debug,info,warn,error} set.
//
// Behaviour:
//   • debug is suppressed in production builds (VITE_PROD / import.meta.env.PROD).
//   • All entries are stored in a 200-entry ring buffer at globalThis.__blswanLogs
//     for devtools inspection: `window.__blswanLogs.slice(-10)` in the browser
//     console shows the last 10 log entries from any module.
//   • meta (second argument) is attached as structured data — objects stay as
//     objects rather than being stringified, so devtools can expand them.

const RING_CAP = 200

/** @type {Array<{t:number,level:string,module:string,msg:string,meta:*}>} */
const _ring = []

// Detect production at module load time so we don't evaluate import.meta on
// every log call. Guard with try/catch because import.meta.env is Vite-only
// (undefined in Node test runner and CLI).
let _isProd = false
try { _isProd = !!import.meta.env?.PROD } catch {}

/**
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} module
 * @param {string} msg
 * @param {*} [meta]
 */
function _write(level, module, msg, meta) {
  const entry = { t: Date.now(), level, module, msg, ...(meta !== undefined && { meta }) }
  _ring.push(entry)
  if (_ring.length > RING_CAP) _ring.shift()

  // Expose ring buffer for devtools
  try { globalThis.__blswanLogs = _ring } catch {}

  const tag = `[${module}]`
  const hasMeta = meta !== undefined

  switch (level) {
    case 'debug':
      if (!_isProd) (hasMeta ? console.debug(tag, msg, meta) : console.debug(tag, msg))
      break
    case 'info':
      hasMeta ? console.info(tag, msg, meta) : console.info(tag, msg)
      break
    case 'warn':
      hasMeta ? console.warn(tag, msg, meta) : console.warn(tag, msg)
      break
    case 'error':
      hasMeta ? console.error(tag, msg, meta) : console.error(tag, msg)
      break
  }
}

/**
 * Create a module-scoped logger.
 *
 * @param {string} moduleName  Short name that appears in every log line, e.g. 'MemoryGraph'
 * @returns {{ debug(msg:string,meta?:*):void, info(msg:string,meta?:*):void, warn(msg:string,meta?:*):void, error(msg:string,meta?:*):void }}
 */
export function createLogger(moduleName) {
  return {
    debug: (msg, meta) => _write('debug', moduleName, msg, meta),
    info:  (msg, meta) => _write('info',  moduleName, msg, meta),
    warn:  (msg, meta) => _write('warn',  moduleName, msg, meta),
    error: (msg, meta) => _write('error', moduleName, msg, meta),
  }
}

/** Read the current ring buffer snapshot (newest entry last). */
export function getLogRing() {
  return [..._ring]
}
