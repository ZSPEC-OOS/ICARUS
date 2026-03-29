/**
 * @typedef {Object} ToolContract
 * @property {import('./contracts.js').TOOL_CONTRACTS[string]['input']} input
 * @property {import('./contracts.js').TOOL_CONTRACTS[string]['output']} output
 */

/**
 * @typedef {Object} ToolTraceEntry
 * @property {string} traceId
 * @property {string} toolName
 * @property {string} schemaVersion
 * @property {unknown} input
 * @property {unknown} [output]
 * @property {string|null} [error]
 * @property {number} [durationMs]
 * @property {string} timestamp
 * @property {'started'|'ok'|'error'} status
 */

export {}
