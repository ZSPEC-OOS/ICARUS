const OPERATORS = ['rule_break', 'hidden_detail', 'medium_shift']

function pickOperator(candidate = {}) {
  const hint = String(candidate?.content || '').toLowerCase()
  if (hint.includes('grid') || hint.includes('layout')) return 'rule_break'
  if (hint.includes('story') || hint.includes('metaphor')) return 'hidden_detail'
  return OPERATORS[Math.floor(Math.random() * OPERATORS.length)]
}

export function applyTranscend(candidate) {
  const operator = pickOperator(candidate)
  const base = String(candidate?.content || '')
  let transformed = base

  if (operator === 'rule_break') {
    transformed = `${base}\n\nTranscend move: invert the primary hierarchy and intentionally break one default layout assumption to produce surprise.`
  } else if (operator === 'hidden_detail') {
    transformed = `${base}\n\nTranscend move: embed a subtle easter egg micro-interaction that reveals a secondary meaning layer on repeat use.`
  } else {
    transformed = `${base}\n\nTranscend move: shift this concept into a motion/spatial narrative with optional audio cues for emotional pacing.`
  }

  return {
    transformed_output: transformed,
    operator_used: operator,
    origin: 'transcend',
  }
}
