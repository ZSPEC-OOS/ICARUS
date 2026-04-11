// ─── Bluswan ─────────────────────────────────────────────────────────────────
// Thin entry-point component.
// All state, effects, and handlers live in useWorkspaceState (workspace/);
// all layout and rendering lives in WorkspaceShell (workspace/).

import WorkspaceShell from './workspace/WorkspaceShell'

export default function Bluswan(props) {
  return <WorkspaceShell {...props} />
}
