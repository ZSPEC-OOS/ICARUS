import { useState, useEffect } from 'react';
import { getFeatureFlags, setFeatureFlag, subscribeToFlags } from '../config/featureFlags.js';
import './styles.css';

/**
 * Runtime V1/V2 engine toggle. Switches the active engine without a page reload.
 * @param {Object} props
 * @param {Function} [props.onSwitch] - Called after toggle with { engine: 'v1'|'v2' }
 * @param {'header'|'floating'} [props.position='header']
 */
export default function EngineToggle({ onSwitch, position = 'header' }) {
  const [flags, setFlags] = useState(getFeatureFlags());
  const [isTransitioning, setIsTransitioning] = useState(false);

  useEffect(() => {
    return subscribeToFlags(() => setFlags(getFeatureFlags()));
  }, []);

  const handleToggle = () => {
    if (isTransitioning) return;
    const newIsV2 = !flags.useV2Engine;

    if (window.__taskIsRunning) {
      if (!window.confirm('A task is running. Switching will stop it. Continue?')) return;
      if (window.__stopCurrentTask) window.__stopCurrentTask();
    }

    setIsTransitioning(true);
    setFeatureFlag('useV2Engine', newIsV2);
    setFeatureFlag('useV2UI', newIsV2);

    if (onSwitch) onSwitch({ engine: newIsV2 ? 'v2' : 'v1' });
    setTimeout(() => setIsTransitioning(false), 300);
  };

  const isV2 = flags.useV2Engine;

  return (
    <div className={`engine-toggle engine-toggle--${position}`}>
      <button
        type="button"
        className={`engine-toggle__switch ${isV2 ? 'v2' : 'v1'}${isTransitioning ? ' transitioning' : ''}`}
        onClick={handleToggle}
        aria-pressed={isV2}
        aria-label={isV2 ? 'Switch to V1 Legacy engine' : 'Switch to V2 Deterministic engine'}
      >
        <span className="engine-toggle__track">
          <span className="engine-toggle__thumb" />
        </span>
      </button>
      <div className="engine-toggle__labels">
        <span className={!isV2 ? 'active' : ''}>V1</span>
        <span className={isV2 ? 'active' : ''}>V2</span>
      </div>
      <div className="engine-toggle__status">
        <span className={`status-dot ${isV2 ? 'v2' : 'v1'}`} />
        <span className="status-text">{isV2 ? 'Deterministic' : 'Legacy'}</span>
      </div>
    </div>
  );
}
