import React, { useState } from 'react'
import BudgetBar from './BudgetBar.jsx'
import DeliverableList from './DeliverableList.jsx'
import CycleCard from './CycleCard.jsx'
import QualitySignals from './QualitySignals.jsx'
import PlanReview from './PlanReview.jsx'
import CycleReview from './CycleReview.jsx'

function phaseLabel(phase) {
  const labels = {
    idle: 'Idle',
    planning: 'Planning',
    executing: 'Executing',
    verifying: 'Verifying',
    done: 'Done',
    halted: 'Halted',
    error: 'Error',
  }
  return labels[phase] || phase || 'Unknown'
}

export default function TaskDashboard({ v2State = {}, onStartTask, onApprovePlan, onRejectPlan }) {
  const [showPlanReview, setShowPlanReview] = useState(false)
  const [showCycleReview, setShowCycleReview] = useState(false)

  const {
    phase = 'idle',
    plan = null,
    cycles = [],
    budget = null,
    gates = [],
    securityScan = null,
    taskSpec = null,
    error = null,
  } = v2State

  const deliverables = plan?.deliverables || []
  const completedCount = deliverables.filter(d => d.completed).length
  const failedCount = deliverables.filter(d => d.failed).length

  const tokenBudget = budget?.tokens
  const cycleBudget = budget?.cycles

  function handleApprovePlan() {
    setShowPlanReview(false)
    onApprovePlan?.()
  }

  function handleRejectPlan() {
    setShowPlanReview(false)
    onRejectPlan?.()
  }

  return (
    <div className="v2-layout">
      <div className="task-dashboard">
        <header className="dashboard-header">
          <div className="dashboard-header-left">
            <h1 className="dashboard-title">
              {taskSpec?.goal ? taskSpec.goal.slice(0, 80) : 'Task Dashboard'}
            </h1>
            <span className={`phase-badge phase-badge--${phase}`}>{phaseLabel(phase)}</span>
          </div>

          <div className="dashboard-header-actions">
            {phase === 'idle' && onStartTask && (
              <button className="btn-primary" onClick={onStartTask} type="button">
                Start Task
              </button>
            )}
            {plan && (
              <button className="btn-secondary" onClick={() => setShowPlanReview(true)} type="button">
                View Plan
              </button>
            )}
            {cycles.length > 0 && (
              <button className="btn-ghost" onClick={() => setShowCycleReview(true)} type="button">
                Cycle Review
              </button>
            )}
          </div>
        </header>

        {error && (
          <div className="dashboard-error" role="alert">
            <strong>Error:</strong> {String(error)}
          </div>
        )}

        <div className="dashboard-grid">
          <section className="plan-panel">
            <h2>Deliverables</h2>
            {deliverables.length > 0 && (
              <div className="plan-panel-counts">
                <span className="status-badge status-badge--completed">{completedCount} done</span>
                {failedCount > 0 && (
                  <span className="status-badge status-badge--failed">{failedCount} failed</span>
                )}
                <span className="status-badge status-badge--pending">
                  {deliverables.length - completedCount - failedCount} pending
                </span>
              </div>
            )}
            <DeliverableList deliverables={deliverables} />
          </section>

          <section className="context-panel">
            {tokenBudget && (
              <BudgetBar
                used={tokenBudget.used}
                total={tokenBudget.total}
                label="Tokens"
                type="tokens"
              />
            )}
            {cycleBudget && (
              <BudgetBar
                used={cycleBudget.used}
                total={cycleBudget.total}
                label="Cycles"
                type="cycles"
              />
            )}

            {gates.length > 0 && (
              <div className="context-panel-gates">
                <h3>Quality Signals</h3>
                <QualitySignals gates={gates} securityScan={securityScan} />
              </div>
            )}
          </section>
        </div>

        {cycles.length > 0 && (
          <section className="cycle-timeline-section">
            <h2>Cycle Timeline</h2>
            <div className="cycle-timeline">
              {cycles.map((cycle, idx) => (
                <CycleCard
                  key={cycle.id || idx}
                  cycle={cycle}
                  index={idx}
                  defaultExpanded={false}
                />
              ))}
            </div>
          </section>
        )}
      </div>

      {showPlanReview && (
        <PlanReview
          plan={plan}
          onApprove={onApprovePlan ? handleApprovePlan : null}
          onReject={onRejectPlan ? handleRejectPlan : null}
          onClose={() => setShowPlanReview(false)}
        />
      )}

      {showCycleReview && (
        <CycleReview
          cycles={cycles}
          gates={gates}
          securityScan={securityScan}
          onClose={() => setShowCycleReview(false)}
        />
      )}
    </div>
  )
}
