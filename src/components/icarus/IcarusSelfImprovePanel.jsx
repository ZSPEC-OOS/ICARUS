// ─── IcarusSelfImprovePanel ────────────────────────────────────────────────────
// Attach ONE local repository folder. The agent explores it each cycle, finds
// an enhancement, applies it, then starts over — indefinitely.
//
// Running view: activity feed (left) + enhancement log (right)

import { useState, useRef, useCallback, useEffect } from 'react'
import { pickDirectory, countFiles }                 from '../../services/localFileService'
import { runLocalSelfImproveLoop }                   from '../../services/localSelfImproveService'

const FEED_MAX = 100

function ts() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function IcarusSelfImprovePanel({ modelConfig }) {
  // ── Folder ──────────────────────────────────────────────────────────────────
  const [handle,    setHandle]    = useState(null)
  const [repoName,  setRepoName]  = useState('')
  const [fileCount, setFileCount] = useState(null)
  const [counting,  setCounting]  = useState(false)
  const [pickErr,   setPickErr]   = useState(null)

  // ── Cycle state ─────────────────────────────────────────────────────────────
  const [running,    setRunning]   = useState(false)
  const [paused,     setPaused]    = useState(false)
  const [pauseNext,  setPauseNext] = useState(false)
  const [cycleCount, setCycleCount]= useState(0)
  const [cycleMsg,   setCycleMsg]  = useState('')

  // ── Feeds ───────────────────────────────────────────────────────────────────
  const [feed,         setFeed]        = useState([])   // tool activity
  const [enhancements, setEnhancements]= useState([])   // one entry per cycle

  const abortRef = useRef(null)
  const pauseRef = useRef(false)
  const feedRef  = useRef(null)

  // Auto-scroll feed to bottom
  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight
  }, [feed])

  // ── Folder picker ────────────────────────────────────────────────────────────

  const pickFolder = useCallback(async () => {
    setPickErr(null)
    try {
      const h = await pickDirectory()
      setHandle(h)
      setRepoName(h.name)
      setFileCount(null)
      setCounting(true)
      const n = await countFiles(h)
      setFileCount(n)
      setCounting(false)
    } catch (e) {
      if (e.name !== 'AbortError') setPickErr(e.message)
      setCounting(false)
    }
  }, [])

  const detachFolder = useCallback(() => {
    setHandle(null); setRepoName(''); setFileCount(null); setPickErr(null)
  }, [])

  // ── Feed helpers ─────────────────────────────────────────────────────────────

  function addFeed(text, kind = 'info') {
    setFeed(f => [...f, { id: Date.now() + Math.random(), text, kind, time: ts() }].slice(-FEED_MAX))
  }

  function addEnhancement(cycle, description, files = []) {
    setEnhancements(e => [...e, { id: Date.now() + Math.random(), cycle, description, files, time: ts() }])
  }

  // ── Start / pause / stop ─────────────────────────────────────────────────────

  const handleBegin = useCallback(() => {
    if (!handle) return
    if (!modelConfig?.apiKey) {
      setPickErr('No API key — open Settings and add your Anthropic key.')
      return
    }

    setFeed([])
    setEnhancements([])
    setCycleCount(0)
    setCycleMsg('')
    pauseRef.current = false
    setPauseNext(false)
    setRunning(true)
    setPaused(false)

    const ctrl = new AbortController()
    abortRef.current = ctrl

    runLocalSelfImproveLoop(
      { handle, name: repoName, modelConfig, maxCycles: 200, signal: ctrl.signal },
      {
        onStep: ({ cycle, msg }) => {
          setCycleCount(cycle)
          setCycleMsg(msg)
        },

        onEvent: e => {
          if (e.type === 'tool_start') {
            const path = e.tool_input?.path ? ` · ${e.tool_input.path}` : ''
            addFeed(`⚙ ${e.tool_name}${path}`, 'tool')
          } else if (e.type === 'tool_done') {
            const path = e.tool_input?.path ? ` · ${e.tool_input.path}` : ''
            addFeed(`✓ ${e.tool_name}${path}`, 'done')
          } else if (e.type === 'error') {
            addFeed(`✗ ${e.text}`, 'error')
          }
        },

        onLog: ({ cycle, description, files }) => {
          addEnhancement(cycle, description, files)
          addFeed(`✦ ${description}`, 'enhancement')
        },

        onCycleEnd: n => {
          addFeed(`━━ Cycle ${n} complete ━━`, 'cycle')
          if (pauseRef.current) setPaused(true)
        },

        onAbortCheck: () => pauseRef.current || ctrl.signal.aborted,
      },
    ).then(() => {
      if (!ctrl.signal.aborted) { setRunning(false); setPaused(false) }
    }).catch(e => {
      if (!ctrl.signal.aborted) {
        setRunning(false); setPaused(false)
        addFeed(`Loop error: ${e.message}`, 'error')
      }
    })
  }, [handle, repoName, modelConfig])

  const handlePause = useCallback(() => {
    pauseRef.current = true
    setPauseNext(true)
    addFeed('⏸ Pause requested — finishing this cycle…', 'info')
  }, [])

  const handleStop = useCallback(() => {
    abortRef.current?.abort()
    setRunning(false); setPaused(false); setPauseNext(false)
    addFeed('⏹ Stopped', 'info')
  }, [])

  const handleResume = useCallback(() => {
    pauseRef.current = false; setPauseNext(false); setPaused(false); setRunning(true)
    handleBegin()
  }, [handleBegin])

  // ── Render: idle / ready ──────────────────────────────────────────────────────

  if (!running && !paused) {
    return (
      <div className="lk-si-page">
        <div className="lk-si-header">
          <span className="lk-si-header-title">Self-Improve</span>
          <span className="lk-si-header-desc">
            Attach a local repository clone. The agent will explore it, apply enhancements, and repeat.
          </span>
        </div>

        <div className="lk-si-setup">
          {handle ? (
            <div className="lk-si-folder-card lk-si-folder-card--attached">
              <div className="lk-si-folder-icon">📁</div>
              <div className="lk-si-folder-name">{repoName}</div>
              <div className="lk-si-folder-count">
                {counting ? 'counting…' : fileCount != null ? `${fileCount} files` : ''}
              </div>
              <div className="lk-si-folder-actions">
                <button className="lk-btn lk-btn--small" onClick={pickFolder}>Change</button>
                <button className="lk-btn lk-btn--small lk-btn--danger" onClick={detachFolder}>Detach</button>
              </div>
              {pickErr && <div className="lk-si-folder-err">{pickErr}</div>}
              <button className="lk-btn lk-si-begin-btn" onClick={handleBegin}>
                Begin Self-Improvement
              </button>
            </div>
          ) : (
            <div className="lk-si-folder-card">
              <div className="lk-si-folder-icon lk-si-folder-icon--empty">📂</div>
              <div className="lk-si-folder-label">Choose a local repo</div>
              <div className="lk-si-folder-hint">
                Select any local clone on your computer. The agent will read and write files directly.
              </div>
              {pickErr && <div className="lk-si-folder-err">{pickErr}</div>}
              <button className="lk-btn lk-si-pick-btn" onClick={pickFolder}>
                Choose Folder…
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── Render: running / paused ──────────────────────────────────────────────────

  return (
    <div className="lk-si-page lk-si-page--running">

      {/* Top bar */}
      <div className="lk-si-top-bar">
        <div className="lk-si-top-left">
          <span className={`lk-si-dot lk-si-dot--${paused ? 'paused' : 'running'}`} />
          <span className="lk-si-top-status">{paused ? 'Paused' : 'Running'}</span>
          <span className="lk-si-top-cycle">Cycle {cycleCount}</span>
          <span className="lk-si-top-repo">{repoName}</span>
        </div>
        <div className="lk-si-top-msg">{cycleMsg}</div>
        <div className="lk-si-top-actions">
          {paused ? (
            <>
              <button className="lk-btn lk-btn--small" onClick={handleResume}>▶ Resume</button>
              <button className="lk-btn lk-btn--small lk-btn--danger" onClick={handleStop}>⏹ Stop</button>
            </>
          ) : (
            <>
              <button className="lk-btn lk-btn--small" onClick={handlePause} disabled={pauseNext}>
                {pauseNext ? '⏸ Pausing…' : '⏸ Pause'}
              </button>
              <button className="lk-btn lk-btn--small lk-btn--danger" onClick={handleStop}>⏹ Stop</button>
            </>
          )}
        </div>
      </div>

      {/* 2-column split */}
      <div className="lk-si-split">

        {/* Activity feed */}
        <div className="lk-si-pane">
          <div className="lk-si-pane-hd">
            <span className="lk-si-pane-label">Activity</span>
          </div>
          <div className="lk-si-feed" ref={feedRef}>
            {feed.length === 0
              ? <div className="lk-si-feed-empty">Starting…</div>
              : feed.map(item => (
                  <div key={item.id} className={`lk-si-fi lk-si-fi--${item.kind}`}>
                    <span className="lk-si-fi-time">{item.time}</span>
                    <span className="lk-si-fi-text">{item.text}</span>
                  </div>
                ))
            }
          </div>
        </div>

        {/* Enhancement log */}
        <div className="lk-si-pane lk-si-pane--log">
          <div className="lk-si-pane-hd">
            <span className="lk-si-pane-label">Enhancements</span>
            <span className="lk-si-pane-count">{enhancements.length}</span>
          </div>
          <div className="lk-si-log">
            {enhancements.length === 0 ? (
              <div className="lk-si-feed-empty">First enhancement will appear here…</div>
            ) : (
              [...enhancements].reverse().map(e => (
                <div key={e.id} className="lk-si-log-entry">
                  <div className="lk-si-log-meta">
                    <span className="lk-si-log-cycle">#{e.cycle}</span>
                    <span className="lk-si-log-time">{e.time}</span>
                  </div>
                  <div className="lk-si-log-desc">{e.description}</div>
                  {e.files?.length > 0 && (
                    <div className="lk-si-log-files">
                      {e.files.map(f => <span key={f} className="lk-si-log-file">{f}</span>)}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

      </div>
    </div>
  )
}
