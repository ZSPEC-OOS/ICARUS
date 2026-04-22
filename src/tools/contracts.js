const SCHEMA_VERSION = '1.0.0'

const baseString = { type: 'string' }
const baseNumber = { type: 'number' }

export const TOOL_CONTRACTS = {
  analyze_codebase: {
    input: { type: 'object', additionalProperties: false, properties: { top_hubs: baseNumber, max_chars: baseNumber }, required: [] },
    output: { type: 'string' },
  },
  discover_skills: {
    input: { type: 'object', additionalProperties: false, properties: { limit: baseNumber, include_frontmatter: { type: 'boolean' } }, required: [] },
    output: { type: 'string' },
  },
  read_file: {
    input: { type: 'object', additionalProperties: false, properties: { path: baseString, start_line: baseNumber, end_line: baseNumber }, required: ['path'] },
    output: { type: 'string' },
  },
  write_file: {
    input: { type: 'object', additionalProperties: false, properties: { path: baseString, content: baseString, message: baseString }, required: ['path', 'content'] },
    output: { type: 'string' },
  },
  edit_file: {
    input: { type: 'object', additionalProperties: false, properties: { path: baseString, old_str: baseString, new_str: baseString, message: baseString }, required: ['path', 'old_str', 'new_str'] },
    output: { type: 'string' },
  },
  delete_file: {
    input: { type: 'object', additionalProperties: false, properties: { path: baseString, message: baseString }, required: ['path'] },
    output: { type: 'string' },
  },
  list_directory: {
    input: { type: 'object', additionalProperties: false, properties: { path: baseString }, required: [] },
    output: { type: 'string' },
  },
  search_files: {
    input: { type: 'object', additionalProperties: false, properties: { query: baseString, limit: baseNumber }, required: ['query'] },
    output: { type: 'string' },
  },
  read_many_files: {
    input: { type: 'object', additionalProperties: false, properties: { paths: { type: 'array', items: baseString } }, required: ['paths'] },
    output: { type: 'string' },
  },
  glob: {
    input: { type: 'object', additionalProperties: false, properties: { pattern: baseString, path: baseString }, required: ['pattern'] },
    output: { type: 'string' },
  },
  grep: {
    input: { type: 'object', additionalProperties: false, properties: { pattern: baseString, path: baseString, ignore_case: { type: 'boolean' } }, required: ['pattern'] },
    output: { type: 'string' },
  },
  lint_file: {
    input: { type: 'object', additionalProperties: false, properties: { path: baseString }, required: ['path'] },
    output: { type: 'string' },
  },
  analyze_stacktrace: {
    input: { type: 'object', additionalProperties: false, properties: { stacktrace: baseString, max_frames: baseNumber }, required: ['stacktrace'] },
    output: { type: 'string' },
  },
  find_tech_debt: {
    input: { type: 'object', additionalProperties: false, properties: { markers: { type: 'array', items: baseString }, path: baseString, limit: baseNumber }, required: [] },
    output: { type: 'string' },
  },
  check_url_health: {
    input: { type: 'object', additionalProperties: false, properties: { url: baseString, timeout_ms: baseNumber, method: baseString }, required: ['url'] },
    output: { type: 'string' },
  },
  json_repair: {
    input: { type: 'object', additionalProperties: false, properties: { text: baseString }, required: ['text'] },
    output: { type: 'string' },
  },
  list_source_directory: {
    input: { type: 'object', additionalProperties: false, properties: { path: baseString }, required: [] },
    output: { type: 'string' },
  },
  read_source_file: {
    input: { type: 'object', additionalProperties: false, properties: { path: baseString }, required: ['path'] },
    output: { type: 'string' },
  },
  create_pull_request: {
    input: { type: 'object', additionalProperties: false, properties: { title: baseString, body: baseString, head: baseString, base: baseString }, required: ['title', 'head', 'base'] },
    output: { type: 'string' },
  },
  run_command: {
    input: { type: 'object', additionalProperties: false, properties: { cmd: baseString, cwd: baseString }, required: ['cmd'] },
    output: { type: 'string' },
  },
  web_fetch: {
    input: { type: 'object', additionalProperties: false, properties: { url: baseString }, required: ['url'] },
    output: { type: 'string' },
  },
  web_search: {
    input: { type: 'object', additionalProperties: false, properties: { query: baseString, max_results: baseNumber, include_domains: { type: 'array', items: baseString } }, required: ['query'] },
    output: { type: 'string' },
  },
  update_memory: {
    input: { type: 'object', additionalProperties: false, properties: { note: baseString }, required: ['note'] },
    output: { type: 'string' },
  },
  todo: {
    input: { type: 'object', additionalProperties: false, properties: { action: { type: 'string', enum: ['add', 'in_progress', 'done'] }, task: baseString }, required: ['action', 'task'] },
    output: { type: 'string' },
  },
  revert_file: {
    input: { type: 'object', additionalProperties: false, properties: { path: baseString, commits_back: baseNumber, message: baseString }, required: ['path'] },
    output: { type: 'string' },
  },
  hybrid_search: {
    input: { type: 'object', additionalProperties: false, properties: { query: baseString, limit: baseNumber }, required: ['query'] },
    output: { type: 'string' },
  },
  retrieve_context: {
    input: { type: 'object', additionalProperties: false, properties: { query: baseString }, required: ['query'] },
    output: { type: 'string' },
  },
  token_io_optimizer: {
    input: { type: 'object', additionalProperties: false, properties: { task: baseString, expected_output_size: { type: 'string', enum: ['small', 'medium', 'large', 'huge'] }, mode: { type: 'string', enum: ['off', 'adaptive', 'aggressive'] } }, required: ['task'] },
    output: { type: 'string' },
  },
  spawn_agent: {
    input: { type: 'object', additionalProperties: false, properties: { task: baseString, description: baseString, allow_writes: { type: 'boolean' } }, required: ['task'] },
    output: { type: 'string' },
  },
  multi_edit_file: {
    input: {
      type: 'object', additionalProperties: false,
      properties: {
        path:    baseString,
        edits:   { type: 'array', items: { type: 'object', additionalProperties: false, properties: { old_str: baseString, new_str: baseString }, required: ['old_str', 'new_str'] } },
        message: baseString,
      },
      required: ['path', 'edits'],
    },
    output: { type: 'string' },
  },
  search_replace_many: {
    input: {
      type: 'object', additionalProperties: false,
      properties: {
        pattern:     baseString,
        replacement: baseString,
        path_glob:   baseString,
        literal:     { type: 'boolean' },
        dry_run:     { type: 'boolean' },
        message:     baseString,
      },
      required: ['pattern', 'replacement'],
    },
    output: { type: 'string' },
  },
  move_file: {
    input: {
      type: 'object', additionalProperties: false,
      properties: {
        from:           baseString,
        to:             baseString,
        update_imports: { type: 'boolean' },
        message:        baseString,
      },
      required: ['from', 'to'],
    },
    output: { type: 'string' },
  },
  apply_patch: {
    input: {
      type: 'object', additionalProperties: false,
      properties: { path: baseString, patch: baseString, message: baseString },
      required: ['path', 'patch'],
    },
    output: { type: 'string' },
  },
  git_log: {
    input: { type: 'object', additionalProperties: false, properties: { path: baseString, branch: baseString, limit: baseNumber }, required: [] },
    output: { type: 'string' },
  },
  check_ci_status: {
    input: { type: 'object', additionalProperties: false, properties: { branch: baseString }, required: [] },
    output: { type: 'string' },
  },
  create_github_issue: {
    input: { type: 'object', additionalProperties: false, properties: { title: baseString, body: baseString, labels: { type: 'array', items: baseString } }, required: ['title'] },
    output: { type: 'string' },
  },
  resolve_merge_conflict: {
    input: { type: 'object', additionalProperties: false, properties: { path: baseString, resolution: { type: 'string', enum: ['ours', 'theirs', 'manual'] }, manual_content: baseString, message: baseString }, required: ['path', 'resolution'] },
    output: { type: 'string' },
  },
  get_diff: {
    input: { type: 'object', additionalProperties: false, properties: { base: baseString, head: baseString, path: baseString }, required: [] },
    output: { type: 'string' },
  },
  type_check: {
    input: { type: 'object', additionalProperties: false, properties: { path: baseString }, required: [] },
    output: { type: 'string' },
  },
  run_tests: {
    input: { type: 'object', additionalProperties: false, properties: { path: baseString, test_pattern: baseString }, required: [] },
    output: { type: 'string' },
  },
  watch_process: {
    input: { type: 'object', additionalProperties: false, properties: { port: baseNumber, process_name: baseString, lines: baseNumber }, required: [] },
    output: { type: 'string' },
  },
  browser_screenshot: {
    input: { type: 'object', additionalProperties: false, properties: { url: baseString, port: baseNumber }, required: [] },
    output: { type: 'string' },
  },
}

export function normalizeToolName(name = '') {
  return String(name).trim().replace(/-/g, '_')
}

function schemaType(schema) {
  if (!schema || typeof schema !== 'object') return 'invalid'
  return schema.type || 'any'
}

function validate(schema, value, path = '$') {
  const errors = []
  const type = schemaType(schema)

  if (type === 'any') return errors
  if (type === 'string' && typeof value !== 'string') errors.push(`${path}: expected string`)
  if (type === 'number' && (typeof value !== 'number' || Number.isNaN(value))) errors.push(`${path}: expected number`)
  if (type === 'boolean' && typeof value !== 'boolean') errors.push(`${path}: expected boolean`)

  if (type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected array`)
    } else if (schema.items) {
      value.forEach((item, idx) => errors.push(...validate(schema.items, item, `${path}[${idx}]`)))
    }
  }

  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${path}: expected object`)
    } else {
      const props = schema.properties || {}
      const required = schema.required || []
      for (const reqKey of required) {
        if (!(reqKey in value)) errors.push(`${path}.${reqKey}: is required`)
      }
      for (const [k, v] of Object.entries(value)) {
        if (schema.additionalProperties === false && !props[k]) {
          errors.push(`${path}.${k}: unknown property`)
          continue
        }
        if (props[k]) errors.push(...validate(props[k], v, `${path}.${k}`))
      }
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: must be one of [${schema.enum.join(', ')}]`)
  }

  return errors
}

export function getToolContract(toolName) {
  return TOOL_CONTRACTS[normalizeToolName(toolName)] || null
}

export function validateToolInput(toolName, input) {
  const contract = getToolContract(toolName)
  if (!contract?.input) return { ok: true, errors: [] }
  const errors = validate(contract.input, input)
  return { ok: errors.length === 0, errors, schemaVersion: SCHEMA_VERSION }
}

export function validateToolOutput(toolName, output) {
  const contract = getToolContract(toolName)
  if (!contract?.output) return { ok: true, errors: [] }
  const errors = validate(contract.output, output)
  return { ok: errors.length === 0, errors, schemaVersion: SCHEMA_VERSION }
}

export function getInputSchema(toolName) {
  return getToolContract(toolName)?.input || { type: 'object', properties: {}, required: [] }
}

export function schemaVersion() {
  return SCHEMA_VERSION
}
