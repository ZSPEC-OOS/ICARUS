import { memo } from 'react'

// ─── BluswanDiffViewer ──────────────────────────────────────────────────────────
// Renders the Diff tab: unified diff with syntax colouring, plus patch summary
// when the agent used surgical EDIT_START/EDIT_END blocks.
const BluswanDiffViewer = memo(function BluswanDiffViewer({ diffText, patchEdits }) {
  if (!diffText) {
    return (
      <div className="lk-output" style={{ display: 'block' }}>
        <div className="lk-code-scroll" style={{ height: '100%' }}>
          <div className="lk-placeholder">
            <div className="lk-placeholder-glyph">⊕</div>
            <p className="lk-placeholder-body">Generate code first — diffs appear automatically for all created and modified files.</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="lk-output" style={{ display: 'block' }}>
      <div className="lk-code-scroll" style={{ height: '100%' }}>
        {patchEdits.length > 0 && (
          <div className="lk-patch-summary">
            {patchEdits.map((e, i) => (
              <div key={i} className={`lk-patch-block${e.applied ? '' : ' lk-patch-block--failed'}`}>
                <div className="lk-patch-hdr">
                  Edit {i + 1} — {e.applied ? '✓ applied' : '✗ not found'}
                </div>
                <pre className="lk-patch-pre lk-diff-del">{e.old}</pre>
                <pre className="lk-patch-pre lk-diff-add">{e.new}</pre>
              </div>
            ))}
          </div>
        )}

        {!patchEdits.length && (
          <pre className="lk-pre lk-pre--diff">
            {diffText.split('\n').map((line, i) => (
              <div key={i} className={
                line.startsWith('+++') || line.startsWith('---') ? 'lk-diff-hdr' :
                line.startsWith('+') ? 'lk-diff-add' :
                line.startsWith('-') ? 'lk-diff-del' : 'lk-diff-ctx'
              }>{line}</div>
            ))}
          </pre>
        )}
      </div>
    </div>
  )
})

export default BluswanDiffViewer
