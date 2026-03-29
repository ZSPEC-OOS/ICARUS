import { memo } from 'react'
import { highlightCode } from '../../utils/codeUtils.js'

// âââ LogikCodePane ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Renders the Generated Code tab, including the refinement bar.
const LogikCodePane = memo(function LogikCodePane({
  generatedCode,
  isGenerating,
  language,
  hasGithub,
  filePath,
  refinementPrompt,
  onRefinementChange,
  onRefine,
  onReset,
  turnCount,
  pipelinePhase,
  pipelineSteps,
  validationResults,
  livePlan = [],
}) {
  return (
    <div className="lk-output" style={{ display: 'flex', flexDirection: 'column' }}>
      {!!pipelineSteps?.length && (
        <div className="lk-phase-tracker" aria-live="polite">
          {pipelineSteps.map((step) => (
            <span key={step.key} className={`lk-phase-pill lk-phase-pill--${step.state}`}>
              {step.state === 'done' ? 'â' : step.state === 'active' ? 'â' : 'â'} {step.label}
            </span>
          ))}
          <span className="lk-phase-current">Current: {pipelinePhase}</span>
        </div>
      )}
      {!!livePlan.length && (
        <div className="lk-validation-panel" style={{ marginTop: 8, marginBottom: 8 }}>
          <div className="lk-validation-title">Live Plan</div>
          {livePlan.map((step, idx) => (
            <div key={`${step}-${idx}`} className="lk-validation-row">{idx + 1}. {step}</div>
          ))}
        </div>
      )}
      <div className="lk-code-scroll" style={{ flex: 1 }}>
        {isGenerating && !generatedCode && (
          <div className="lk-generating"><span className="lk-spinner" /> Generatingâ¦</div>
        )}
        {generatedCode ? (
          <pre className="lk-pre">
            <code dangerouslySetInnerHTML={{ __html: highlightCode(generatedCode, language) }} />
          </pre>
        ) : null}

        {!!validationResults?.length && (
          <div className="lk-validation-panel">
            <div className="lk-validation-title">Validation</div>
            {validationResults.map((result, idx) => (
              <div key={`${result}-${idx}`} className="lk-validation-row">{result}</div>
            ))}
          </div>
        )}
      </div>

      {generatedCode && !isGenerating && (
        <div className="lk-refine-bar">
          {turnCount > 0 && (
            <span className="lk-turn-info">{turnCount} {turnCount === 1 ? 'turn' : 'turns'}</span>
          )}
          <input
            className="lk-input lk-refine-input"
            placeholder={`Refine: 'make it async', 'add error handling', 'add JSDoc'â¦`}
            value={refinementPrompt}
            onChange={e => onRefinementChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onRefine() } }}
          />
          <button className="lk-btn lk-btn--refine" onClick={onRefine} disabled={!refinementPrompt.trim()}>
            âº Refine
          </button>
          <button className="lk-btn lk-btn--reset" onClick={onReset} title="Clear conversation and start over">
            â
          </button>
        </div>
      )}
    </div>
  )
})

export default LogikCodePane
