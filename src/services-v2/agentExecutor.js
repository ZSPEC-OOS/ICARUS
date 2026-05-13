/**
 * @module agentExecutor (v2)
 * Thin executor: no hooks, no repair engine, no auto-magic.
 * All errors are returned as ERROR: strings — never thrown to the caller.
 */

const MAX_READ_LINES = 500;
const MAX_READ_MANY_FILES = 5;
const MAX_READ_MANY_LINES = 200;
const MAX_GREP_RESULTS = 50;
const MAX_COMMAND_OUTPUT = 2000;
const MAX_WEB_FETCH_CHARS = 15000;
const MAX_WEB_SEARCH_RESULTS = 8;

/**
 * @typedef {Object} ExecutorConfig
 * @property {Function} [fsRead]      - (path, opts) => string | Promise<string>
 * @property {Function} [fsWrite]     - (path, content) => void | Promise<void>
 * @property {Function} [fsEdit]      - (path, oldStr, newStr) => void | Promise<void>
 * @property {Function} [fsDelete]    - (path) => void | Promise<void>
 * @property {Function} [fsList]      - (dir) => string[] | Promise<string[]>
 * @property {Function} [fsSearch]    - (dir, pattern) => string[] | Promise<string[]>
 * @property {Function} [fsGrep]      - (pattern, path) => string[] | Promise<string[]>
 * @property {Function} [runCommand]  - (cmd) => string | Promise<string>
 * @property {Function} [webFetch]    - (url) => string | Promise<string>
 * @property {Function} [webSearch]   - (query) => object[] | Promise<object[]>
 * @property {Function} [updateMemory]- (key, value) => void | Promise<void>
 */

/**
 * Create a tool executor function bound to the provided I/O implementations.
 * @param {ExecutorConfig} config
 * @returns {(name: string, input: object) => Promise<string>}
 */
export function makeExecutor(config = {}) {
  const {
    fsRead,
    fsWrite,
    fsEdit,
    fsDelete,
    fsList,
    fsSearch,
    fsGrep,
    runCommand: runCmd,
    webFetch,
    webSearch,
    updateMemory,
  } = config;

  async function executeTool(name, input = {}) {
    try {
      switch (name) {
        case 'read_file': {
          if (!fsRead) return 'ERROR: read_file not configured';
          const raw = await fsRead(input.path, { maxLines: MAX_READ_LINES });
          const lines = String(raw).split('\n');
          if (lines.length > MAX_READ_LINES) {
            return lines.slice(0, MAX_READ_LINES).join('\n') + `\n[...truncated at ${MAX_READ_LINES} lines]`;
          }
          return String(raw);
        }

        case 'read_many_files': {
          if (!fsRead) return 'ERROR: read_many_files not configured';
          const paths = Array.isArray(input.paths) ? input.paths.slice(0, MAX_READ_MANY_FILES) : [];
          if (paths.length === 0) return 'ERROR: no paths provided';
          const results = [];
          for (const p of paths) {
            try {
              const raw = await fsRead(p, { maxLines: MAX_READ_MANY_LINES });
              const lines = String(raw).split('\n');
              const content = lines.length > MAX_READ_MANY_LINES
                ? lines.slice(0, MAX_READ_MANY_LINES).join('\n') + `\n[...truncated at ${MAX_READ_MANY_LINES} lines]`
                : String(raw);
              results.push(`=== ${p} ===\n${content}`);
            } catch (err) {
              results.push(`=== ${p} ===\nERROR: ${err.message}`);
            }
          }
          return results.join('\n\n');
        }

        case 'write_file': {
          if (!fsWrite) return 'ERROR: write_file not configured';
          await fsWrite(input.path, input.content ?? '');
          return `wrote ${input.path}`;
        }

        case 'edit_file': {
          if (!fsEdit) return 'ERROR: edit_file not configured';
          if (!input.old_str) return 'ERROR: old_str is required for edit_file';
          // Validate old_str exists before attempting edit
          if (fsRead) {
            let existing;
            try {
              existing = await fsRead(input.path);
            } catch {
              return `ERROR: could not read ${input.path} to validate edit`;
            }
            if (!String(existing).includes(input.old_str)) {
              return `ERROR: old_str not found in ${input.path}`;
            }
          }
          await fsEdit(input.path, input.old_str, input.new_str ?? '');
          return `edited ${input.path}`;
        }

        case 'delete_file': {
          if (!fsDelete) return 'ERROR: delete_file not configured';
          await fsDelete(input.path);
          return `deleted ${input.path}`;
        }

        case 'list_directory': {
          if (!fsList) return 'ERROR: list_directory not configured';
          const entries = await fsList(input.path ?? '.');
          return Array.isArray(entries) ? entries.join('\n') : String(entries);
        }

        case 'search_files': {
          if (!fsSearch) return 'ERROR: search_files not configured';
          const matches = await fsSearch(input.path ?? '.', input.pattern ?? '');
          const results = Array.isArray(matches) ? matches : String(matches).split('\n');
          return results.slice(0, 20).join('\n');
        }

        case 'grep': {
          if (!fsGrep) return 'ERROR: grep not configured';
          const lines = await fsGrep(input.pattern ?? '', input.path ?? '.');
          const result = Array.isArray(lines) ? lines : String(lines).split('\n');
          return result.slice(0, MAX_GREP_RESULTS).join('\n');
        }

        case 'run_command': {
          if (!runCmd) return 'ERROR: run_command not configured';
          const output = await runCmd(input.command ?? '');
          const str = String(output);
          return str.length > MAX_COMMAND_OUTPUT
            ? str.slice(0, MAX_COMMAND_OUTPUT) + `\n[...truncated at ${MAX_COMMAND_OUTPUT} chars]`
            : str;
        }

        case 'web_fetch': {
          if (!webFetch) return 'ERROR: web_fetch not configured';
          const raw = await webFetch(input.url ?? '');
          // Strip HTML tags and cap length
          const stripped = String(raw).replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
          return stripped.length > MAX_WEB_FETCH_CHARS
            ? stripped.slice(0, MAX_WEB_FETCH_CHARS) + `\n[...truncated at ${MAX_WEB_FETCH_CHARS} chars]`
            : stripped;
        }

        case 'web_search': {
          if (!webSearch) return 'ERROR: web_search not configured';
          const results = await webSearch(input.query ?? '');
          const limited = Array.isArray(results) ? results.slice(0, MAX_WEB_SEARCH_RESULTS) : [];
          return JSON.stringify(limited, null, 2);
        }

        case 'update_memory': {
          if (!updateMemory) return 'ERROR: update_memory not configured';
          await updateMemory(input.key ?? '', input.value ?? '');
          return `memory updated: ${input.key}`;
        }

        default:
          return `ERROR: unknown tool '${name}'`;
      }
    } catch (err) {
      return `ERROR: ${err.message}`;
    }
  }

  return executeTool;
}
