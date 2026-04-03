// ─── useIcarusOnboarding — non-coder setup wizard hook ─────────────────────────
//
// Drives the step-by-step onboarding experience for users with no coding
// background. Persists progress in localStorage so they can close and return.
//
// Usage in Icarus.jsx (or a wrapper component):
//
//   import { useIcarusOnboarding } from '../core/hooks/useIcarusOnboarding'
//
//   const {
//     showOnboarding,      // boolean — whether to render the onboarding panel
//     currentStep,         // { id, title, detail, action, link, manual }
//     stepIndex,           // 0-based index into ONBOARDING_STEPS
//     totalSteps,          // ONBOARDING_STEPS.length
//     isComplete,          // all required steps done
//     markManualDone,      // (stepId) => void — user clicked "Done" on a manual step
//     dismissOnboarding,   // () => void — user closes the panel permanently
//     reopenOnboarding,    // () => void — user reopens it from the ? button
//     progressPercent,     // 0–100 number for the progress bar
//     tips,                // contextual SIMPLE_TIPS relevant right now
//     addTip,              // (triggerId) => void — surface a tip for a trigger
//     dismissTip,          // (tipId) => void
//     activeTips,          // currently visible tips
//   } = useIcarusOnboarding(settings)
//
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  ONBOARDING_STEPS,
  SIMPLE_TIPS,
  getIncompleteSteps,
  isOnboardingComplete,
  isSimpleMode,
} from '../../services/icarusSimpleMode.js'

const ONBOARDING_KEY  = 'icarus:onboarding'       // localStorage — persisted state
const MANUAL_DONE_KEY = 'icarus:onboarding:manual' // which manual steps user confirmed

// ── State helpers ─────────────────────────────────────────────────────────────

function loadOnboardingState() {
  try {
    return JSON.parse(localStorage.getItem(ONBOARDING_KEY)) || {}
  } catch { return {} }
}

function saveOnboardingState(state) {
  try { localStorage.setItem(ONBOARDING_KEY, JSON.stringify(state)) } catch {}
}

function loadManualDone() {
  try { return JSON.parse(localStorage.getItem(MANUAL_DONE_KEY)) || [] } catch { return [] }
}

function saveManualDone(ids) {
  try { localStorage.setItem(MANUAL_DONE_KEY, JSON.stringify(ids)) } catch {}
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useIcarusOnboarding(settings = {}) {

  // Onboarding panel visibility
  const [dismissed, setDismissed] = useState(() => {
    const s = loadOnboardingState()
    return !!s.dismissed
  })

  // Which manual steps the user has clicked "Done" for
  const [manualDone, setManualDone] = useState(() => loadManualDone())

  // Active contextual tips
  const [activeTips, setActiveTips] = useState([])

  // ── Derived settings that are re-evaluated when settings prop changes ────────
  // We inject manualDone into the settings check so manual steps can be ticked.
  const augmentedSettings = useMemo(() => ({
    ...settings,
    _manualDone: manualDone,
  }), [settings, manualDone])

  // Build check function that also honours manual-done list
  const isStepDone = useCallback((step) => {
    if (step.manual) return manualDone.includes(step.id)
    return step.check(augmentedSettings)
  }, [augmentedSettings, manualDone])

  // Compute incomplete steps
  const incompleteSteps = useMemo(
    () => ONBOARDING_STEPS.filter(s => !isStepDone(s)),
    [isStepDone]
  )

  const isComplete     = incompleteSteps.length === 0
  const currentStep    = incompleteSteps[0] ?? null
  const stepIndex      = currentStep
    ? ONBOARDING_STEPS.findIndex(s => s.id === currentStep.id)
    : ONBOARDING_STEPS.length
  const totalSteps     = ONBOARDING_STEPS.length
  const progressPercent = Math.round(
    ((totalSteps - incompleteSteps.length) / totalSteps) * 100
  )

  // Show onboarding panel when:
  //   - simple mode is on (which is the DEFAULT for all new users)  AND
  //   - the user has not explicitly dismissed it  AND
  //   - there are still steps to complete
  // A new user will see this automatically — no toggle required.
  const showOnboarding = isSimpleMode() && !dismissed && !isComplete

  // ── Actions ──────────────────────────────────────────────────────────────────

  const markManualDone = useCallback((stepId) => {
    setManualDone(prev => {
      if (prev.includes(stepId)) return prev
      const next = [...prev, stepId]
      saveManualDone(next)
      return next
    })
  }, [])

  const dismissOnboarding = useCallback(() => {
    setDismissed(true)
    saveOnboardingState({ dismissed: true })
  }, [])

  const reopenOnboarding = useCallback(() => {
    setDismissed(false)
    saveOnboardingState({ dismissed: false })
  }, [])

  // ── Contextual tips ───────────────────────────────────────────────────────────

  const addTip = useCallback((triggerId) => {
    if (!isSimpleMode()) return
    const tip = SIMPLE_TIPS.find(t => t.trigger === triggerId)
    if (!tip) return
    setActiveTips(prev => {
      if (prev.some(t => t.id === tip.id)) return prev
      return [...prev, { ...tip, _ts: Date.now() }]
    })
  }, [])

  const dismissTip = useCallback((tipId) => {
    setActiveTips(prev => prev.filter(t => t.id !== tipId))
  }, [])

  // Auto-surface setup tips when key steps are missing
  useEffect(() => {
    if (!isSimpleMode()) return
    const hasApiKey  = settings?.models?.some(m => m.apiKey)
    const hasGitHub  = !!(settings?.githubToken)
    if (!hasApiKey)  addTip('no-api-key')
    if (!hasGitHub)  addTip('no-github')
  }, [settings, addTip])

  // Auto-dismiss setup tips once the condition clears
  useEffect(() => {
    const hasApiKey = settings?.models?.some(m => m.apiKey)
    const hasGitHub = !!(settings?.githubToken)
    if (hasApiKey)   dismissTip('tip-api-key')
    if (hasGitHub)   dismissTip('tip-github-key')
  }, [settings]) // intentionally omit dismissTip from deps — stable callback

  return {
    showOnboarding,
    currentStep,
    stepIndex,
    totalSteps,
    isComplete,
    markManualDone,
    dismissOnboarding,
    reopenOnboarding,
    progressPercent,
    incompleteSteps,
    tips: SIMPLE_TIPS,
    addTip,
    dismissTip,
    activeTips,
  }
}

export default useIcarusOnboarding
