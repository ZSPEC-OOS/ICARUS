# ICARUS — AI professional coder

## Setup

```bash
npm install
npm run dev
```

Open http://localhost:5173 and log in with:
- **Username:** logik
- **Password:** admin

## Configuration

1. Open Settings (⚙ gear icon in the sidebar)
2. Enter your AI provider API key (Anthropic, OpenAI, Kimi, etc.)
3. Add a GitHub Personal Access Token with `repo` scope for code push/PR features

## Exec Bridge (Terminal & Tools tab)

The terminal and Tools tab require the Vite dev server to be running — they send
shell commands to a local middleware endpoint (`/api/exec`). This is dev-only and
is never included in a production build.

## Environment

Optional: copy `.env.example` to `.env.local` and set `VITE_AI_PROXY_URL` to
route API calls through a backend proxy instead of calling providers directly.

## Deploying to Render (Static Site)

This repo includes a `render.yaml` blueprint for a static deployment. Render will:
- install dependencies (`npm ci`)
- build with Vite (`npm run build`)
- publish the `dist/` directory
- rewrite all routes to `index.html` so deep links in the SPA do not 404

If you deploy from the Render UI instead of a Blueprint, use:
- **Build Command:** `npm ci && npm run build`
- **Publish Directory:** `dist`

