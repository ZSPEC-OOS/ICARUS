// ─── ICARUS Modular Tool Template ─────────────────────────────────────────────
// Copy this file and fill in the blanks to create a new tool.
// All three exports (toolMeta, execute, test) are required.

// ── Tool Metadata (Required) ──────────────────────────────────────────────────
export const toolMeta = {
  id: 'unique-tool-name',       // kebab-case, used as filename key
  name: 'Display Name',         // shown in the tool list
  version: '1.0.0',             // semver
  description: 'What this tool does in one sentence.',
  category: 'utility',          // 'coding' | 'utility' | 'analysis'
  author: 'Your Name',
}

// ── Main Function (Required) ──────────────────────────────────────────────────
// input  — plain object with tool-specific parameters
// config — optional runtime config (e.g. { execBridge, githubToken })
export async function execute(input, config = {}) {
  // Validate inputs
  if (!input || typeof input !== 'object') {
    throw new Error('Input must be an object')
  }

  // TODO: implement tool logic here
  const result = { message: 'Tool executed successfully', input }

  return result
}

// ── Self-test Function (Required) ─────────────────────────────────────────────
// Must return { passed: boolean, message: string }
export async function test() {
  try {
    const result = await execute({ example: 'test-value' })
    if (result && result.message) {
      return { passed: true, message: 'Self-test passed.' }
    }
    return { passed: false, message: 'Unexpected result shape.' }
  } catch (err) {
    return { passed: false, message: `Error: ${err.message}` }
  }
}
