// ─── useConversation ──────────────────────────────────────────────────────────
// Manages multi-turn conversation state with localStorage persistence.
// Survives page reloads up to CONV_MAX_MESSAGES messages (10 turns).
// Layer 1 (Conversation Intelligence): exposes compressMemory() which reduces
// prior turns into a MemoryBlock digest for system prompt injection.

import { useState, useEffect, useCallback, useMemo } from 'react'
import { CONV_MAX_MESSAGES } from '../../config/constants.js'
import { compressToMemoryBlock, buildMemoryDigest } from '../../services/interactivePipeline.js'
import {
  getCurrentUser,
  loadUserConversation,
  saveUserConversation,
} from '../../services/firebaseService.js'

const CONV_KEY = 'logik:conv'

function loadConversation() {
  try { return JSON.parse(localStorage.getItem(CONV_KEY)) || [] } catch { return [] }
}

function persistConversation(messages) {
  try { localStorage.setItem(CONV_KEY, JSON.stringify(messages.slice(-CONV_MAX_MESSAGES))) } catch {}
}

export function useConversation() {
  const [conversation, setConversation] = useState(loadConversation)
  const [turnCount,    setTurnCount]    = useState(0)
  const [hydratedCloud, setHydratedCloud] = useState(false)

  // Load cloud chat history at session start if a user is signed in and local is empty.
  useEffect(() => {
    if (hydratedCloud) return
    let cancelled = false
    ;(async () => {
      const user = getCurrentUser()
      if (!user?.uid) { if (!cancelled) setHydratedCloud(true); return }
      if (conversation.length > 0) { if (!cancelled) setHydratedCloud(true); return }
      const remote = await loadUserConversation(user.uid)
      if (!cancelled && remote.length > 0) {
        setConversation(remote.slice(-CONV_MAX_MESSAGES))
      }
      if (!cancelled) setHydratedCloud(true)
    })()
    return () => { cancelled = true }
  }, [hydratedCloud, conversation.length])

  // Debounce saves: only write to localStorage 500ms after the last update.
  useEffect(() => {
    const timer = setTimeout(() => persistConversation(conversation), 500)
    return () => clearTimeout(timer)
  }, [conversation])

  // Persist to Firebase immediately once the session is hydrated.
  useEffect(() => {
    if (!hydratedCloud) return
    const user = getCurrentUser()
    if (!user?.uid) return
    saveUserConversation(user.uid, conversation.slice(-CONV_MAX_MESSAGES))
  }, [conversation, hydratedCloud])

  const addTurn = useCallback((userMsg, assistantMsg) => {
    setConversation(prev => [...prev, { role: 'user', content: userMsg }, { role: 'assistant', content: assistantMsg }])
    setTurnCount(t => t + 1)
  }, [])

  const reset = useCallback(() => {
    setConversation([])
    setTurnCount(0)
    try { localStorage.removeItem(CONV_KEY) } catch {}
  }, [])

  // Layer 1: MemoryBlock — compressed digest of prior turns for context injection.
  // Re-computed only when conversation changes; cheap because it only processes
  // the assistant messages already in memory.
  const memoryBlock = useMemo(
    () => conversation.length >= 4 ? compressToMemoryBlock(conversation) : null,
    [conversation],
  )

  /** Returns a compact string digest of prior turns for system prompt injection. */
  const getMemoryDigest = useCallback(
    () => memoryBlock ? buildMemoryDigest(memoryBlock) : '',
    [memoryBlock],
  )

  return { conversation, setConversation, turnCount, setTurnCount, addTurn, reset, memoryBlock, getMemoryDigest }
}
