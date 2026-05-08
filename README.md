# BLUSWAN

Build software at the speed of intent.

BLUSWAN is a forward-looking AI engineering workspace for teams that want **production outcomes**, not chatbot demos. It combines orchestration, verification, and tooling into one browser-first experience so you can plan changes, execute code edits, validate quality, and ship faster with confidence.

---

## Why BLUSWAN

Most AI coding tools stop at “generated code.” BLUSWAN is built for what happens next:

- **Reliable execution loops** with planning, implementation, and verification stages
- **Multi-model routing** so different tasks use the best-fit model profile
- **Quality safeguards** that catch weak outputs before they become regressions
- **Integrated tooling** for file operations, search, code analysis, commands, package installs, and PR drafting
- **Memory and retrieval context** to improve continuity across tasks and sessions

The goal: transform AI from a drafting assistant into a dependable engineering copilot.

---

## Quick Start

```bash
npm install
npm run dev
```

Open `http://localhost:5173` and sign in with your Google account or email via the Firebase Auth prompt.

Then configure your AI provider in **Settings → AI Provider**.

---

## Core Capabilities

### 1) Agent Reliability Workflow
BLUSWAN runs tasks through a structured lifecycle:

`plan → execute → verify → rollback (if needed)`

This keeps output quality high and reduces the chance of unsafe or incomplete changes reaching your branch.

### 2) Model Orchestration
Route specialized work (planning, debugging, refactoring, review) to different models with configurable strategies, including fallback and cost-aware routing.

### 3) Tool-Driven Execution
The agent can operate with practical engineering tools for:

- file I/O and repository navigation
- stacktrace/code analysis and search
- web/documentation lookups
- command execution and package management
- pull request generation support

### 4) Retrieval + Memory
Use repository-aware context and persistent memory patterns to improve relevance, reduce repeated prompting, and keep long-running work aligned.

### 5) Browser-First, Developer-Controlled
BLUSWAN runs as a React SPA with configurable settings and local development ergonomics. You stay in control of models, keys, and behavior.

---

## Configuration at a Glance

BLUSWAN supports OpenAI-compatible endpoints and can be configured with:

- one or more AI models/providers
- optional GitHub token for repository/PR workflows
- optional web search integration
- optional persistence settings for cross-session continuity

---

## Headless and Automation-Friendly

BLUSWAN also supports CLI-driven workflows for scripted and CI-style operation.

Example:

```bash
node src/cli/bluswan-cli.mjs run "Refactor auth module to use async/await" --model=claude-3-5-sonnet-20241022
```

---

## Deployment

A `render.yaml` blueprint is included for static deployment workflows.

---

## Vision

BLUSWAN is designed for teams moving toward an AI-native engineering model:

- faster iteration cycles
- stronger guardrails
- better model utilization
- higher confidence from prompt to production

If your roadmap includes autonomous coding, multi-model systems, and verification-first delivery, BLUSWAN is built for where you are going next.
