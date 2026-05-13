// import.meta.env is Vite-only. Guard for Node.js test environments.
const _env = (typeof import.meta !== 'undefined' && import.meta.env) ? import.meta.env : {};

export const FEATURES = {
  useV2Engine: _env.VITE_V2_ENGINE === 'true',
  useV2UI: _env.VITE_V2_UI === 'true',
};
