// ─── tools/index.js — Built-in tool registry ──────────────────────────────────
// All tools shipped with LOGIK. Each export must conform to the toolMeta /
// execute / test contract defined in tool-template.js.

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
export * as grep              from './grep.js'
export * as lintFile          from './lint-file.js'
export * as analyzeCodebase   from './analyze-codebase.js'
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
