function normalizedLines(text = '') {
  return String(text)
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean)
}

function makeLineSet(text) {
  return new Set(normalizedLines(text))
}

/**
 * Incremental context packing with deduplication.
 * Returns compact text and per-section diff stats.
 */
export function packContextSections(sections = [], previousPacked = '') {
  const seen = makeLineSet(previousPacked)
  const packedSections = []
  const stats = []

  for (const section of sections) {
    const heading = section?.heading || 'CONTEXT'
    const lines = normalizedLines(section?.content || '')
    const fresh = []
    let duplicateLines = 0

    for (const line of lines) {
      if (seen.has(line)) {
        duplicateLines += 1
        continue
      }
      seen.add(line)
      fresh.push(line)
    }

    if (!fresh.length) continue

    packedSections.push(`[${heading}]\n${fresh.join('\n')}`)
    stats.push({
      heading,
      inputLines: lines.length,
      emittedLines: fresh.length,
      duplicateLines,
      reductionRatio: lines.length ? duplicateLines / lines.length : 0,
    })
  }

  return {
    text: packedSections.join('\n\n').trim(),
    stats,
    emittedSections: packedSections.length,
  }
}
