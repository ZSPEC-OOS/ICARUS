function extractAttributes(text = '') {
  const lower = String(text).toLowerCase()
  return {
    colorTheme: /(neon|pastel|monochrome|minimal|dark|light|duotone)/.exec(lower)?.[1] || 'adaptive',
    layout: /(grid|cards?|timeline|split|single[- ]column|dashboard|sidebar)/.exec(lower)?.[1] || 'fluid',
    metaphor: /(garden|journey|studio|canvas|constellation|orchestra|marketplace|lab)/.exec(lower)?.[1] || 'story',
    interactionModel: /(drag|scroll|tap|gesture|voice|chat|swipe|hover)/.exec(lower)?.[1] || 'click',
  }
}

export function remixCandidates(candidateA, candidateB) {
  const attrsA = extractAttributes(candidateA?.content || '')
  const attrsB = extractAttributes(candidateB?.content || '')
  const hybridAttributes = {
    colorTheme: Math.random() > 0.5 ? attrsA.colorTheme : attrsB.colorTheme,
    layout: Math.random() > 0.5 ? attrsA.layout : attrsB.layout,
    metaphor: Math.random() > 0.5 ? attrsA.metaphor : attrsB.metaphor,
    interactionModel: Math.random() > 0.5 ? attrsA.interactionModel : attrsB.interactionModel,
  }

  const recombinedOutput = [
    `Color/theme: ${hybridAttributes.colorTheme}`,
    `Layout: ${hybridAttributes.layout}`,
    `Metaphor: ${hybridAttributes.metaphor}`,
    `Interaction model: ${hybridAttributes.interactionModel}`,
    '',
    'Hybrid concept:',
    `${candidateA?.content || ''}`,
    '',
    'Cross-pollinated with:',
    `${candidateB?.content || ''}`,
  ].join('\n')

  return {
    baseA: candidateA?.id || null,
    baseB: candidateB?.id || null,
    hybrid_attributes: hybridAttributes,
    recombined_output: recombinedOutput,
    origin: 'remix',
  }
}

export function buildRemixSet(candidates = [], { count = 4, strategy = 'random' } = {}) {
  const pool = Array.isArray(candidates) ? candidates.filter(Boolean) : []
  if (pool.length < 2) return []
  const out = []

  const pickPair = () => {
    if (strategy === 'similarity_weighted') {
      const ordered = [...pool].sort((a, b) => (b.content?.length || 0) - (a.content?.length || 0))
      const anchor = ordered[0]
      const mate = ordered[Math.max(1, Math.floor(Math.random() * ordered.length))]
      return [anchor, mate]
    }
    const a = pool[Math.floor(Math.random() * pool.length)]
    let b = pool[Math.floor(Math.random() * pool.length)]
    let guard = 0
    while (a?.id === b?.id && guard < 10) {
      b = pool[Math.floor(Math.random() * pool.length)]
      guard += 1
    }
    return [a, b]
  }

  const target = Math.max(3, Math.min(5, count))
  for (let i = 0; i < target; i++) {
    const [a, b] = pickPair()
    const hybrid = remixCandidates(a, b)
    out.push({
      id: `remix-${Date.now()}-${i + 1}`,
      content: hybrid.recombined_output,
      metadata: { ...hybrid.hybrid_attributes, pairing: strategy },
      origin: 'remix',
      iteration: Math.max(a?.iteration || 0, b?.iteration || 0),
      remix: hybrid,
    })
  }

  return out
}
