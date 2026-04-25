// ─── WorkspaceShell ───────────────────────────────────────────────────────────
// Main layout component for the BLUSWAN workspace.
// Consumes useWorkspaceState() for all state and handlers;
// delegates the bottom input card to <PromptBar />.

import Aurora             from '../Aurora'
import PromptBar          from './PromptBar'
import BluswanActivityFeed  from '../bluswan/BluswanActivityFeed'
import BluswanSettings      from '../bluswan/BluswanSettings'
import BluswanModularTools  from '../bluswan/BluswanModularTools'
import { useWorkspaceState } from './useWorkspaceState'
import { shadowContext } from '../../services/shadowContext'
import '../Bluswan.css'

export default function WorkspaceShell(props) {
  const ws = useWorkspaceState(props)

  const {
    // layout
    ftFilter, headerLayout,
    // config
    githubToken, repoOwner, repoName, baseBranch, lastBranchName,
    setRepoOwner, setRepoName, setBaseBranch, setGithubToken,
    githubClientId, setGithubClientId,
    activeModelId, setActiveModelId, onModelChange,
    models, setModels, onLogout, userEmail, savedModelIds, onModelSaved,
    dryRun, setDryRun, hasGithub,
    // ui flags
    mobileDrawerOpen, setMobileDrawerOpen,
    settingsOpen, setSettingsOpen,
    historyOpen, setHistoryOpen,
    shadowStatus, isModulesPage, activeTab, setActiveTab,
    conversation, turnCount, filePath,
    // settings panel props
    generateTests, setGenerateTests, creativity, setCreativity,
    enableThinking, setEnableThinking, thinkingBudget, setThinkingBudget,
    hooksConfig, setHooksConfig, webSearchApiKey, setWebSearchApiKey,
    permissionMode, setPermissionMode,
    bluswanMdDraft, setBluswanMdDraft, isSavingBluswanMd,
    // history
    history, setHistory,
    // activity feed
    activityLog, activityFeedRef, agentSession,
    isGenerating, isChatGenerating, isPushing, pushStep,
    isAmplifying, amplifierDecisions, isPlanning,
    remediationStatus, executedPlan, planApproval,
    setPlanApproval, setExecutedPlan,
    filePlan, lrmPlan, lrmGeneratingPlan,
    routeOverride, setRouteOverride, routeClassification,
    taskSidebarCollapsed, setTaskSidebarCollapsed,
    // repo picker
    repoPickerOpen, repoPickerRef, openRepoPicker, repoPickerSearch,
    setRepoPickerSearch, repoPickerLoading, repoPickerError, userRepos,
    loadRepos, handlePickRepo,
    // handlers
    handleReset, handleReindex, handleSaveBluswanMd,
    handleLrmStart, handleLrmProceed, handleLrmOverride, handleLrmCancel, handleLrmSkip,
    saveHistory,
    // sandbox
    sandboxRef,
    // lrm
    setLrmPlan,
  } = ws

  return (
    <div
      className={`lk-root lk-theme-bluswan${conversation.length > 0 ? ' lk-root--chatting' : ''}`}
      style={{ filter: ftFilter }}
      onKeyDown={ws.handleKeyDown}
    >
      {/* Aurora background — hidden after first message */}
      {conversation.length === 0 && (
        <Aurora colorStops={['#071630', '#3b8ef0', '#112252']} amplitude={1.0} blend={0.5} speed={1.0} />
      )}

      {/* Invisible sandbox iframe */}
      <iframe ref={sandboxRef} className="lk-sandbox-iframe" sandbox="allow-scripts allow-same-origin" title="BLUSWAN sandbox" aria-hidden="true" />

      {/* ── Left sidebar ──────────────────────────────────────────────────── */}
      <nav className={`lk-sidebar${mobileDrawerOpen ? ' lk-sidebar--open' : ''}`}>
        <button className="lk-sidebar-btn lk-sidebar-btn--back" onClick={ws.onClose} title="Back">←</button>
        <div className="lk-sidebar-sep" />
        <button className={`lk-sidebar-btn${historyOpen ? ' lk-sidebar-btn--on' : ''}`}
          onClick={() => { ws.setHistoryOpen(v => !v); ws.setSettingsOpen(false) }} title="History">⧖</button>
        <button className={`lk-sidebar-btn${settingsOpen ? ' lk-sidebar-btn--on' : ''}`}
          onClick={() => { ws.setSettingsOpen(v => !v); ws.setHistoryOpen(false); setBluswanMdDraft(shadowContext.bluswanMd || '') }}
          title="Settings">⚙</button>
        <button className="lk-sidebar-btn" onClick={handleReset} title="New Chat">＋</button>
        <div className="lk-sidebar-spacer" />
        {shadowStatus && (
          <div className={`lk-sidebar-shadow${shadowContext.isIndexing ? ' lk-sidebar-shadow--pulse' : ' lk-sidebar-shadow--ready'}`}
            title={shadowStatus} />
        )}

        {/* Mobile drawer nav */}
        <div className="lk-sidebar-mobile-nav">
          <div className="lk-sidebar-nav-brand">
            <img src="/BLUSWAN-logo-transparent.png" alt="BLUSWAN" className="lk-bluswan-logo lk-bluswan-logo--drawer" />
            <button className="lk-sidebar-btn lk-sidebar-btn--new"
              onClick={() => { handleReset(); setMobileDrawerOpen(false) }} title="New session">＋</button>
          </div>
          <div className="lk-sidebar-nav-sep" />
          <div className="lk-sidebar-nav-section-hd">
            <span>Task History</span>
            {history.length > 0 && (
              <button className="lk-sidebar-nav-section-clear"
                onClick={() => { ws.setHistory([]); ws.saveHistory?.([]) }}>Clear</button>
            )}
          </div>
          {history.length === 0
            ? <span className="lk-sidebar-nav-empty">No tasks yet.</span>
            : <div className="lk-sidebar-nav-history">
                {history.slice(0, 20).map(e => (
                  <button key={e.id} className="lk-sidebar-nav-history-item"
                    onClick={() => {
                      if (Array.isArray(e.conversation) && e.conversation.length > 0) {
                        ws.setConversation(e.conversation)
                        ws.setTurnCount(e.conversation.filter(m => m.role === 'user').length)
                        ws.setHistoryOpen(false)
                        setMobileDrawerOpen(false)
                        return
                      }
                      ws.setPrompt(e.prompt); setMobileDrawerOpen(false)
                    }}>
                    <div className="lk-sidebar-nav-history-icon">⚡</div>
                    <div className="lk-sidebar-nav-history-body">
                      <span className="lk-sidebar-nav-history-text">{e.prompt}</span>
                      {e.filePath && <span className="lk-sidebar-nav-history-file">{e.filePath.split('/').pop()}</span>}
                    </div>
                    <span className="lk-sidebar-nav-history-date">{ws.formatRelativeDate?.(e.timestamp)}</span>
                  </button>
                ))}
              </div>
          }
          <div className="lk-sidebar-nav-sep" />
          <button
            className={`lk-sidebar-nav-btn${settingsOpen ? ' lk-sidebar-nav-btn--active' : ''}`}
            onClick={() => { ws.setSettingsOpen(v => !v); ws.setHistoryOpen(false); setMobileDrawerOpen(false) }}
          ><span className="lk-sidebar-nav-icon">⚙</span> Settings</button>
          {shadowStatus && (
            <div className="lk-sidebar-nav-status">
              <div className={`lk-sidebar-shadow${shadowContext.isIndexing ? ' lk-sidebar-shadow--pulse' : ' lk-sidebar-shadow--ready'}`} />
              <span>{shadowStatus}</span>
            </div>
          )}
        </div>
      </nav>

      {mobileDrawerOpen && <div className="lk-mobile-backdrop" onClick={() => setMobileDrawerOpen(false)} />}

      {/* ── Main column ───────────────────────────────────────────────────── */}
      <div className="lk-main">

        {/* Top bar */}
        <div className="lk-topbar" style={{ height: `${headerLayout.headerHeight}px` }}>
          <button className="lk-hamburger" onClick={() => setMobileDrawerOpen(v => !v)} aria-label="Open navigation">≡</button>
          <span className="lk-topbar-mobile-title">
            <img src="/BLUSWAN-logo-transparent.png" alt="BLUSWAN" className="lk-bluswan-logo" />
          </span>
          <>
            <img src="/BLUSWAN-logo-transparent.png" alt="BLUSWAN" className="lk-bluswan-topbar-logo" />

            {/* Repo picker */}
            {githubToken && (
              <div className="lk-repo-picker-wrap" ref={repoPickerRef}>
                <button className="lk-repo-picker-btn" onClick={openRepoPicker} title="Switch repository">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{flexShrink:0,opacity:0.7}}>
                    <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8V1.5Z"/>
                  </svg>
                  <span className="lk-repo-picker-label">
                    {repoOwner && repoName ? `${repoOwner}/${repoName}` : 'Select repo…'}
                  </span>
                  <svg width="9" height="9" viewBox="0 0 9 6" fill="currentColor" style={{flexShrink:0,opacity:0.5}}>
                    <path d="M0 0l4.5 6L9 0z"/>
                  </svg>
                </button>
                {repoPickerOpen && (
                  <div className="lk-repo-picker-dropdown">
                    <div className="lk-repo-picker-search-wrap">
                      <input className="lk-repo-picker-search" placeholder="Search repos…"
                        value={repoPickerSearch} onChange={e => setRepoPickerSearch(e.target.value)} autoFocus />
                    </div>
                    <div className="lk-repo-picker-list">
                      {repoPickerLoading && <div className="lk-repo-picker-status">Loading repositories…</div>}
                      {!repoPickerLoading && repoPickerError && (
                        <div className="lk-repo-picker-error">
                          <span>{repoPickerError}</span>
                          <button className="lk-repo-picker-retry" onClick={loadRepos}>Retry</button>
                        </div>
                      )}
                      {!repoPickerLoading && !repoPickerError && userRepos.length === 0 && (
                        <div className="lk-repo-picker-status">No repositories found.</div>
                      )}
                      {!repoPickerLoading && userRepos
                        .filter(r => { const q = repoPickerSearch.toLowerCase(); return !q || r.full_name.toLowerCase().includes(q) })
                        .map(r => (
                          <button key={r.id}
                            className={`lk-repo-picker-item${repoOwner === r.owner.login && repoName === r.name ? ' lk-repo-picker-item--active' : ''}`}
                            onClick={() => handlePickRepo(r)}>
                            <span className="lk-repo-picker-item-name">{r.name}</span>
                            <span className="lk-repo-picker-item-branch">{r.default_branch}</span>
                          </button>
                        ))
                      }
                    </div>
                  </div>
                )}
              </div>
            )}

            {turnCount > 0 && (
              <div className="lk-turn-badge">
                {turnCount} {turnCount === 1 ? 'turn' : 'turns'}
                {filePath && <span className="lk-turn-file"> · {filePath.split('/').pop()}</span>}
              </div>
            )}
            <div className="lk-topbar-spacer" />
            {shadowStatus && (
              <div className={`lk-shadow-badge${shadowContext.isIndexing ? ' lk-shadow-badge--indexing' : ''}`}
                title="ShadowContext: background repo index">◆ {shadowStatus}</div>
            )}
          </>
          {onLogout && (
            <button className="lk-icon-btn"
              title={userEmail ? `Signed in as ${userEmail} — click to log out` : 'Log out'}
              onClick={onLogout}
              style={{ fontSize: '0.8rem', padding: '0.25rem 0.5rem', opacity: 0.7 }}>⏻</button>
          )}
        </div>

        {/* Settings drawer */}
        {settingsOpen && (
          <BluswanSettings
            githubToken={githubToken}         setGithubToken={setGithubToken}
            githubClientId={githubClientId}   setGithubClientId={setGithubClientId}
            repoOwner={repoOwner}             setRepoOwner={setRepoOwner}
            repoName={repoName}               setRepoName={setRepoName}
            baseBranch={baseBranch}           setBaseBranch={setBaseBranch}
            hasGithub={hasGithub}             onReindex={handleReindex}
            generateTests={generateTests}     setGenerateTests={setGenerateTests}
            creativity={creativity}           setCreativity={setCreativity}
            enableThinking={enableThinking}   setEnableThinking={setEnableThinking}
            thinkingBudget={thinkingBudget}   setThinkingBudget={setThinkingBudget}
            hooksConfig={hooksConfig}         setHooksConfig={setHooksConfig}
            webSearchApiKey={webSearchApiKey} setWebSearchApiKey={setWebSearchApiKey}
            dryRun={dryRun}                   setDryRun={setDryRun}
            permissionMode={permissionMode}   setPermissionMode={setPermissionMode}
            bluswanMdDraft={bluswanMdDraft}   setBluswanMdDraft={setBluswanMdDraft}
            onSaveBluswanMd={handleSaveBluswanMd}
            isSavingBluswanMd={isSavingBluswanMd}
            models={models}                   setModels={setModels}
            onLogout={onLogout}               userEmail={userEmail}
            savedModelIds={savedModelIds}     onModelSaved={onModelSaved}
          />
        )}

        {/* History drawer */}
        {historyOpen && (
          <div className="lk-drawer lk-drawer--history">
            <div className="lk-drawer-hd">
              <span>Task History</span>
              {history.length > 0 && (
                <button className="lk-drawer-clear" onClick={() => { ws.setHistory([]); ws.saveHistory?.([]) }}>Clear all</button>
              )}
            </div>
            {history.length === 0
              ? <div className="lk-empty-note">No tasks yet.</div>
              : <div className="lk-task-history-list">
                  {history.map(e => (
                    <button key={e.id} className="lk-task-history-item"
                      onClick={() => {
                        if (Array.isArray(e.conversation) && e.conversation.length > 0) {
                          ws.setConversation(e.conversation)
                          ws.setTurnCount(e.conversation.filter(m => m.role === 'user').length)
                          ws.setHistoryOpen(false)
                          return
                        }
                        ws.setPrompt(e.prompt); ws.setHistoryOpen(false)
                      }}>
                      <div className="lk-task-history-icon">⚡</div>
                      <div className="lk-task-history-body">
                        <span className="lk-task-history-title">{e.prompt}</span>
                        {e.filePath && <span className="lk-task-history-file">{e.filePath.split('/').pop()}</span>}
                      </div>
                      <span className="lk-task-history-date">{ws.formatRelativeDate?.(e.timestamp)}</span>
                    </button>
                  ))}
                </div>
            }
          </div>
        )}

        {isModulesPage ? (
          <div className="lk-modules-shell">
            <div className="lk-modules-page">
              <div className="lk-modules-page-hd">
                <h2>Modules</h2>
                <button className="lk-btn lk-btn--small" onClick={() => setActiveTab('code')}>Back to Chat</button>
              </div>
              <BluswanModularTools />
            </div>
          </div>
        ) : (
          <>
            {/* Feed row */}
            <div className="lk-feed-row">
              <div className="lk-feed">
                <BluswanActivityFeed
                  activityLog={activityLog}
                  isAgentRunning={agentSession.isAgentRunning}
                  agentStreamText={agentSession.agentStreamText}
                  narrationThread={agentSession.narrationThread}
                  isGenerating={isChatGenerating ? false : isGenerating}
                  isPushing={isPushing}
                  pushStep={pushStep}
                  feedRef={activityFeedRef}
                  conversation={conversation}
                  agentIntent={agentSession.agentIntent}
                  agentTask={agentSession.agentTask}
                  activeModelName={models?.find(m => m.id === activeModelId)?.name || activeModelId || null}
                  escalatedModelId={agentSession.escalatedModelId}
                  agentPhase={agentSession.agentPhase}
                  filePlan={filePlan}
                  isAmplifying={isAmplifying}
                  amplifierDecisions={amplifierDecisions}
                  isPlanning={isPlanning}
                  remediationStatus={remediationStatus}
                  executedPlan={executedPlan}
                  planApproval={planApproval}
                  onApprovePlan={() => {
                    const t = planApproval.task
                    setExecutedPlan(planApproval)
                    setPlanApproval(null)
                    agentSession.run(t, conversation.slice(-10), { forceBuildMode: true, skipAgentStart: true })
                  }}
                  onCancelPlan={() => setPlanApproval(null)}
                  lrmGeneratingPlan={lrmGeneratingPlan}
                  lrmPlan={lrmPlan}
                  onLrmStart={handleLrmStart}
                  onLrmProceed={handleLrmProceed}
                  onLrmOverride={handleLrmOverride}
                  onLrmCancel={handleLrmCancel}
                  onLrmSkip={handleLrmSkip}
                />
              </div>

              {/* Right task sidebar */}
              {conversation.length > 0 && (
                <div className={`lk-task-sidebar${taskSidebarCollapsed ? ' lk-task-sidebar--collapsed' : ''}`}>
                  <button
                    className="lk-task-sidebar-toggle"
                    onClick={() => setTaskSidebarCollapsed(v => !v)}
                    title={taskSidebarCollapsed ? 'Expand task panel' : 'Collapse task panel'}
                  >{taskSidebarCollapsed ? '‹' : '›'}</button>
                  <div className="lk-task-sidebar-inner">
                    <div className="lk-task-sidebar-hd">TASK</div>
                    <div className="lk-task-sidebar-task">
                      {(() => {
                        const firstUser = conversation.find(m => m.role === 'user')
                        const text = typeof firstUser?.content === 'string' ? firstUser.content : ''
                        return text.length > 300 ? `${text.slice(0, 297)}…` : text
                      })()}
                    </div>
                    {agentSession.isAgentRunning && agentSession.agentPhase && (
                      <div className="lk-task-sidebar-phase">
                        <span className="lk-task-sidebar-phase-dot" />
                        <span>{agentSession.agentPhase}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Bottom input bar */}
            <PromptBar
              prompt={ws.prompt}               setPrompt={ws.setPrompt}
              attachedFiles={ws.attachedFiles} setAttachedFiles={ws.setAttachedFiles}
              fileInputRef={ws.fileInputRef}
              refinementPrompt={ws.refinementPrompt}
              generatedCode={ws.generatedCode}
              isGenerating={isGenerating}
              isPushing={isPushing}
              agentSession={agentSession}
              handleRefine={ws.handleRefine}
              handleSubmitPrompt={ws.handleSubmitPrompt}
              handleKeyDown={ws.handleKeyDown}
              handleAbort={ws.handleAbort}
              bridgeAvailable={ws.bridgeAvailable}
              prResult={ws.prResult}
              handleRunProjectTests={ws.handleRunProjectTests}
              isRunningPostPushTests={ws.isRunningPostPushTests}
              routeOverride={routeOverride}
              setRouteOverride={setRouteOverride}
              routeClassification={routeClassification}
              models={models}
              activeModelId={ws.activeModelId}    setActiveModelId={setActiveModelId}
              onModelChange={onModelChange}
              baseBranch={baseBranch}
              lastBranchName={ws.lastBranchName}
              error={ws.error}
            />
          </>
        )}

      </div>
    </div>
  )
}
