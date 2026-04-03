// ─── useActivityLog ───────────────────────────────────────────────────────────
// Manages the live activity feed (a Claude Code-style operation log).
// Uses a ref mirror so async callbacks always see the latest entries.

import { useState, useRef, useCallback } from 'react'

export function useActivityLog(feedRef) {
  const [activityLog, setActivityLog] = useState([])
  const activityRef = useRef([])

  // Add a new entry; returns its id so callers can later update it.
  const logActivity = useCallback((type, msg, detail = null) => {
    const id    = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const entry = { id, type, msg, detail, status: type === 'done' ? 'done' : 'active' }
    activityRef.current = [...activityRef.current, entry]
    setActivityLog([...activityRef.current])
    // Auto-scroll feed to bottom
    requestAnimationFrame(() => {
      if (feedRef?.current) feedRef.current.scrollTop = feedRef.current.scrollHeight
    })
    return id
  }, [feedRef])

  // Patch an existing entry by id.
  const updateActivity = useCallback((id, updates) => {
    activityRef.current = activityRef.current.map(e => e.id === id ? { ...e, ...updates } : e)
    setActivityLog([...activityRef.current])
  }, [])

  // Wipe all entries (call at the start of a new run).
  const clearActivity = useCallback(() => {
    activityRef.current = []
    setActivityLog([])
  }, [])

  return { activityLog, activityRef, logActivity, updateActivity, clearActivity }
}
