/**
 * FeatureFlagPanel — dev-only in-app feature flag toggler.
 * Only renders in import.meta.env.DEV. Saves to localStorage and reloads.
 */

const BOOLEAN_FLAGS = [
  { key: 'useV2Engine',         label: 'V2 Engine' },
  { key: 'useV2UI',             label: 'V2 UI' },
  { key: 'useV2Context',        label: 'V2 Context Budget' },
  { key: 'useV2LoopPrevention', label: 'V2 Loop Prevention' },
  { key: 'useV2Reliability',    label: 'V2 Reliability Gates' },
  { key: 'useV2Executor',       label: 'V2 Executor' },
  { key: 'enablePlanReview',    label: 'Plan Review Checkpoint' },
  { key: 'enableCycleReview',   label: 'Cycle Review Checkpoint' },
  { key: 'enableTelemetry',     label: 'Telemetry' },
];

const NUMERIC_FLAGS = [
  { key: 'maxCycles',          label: 'Max Cycles',          min: 1, max: 10 },
  { key: 'maxTurnsPerCycle',   label: 'Max Turns / Cycle',   min: 1, max: 50 },
  { key: 'contextWindow',      label: 'Context Window',      min: 4000, max: 256000, step: 4000 },
  { key: 'remediationBudget',  label: 'Remediation Budget',  min: 10, max: 500, step: 10 },
];

/**
 * @param {Object} props
 * @param {import('../config/featureFlags.js').FeatureFlags} props.flags
 * @param {(key: string, value: boolean|number) => void} props.onChange
 */
export default function FeatureFlagPanel({ flags, onChange }) {
  if (!import.meta.env.DEV) return null;

  return (
    <div style={{
      position: 'fixed',
      bottom: '2rem',
      right: '1rem',
      zIndex: 9995,
      background: '#0f172a',
      border: '1px solid #334155',
      borderRadius: '8px',
      padding: '1rem',
      width: '260px',
      boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', monospace",
      fontSize: '0.75rem',
      color: '#94a3b8',
    }}>
      <div style={{ fontWeight: 700, color: '#e2e8f0', marginBottom: '0.75rem', fontSize: '0.78rem', letterSpacing: '0.05em' }}>
        ⚙ Feature Flags (dev)
      </div>

      {BOOLEAN_FLAGS.map(({ key, label }) => (
        <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={!!flags[key]}
            onChange={(e) => onChange(key, e.target.checked)}
            style={{ accentColor: '#34d399', cursor: 'pointer' }}
          />
          <span style={{ color: flags[key] ? '#34d399' : '#64748b' }}>{label}</span>
        </label>
      ))}

      <div style={{ borderTop: '1px solid #1e293b', margin: '0.6rem 0' }} />

      {NUMERIC_FLAGS.map(({ key, label, min, max, step = 1 }) => (
        <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.3rem' }}>
          <span>{label}</span>
          <input
            type="number"
            value={flags[key]}
            min={min}
            max={max}
            step={step}
            onChange={(e) => onChange(key, parseInt(e.target.value))}
            style={{
              width: '70px', background: '#1e293b', border: '1px solid #334155',
              borderRadius: '3px', color: '#e2e8f0', fontSize: '0.75rem',
              padding: '0.15rem 0.3rem', textAlign: 'right',
            }}
          />
        </div>
      ))}

      <div style={{ borderTop: '1px solid #1e293b', margin: '0.75rem 0 0.5rem' }} />

      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button
          onClick={() => {
            try { localStorage.removeItem('bluswan_flags'); } catch { /* blocked */ }
            window.location.reload();
          }}
          style={{
            flex: 1, background: '#1e293b', border: '1px solid #334155',
            borderRadius: '4px', color: '#94a3b8', cursor: 'pointer',
            fontSize: '0.7rem', padding: '0.3rem',
          }}
        >
          Reset Defaults
        </button>
        <button
          onClick={() => window.location.reload()}
          style={{
            flex: 1, background: '#164e63', border: '1px solid #155e75',
            borderRadius: '4px', color: '#67e8f9', cursor: 'pointer',
            fontSize: '0.7rem', padding: '0.3rem',
          }}
        >
          Apply &amp; Reload
        </button>
      </div>
    </div>
  );
}
