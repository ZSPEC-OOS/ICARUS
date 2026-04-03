export function enforceQualityFloor({ text = '', plan = null, minChars = 120, minPlanSteps = 2 }) {
  const issues = []
  const normalized = String(text || '').trim()

  if (normalized.length < minChars) issues.push('response_too_short')
  if (plan?.steps && plan.steps.length < minPlanSteps) issues.push('plan_too_shallow')

  return {
    passed: issues.length === 0,
    issues,
    summary: issues.length ? `Quality floor not met: ${issues.join(', ')}` : 'Quality floor passed.',
  }
}
