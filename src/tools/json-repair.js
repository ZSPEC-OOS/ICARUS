// ─── json-repair tool ────────────────────────────────────────────────────────
export const toolMeta = {
  id: 'json-repair',
  name: 'JSON Repair',
  version: '1.0.0',
  description: 'Attempt lightweight repair of malformed JSON (single quotes, trailing commas) and validate output.',
  category: 'coding',
  author: 'ICARUS',
}

function attemptRepair(raw) {
  let next = String(raw)
    .replace(/\r\n/g, '\n')
    .replace(/,\s*([}\]])/g, '$1')

  // Replace single-quoted keys/values with double-quoted forms (best-effort).
  next = next
    .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'\s*:/g, '"$1":')
    .replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, ': "$1"')

  return next
}

export async function execute(input = {}) {
  const { text } = input
  if (typeof text !== 'string' || !text.trim()) throw new Error('text is required')

  try {
    const parsed = JSON.parse(text)
    return { repaired: false, valid: true, json: JSON.stringify(parsed, null, 2) }
  } catch {
    const candidate = attemptRepair(text)
    try {
      const parsed = JSON.parse(candidate)
      return { repaired: true, valid: true, json: JSON.stringify(parsed, null, 2) }
    } catch (e) {
      return { repaired: true, valid: false, error: e.message, json: candidate }
    }
  }
}

export async function test() {
  const failures = []

  const valid = await execute({ text: '{"a":1}' })
  if (!valid.valid || valid.repaired) failures.push('Trial 1: valid JSON should pass without repair')

  const fixed = await execute({ text: "{'a': 'x', 'b': 2,}" })
  if (!fixed.valid || !fixed.repaired) failures.push('Trial 2: malformed JSON should be repaired')

  const bad = await execute({ text: '{ nope }' })
  if (bad.valid) failures.push('Trial 3: irreparable JSON should stay invalid')

  try {
    await execute({})
    failures.push('Trial 4: missing text should throw')
  } catch (e) {
    if (!e.message.includes('text')) failures.push(`Trial 4: wrong error ${e.message}`)
  }

  if (failures.length) return { passed: false, message: failures.join(' | ') }
  return { passed: true, message: 'All 4 trials passed (valid passthrough, repair flow, invalid flow, input guard).' }
}
