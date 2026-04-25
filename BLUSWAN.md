

## Agent Note (2026-04-25)

[BUG IDENTIFIED] semantic_edit_distance gate fails when no file mutations occur. Root cause in gateEvaluators.js:64 - avgSimilarity defaults to 1 when no edits, but max threshold is 0.98, causing 1 <= 0.98 to fail. This triggers unnecessary rollbacks for read-only tasks.
