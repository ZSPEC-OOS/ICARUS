# BLUSWAN Repository Restructure Plan (No Functional Changes)

## 1) Proposed new folder structure

```text
.
├─ apps/
│  └─ web/
│     ├─ index.html
│     ├─ vite.config.js
│     ├─ package.json
│     ├─ src/
│     │  ├─ app/
│     │  │  ├─ App.jsx
│     │  │  └─ main.jsx
│     │  ├─ features/
│     │  │  ├─ workspace/
│     │  │  │  ├─ components/
│     │  │  │  │  ├─ WorkspaceShell.jsx        # from Bluswan.jsx
│     │  │  │  │  ├─ ActivityFeed.jsx
│     │  │  │  │  ├─ CodePane.jsx
│     │  │  │  │  ├─ DiffViewer.jsx
│     │  │  │  │  ├─ TerminalPane.jsx
│     │  │  │  │  ├─ ToolsPane.jsx
│     │  │  │  │  └─ SettingsPanel.jsx
│     │  │  │  ├─ hooks/
│     │  │  │  └─ styles/workspace.css
│     │  │  └─ auth/
│     │  │     └─ components/LoginScreen.jsx
│     │  ├─ services/
│     │  │  ├─ ai/
│     │  │  ├─ agent/
│     │  │  ├─ github/
│     │  │  ├─ firebase/
│     │  │  ├─ context/
│     │  │  └─ local/
│     │  ├─ tools/
│     │  ├─ shared/
│     │  │  ├─ config/
│     │  │  └─ utils/
│     │  └─ assets/
│     │     └─ (branding assets)
│     └─ public/
├─ packages/
│  └─ planner-py/
│     ├─ planner/
│     ├─ pydantic/
│     └─ tests/
├─ docs/
│  ├─ codex-capability-alignment.md
│  └─ repository-restructure-plan.md
└─ .env.example
```

## 2) Mapping from old files → new locations

| Old path | New path |
|---|---|
| `src/main.jsx` | `apps/web/src/app/main.jsx` |
| `src/App.jsx` | `apps/web/src/app/App.jsx` |
| `src/components/Bluswan.jsx` | `apps/web/src/features/workspace/components/WorkspaceShell.jsx` |
| `src/components/Bluswan.css` | `apps/web/src/features/workspace/styles/workspace.css` |
| `src/components/LoginScreen.jsx` | `apps/web/src/features/auth/components/LoginScreen.jsx` |
| `src/components/bluswan/*` | `apps/web/src/features/workspace/components/*` |
| `src/core/hooks/*` | `apps/web/src/features/workspace/hooks/*` (or `shared/hooks` if reused cross-feature) |
| `src/services/aiService.js` | `apps/web/src/services/ai/aiService.js` |
| `src/services/githubService.js` | `apps/web/src/services/github/githubService.js` |
| `src/services/firebaseService.js` | `apps/web/src/services/firebase/firebaseService.js` |
| `src/services/localFileService.js` | `apps/web/src/services/local/localFileService.js` |
| `src/services/agent*.js` + planner-orchestration service files | `apps/web/src/services/agent/*` |
| `src/services/shadowContext.js` | `apps/web/src/services/context/shadowContext.js` |
| `src/config/constants.js` | `apps/web/src/shared/config/constants.js` |
| `src/utils/*` | `apps/web/src/shared/utils/*` |
| `src/tools/*` | `apps/web/src/tools/*` |
| `planner/*` | `packages/planner-py/planner/*` |
| `tests/*` | `packages/planner-py/tests/*` |
| `pydantic/*` | `packages/planner-py/pydantic/*` |

## 3) Required import/path updates

- Update frontend aliases to reduce deep relative paths:
  - `@app/* -> apps/web/src/app/*`
  - `@features/* -> apps/web/src/features/*`
  - `@services/* -> apps/web/src/services/*`
  - `@shared/* -> apps/web/src/shared/*`
  - `@tools/* -> apps/web/src/tools/*`
- Update `vite.config.js` to define aliases above.
- Replace imports like `../services/aiService` with `@services/ai/aiService`.
- Replace imports like `../utils/codeUtils` with `@shared/utils/codeUtils`.
- Keep runtime behavior exactly the same; these are path-only moves.

## 4) Structural issues identified in current repo

1. **Monolithic UI shell**: `src/components/Bluswan.jsx` contains UI rendering, state orchestration, GitHub write flows, prompt assembly, and agent execution orchestration in one large file.
2. **Mixed frontend + Python package roots** at top-level without clear workspace boundaries.
3. **Cross-cutting service directory** with many unrelated concerns mixed together (`ai`, `agent`, `firebase`, `github`, file system, planning).
4. **Branding inconsistency** (`BLUSWAN` naming in many user-facing and internal strings).
5. **Theme concerns spread between large CSS and component state**; difficult to evolve design tokens safely.
6. **No clear architecture boundary** between feature code and shared primitives.

## 5) Step-by-step migration plan

1. Create folder skeleton (`apps/web`, `packages/planner-py`) and move files with **git mv** only.
2. Add Vite aliases and keep old relative imports compiling incrementally.
3. Move `main.jsx` and `App.jsx` into `app/`, then fix entry imports.
4. Move workspace feature files (`Bluswan.jsx`, `bluswan/*`, `Bluswan.css`) into `features/workspace/` and update imports.
5. Move auth component (`LoginScreen.jsx`) into `features/auth/` and update imports.
6. Split `services/` into concern-based subfolders and update imports.
7. Move `config/` and `utils/` into `shared/` and update imports.
8. Relocate Python planner package + tests into `packages/planner-py/`; verify pytest discovery path still works.
9. Run full checks (`npm run build`, `npm run test` if available, `pytest`).
10. Add a short architecture doc and ownership notes for maintainability.

## Validation strategy

- Frontend:
  - `npm run build`
  - `npm run lint` (if configured)
- Python planner:
  - `pytest`

If tests are missing in the frontend, add minimal smoke coverage:
- App boot render test.
- Login unlock flow test.
- Workspace header render test (branding + top controls).
- Service contract tests for `aiService` and `githubService` mock calls.

## Optional naming and modular design improvements

- Rename `Bluswan.jsx` to `WorkspaceShell.jsx` and keep `Bluswan` as exported compatibility alias during transition.
- Normalize component file names to feature-oriented names (`SettingsPanel`, `ToolsPane`, etc.).
- Standardize token and settings key names behind a single `settingsKeys` module.
- Introduce typed boundaries (JSDoc typedefs or TS migration) for service contracts.

## Technical debt to track (without refactor yet)

- Very large component file with mixed concerns (`Bluswan.jsx`).
- Long CSS file with broad scope and limited token encapsulation.
- Brand string duplication across many files.
- Implicit storage schema in local/session storage without centralized versioning.
