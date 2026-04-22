// ─── tools/index.js — Built-in tool registry ──────────────────────────────────
// All tools shipped with BLUSWAN. Each export must conform to the toolMeta /
// execute / test contract defined in tool-template.js.
import * as contracts from './contracts.js'

export * as readFile          from './read-file.js'
export * as writeFile         from './write-file.js'
export * as editFile          from './edit-file.js'
export * as deleteFile        from './delete-file.js'
export * as listDirectory     from './list-directory.js'
export * as searchFiles       from './search-files.js'
export * as readManyFiles     from './read-many-files.js'
export * as revertFile        from './revert-file.js'
export * as readSourceFile    from './read-source-file.js'
export * as listSourceDir     from './list-source-directory.js'
export * as glob              from './glob.js'
export * as grep              from './grep.js'
export * as lintFile          from './lint-file.js'
export * as analyzeCodebase   from './analyze-codebase.js'
export * as discoverSkills    from './discover-skills.js'
export * as createPR          from './create-pull-request.js'
export * as runCommand        from './run-command.js'
export * as webFetch          from './web-fetch.js'
export * as webSearch         from './web-search.js'
export * as updateMemory      from './update-memory.js'
export * as todo              from './todo.js'

export * as analyzeStacktrace from './analyze-stacktrace.js'
export * as findTechDebt     from './find-tech-debt.js'
export * as checkUrlHealth   from './check-url-health.js'
export * as jsonRepair       from './json-repair.js'

export * as hybridSearch     from './hybrid-search.js'
export * as retrieveContext  from './retrieve-context.js'
export * as tokenIoOptimizer from './token-io-optimizer.js'

export const TOOL_SCHEMA_VERSION = contracts.schemaVersion()

export function withToolContractValidation(toolName, execute) {
  return async (input, config = {}) => {
    const inputValidation = contracts.validateToolInput(toolName, input)
    if (!inputValidation.ok) {
      throw new Error(`Invalid input for ${toolName}: ${inputValidation.errors.join('; ')}`)
    }
    const output = await execute(input, config)
    const outputValidation = contracts.validateToolOutput(toolName, output)
    if (!outputValidation.ok) {
      throw new Error(`Invalid output for ${toolName}: ${outputValidation.errors.join('; ')}`)
    }
    return output
  }
}

export const tools = []

export default tools
