// ─── Diff utility ─────────────────────────────────────────────────────────────
// Wraps the `diff` npm package (Myers algorithm, linear space, no line cap).
// Replaces the previous hand-rolled LCS approach that was capped at 600 lines.

import { createPatch } from 'diff'

// Returns a unified-diff string for display in the Diff tab.
// oldText = null means the file is being created (all lines shown as additions).
export function computeLineDiff(oldText, newText, filePath) {
  if (!newText) return ''
  return createPatch(
    filePath,
    oldText ?? '',
    newText,
    '',
    '',
    { context: 3 },
  )
}
