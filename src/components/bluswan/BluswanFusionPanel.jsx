// ─── BluswanFusionPanel ────────────────────────────────────────────────────────
// Full-page Fusion view: attach a source repo, then absorb its best material.

import { memo } from 'react'

// ── Ritual definitions ────────────────────────────────────────────────────────
const FUSION_RITUALS = [
  {
    id:          'deep-audit',
    label:       'Deep Audit',
    icon:        '◈',
    description: 'Full architecture scan of source — map every integration opportunity',
    prompt:
`Perform a deep architectural audit of the SOURCE repository ({src}).

Use list_source_directory to explore its full structure. Then read all key files (package.json, main entry points, core services, utilities, hooks) using read_source_file.

For each significant pattern, service, or capability found in source:
1. Assess whether it is stronger or more robust than what exists in the target repo ({tgt})
2. Note exact file paths and their implementations
3. Score integration value (1-10)

Produce a prioritised report of integration opportunities with file-level specifics. Focus on: architectural patterns, utility functions, service abstractions, error handling, retry logic, caching, context management, and capabilities the target repo currently lacks.`,
  },
  {
    id:          'extract-integrate',
    label:       'Extract & Integrate',
    icon:        '⤓',
    description: 'Pull the highest-value patterns from source and integrate them',
    prompt:
`Extract and integrate the highest-value patterns from the SOURCE repository ({src}) into the TARGET repo ({tgt}).

Steps:
1. Use list_source_directory to understand source's full structure
2. Read source's core files using read_source_file (services, utils, hooks, components)
3. Identify the 3-5 specific improvements the target repo would benefit from most
4. For each improvement: read the source implementation fully with read_source_file, then write or edit the corresponding files in the TARGET repo
5. Maintain the target repo's existing conventions, architecture, and naming style
6. After all integrations, summarise: what was extracted, from which source files, and why it was chosen`,
  },
  {
    id:          'strength-hunt',
    label:       'Strength Hunt',
    icon:        '◎',
    description: 'Find what source does better than this repo and replicate it',
    prompt:
`Hunt for strengths in the SOURCE repository ({src}) that the TARGET repo ({tgt}) lacks or implements less robustly.

1. Use list_source_directory to systematically explore source's structure
2. Read source's services, utilities, and core logic using read_source_file
3. For each file/pattern, score robustness vs the target repo (focus on 7+/10)
4. For each strong pattern: read the full source implementation, then integrate it directly into the target repo
5. Add a brief code comment on each integration: "// Adapted from {src}"

Focus especially on: error handling, retry logic, caching strategies, context management, state patterns, streaming, and utility functions.`,
  },
  {
    id:          'feature-delta',
    label:       'Feature Delta',
    icon:        '⊕',
    description: 'Discover what source has that this repo is missing, then build it',
    prompt:
`Perform a feature delta analysis: find what the SOURCE ({src}) has that the TARGET ({tgt}) is missing, then implement it.

1. Read source's README.md and package.json using read_source_file to map its full capabilities
2. Explore source's main components and services with list_source_directory and read_source_file
3. Produce a list of features and capabilities source has that the target is missing or implements more weakly
4. For the top 3 highest-impact missing features: implement them in the target repo now
5. Adapt all implementations to fit the target repo's architecture, naming conventions, and existing dependencies`,
  },
  {
    id:          'self-evolve',
    label:       'Self-Evolve',
    icon:        '⟳',
    description: 'Extract the best of source and evolve this repo\'s own core systems',
    prompt:
`This is a self-evolution operation. Extract the best patterns from SOURCE ({src}) and evolve TARGET ({tgt}).

1. Use list_source_directory to explore source — read its AI/agent-related files, services, utilities, and core logic with read_source_file
2. Read the target repo's own core files (agentLoop.js, aiService.js, shadowContext.js, agentExecutor.js, planner.js) to understand the current implementation
3. Identify specific high-value improvements: better context handling, smarter planning, stronger execution, more robust error recovery
4. Implement the improvements directly — edit the relevant files in the target repo
5. Preserve all existing functionality — only enhance, never regress
6. Produce a closing summary: "What was learned from source" and "What was improved in target"`,
  },
]

const ABSORB_PROMPT =
`You are performing a DEEP FUSION ABSORB operation from SOURCE ({src}) into TARGET ({tgt}).

This is a full multi-pass extraction. Work through every phase:

PHASE 1 — MAP THE SOURCE
Use list_source_directory to fully explore the source repo structure. Read package.json, README, and all top-level entry points with read_source_file. Build a complete mental model of what source does and how.

PHASE 2 — IDENTIFY THE BEST MATERIAL
Compare source capabilities against the target repo. Score each area (1-10) for integration value. Select everything scoring 6 or above: architecture patterns, utilities, services, error handling, state management, streaming, AI/agent logic, hooks, and any features the target lacks entirely.

PHASE 3 — ABSORB
For each selected item:
1. Read the full source implementation with read_source_file
2. Write or edit the corresponding file in the TARGET repo
3. Adapt naming conventions, imports, and structure to match the target's existing style
4. Never break existing functionality — only enhance

PHASE 4 — REPORT
Close with a structured summary:
- What was absorbed (file-by-file)
- Which source files it came from
- Why it was chosen
- What improved in the target`

// ── Component ─────────────────────────────────────────────────────────────────

const BluswanFusionPanel = memo(function BluswanFusionPanel({
  sourceRepo,      // { owner, repo, branch }
  targetRepo,      // { owner, repo, branch }
  onRunRitual,     // (prompt: string) => void
  onAbsorb,        // () => void — runs the full absorb prompt
  isRunning,       // bool
  shadowStatus2,   // string | null
  // attach form state (passed from parent)
  repo2Owner, setRepo2Owner,
  repo2Name,  setRepo2Name,
  repo2Branch, setRepo2Branch,
  repo2Token,  setRepo2Token,
  hasBothRepos,
}) {
  const srcLabel = (sourceRepo?.owner && sourceRepo?.repo)
    ? `${sourceRepo.owner}/${sourceRepo.repo}`
    : 'source'
  const tgtLabel = (targetRepo?.owner && targetRepo?.repo)
    ? `${targetRepo.owner}/${targetRepo.repo}`
    : 'target'

  function resolvePrompt(template) {
    return template.replace(/\{src\}/g, srcLabel).replace(/\{tgt\}/g, tgtLabel)
  }

  // Parse a GitHub URL into { owner, repo, branch }
  // Handles formats:
  //   github.com/owner/repo
  //   github.com/owner/repo.git
  //   github.com/owner/repo/tree/branch-name
  //   github.com/owner/repo/tree/branch/subpath  (only first segment used)
  function parseGitHubRepoUrl(raw) {
    try {
      const clean = raw.trim().replace(/^https?:\/\//, '').replace(/^git@github\.com:/, 'github.com/')
      if (!clean.includes('github.com')) return null
      const after = clean.replace(/^.*github\.com\//, '')
      const parts  = after.split('/')
      if (parts.length < 2) return null
      const owner  = parts[0]
      const repo   = parts[1].replace(/\.git$/, '')
      // /tree/<branch> is at parts[2] === 'tree', parts[3] === branch
      const branch = (parts[2] === 'tree' && parts[3]) ? parts[3] : null
      return { owner, repo, branch }
    } catch {
      return null
    }
  }

  function handleQuickPaste(e) {
    const parsed = parseGitHubRepoUrl(e.target.value)
    if (!parsed) return
    setRepo2Owner(parsed.owner)
    setRepo2Name(parsed.repo)
    if (parsed.branch) setRepo2Branch(parsed.branch)
    // Clear the paste field after autofill
    e.target.value = ''
  }

  return (
    <div className="lk-fusion-page">

      {/* ── Attach section ──────────────────────────────────────────────── */}
      <div className="lk-fusion-attach">
        <div className="lk-fusion-attach-hd">
          <span className="lk-fusion-attach-icon">⟳</span>
          <span className="lk-fusion-attach-title">Fusion</span>
          {hasBothRepos && (
            <span className="lk-fusion-attach-connected">
              {srcLabel} → {tgtLabel}
            </span>
          )}
        </div>

        <div className="lk-fusion-attach-body">
          <input
            className="lk-input lk-fusion-attach-paste"
            placeholder="Paste a GitHub URL to auto-fill all fields"
            onPaste={e => {
              // Intercept paste — fill fields instantly, clear the input
              const text = e.clipboardData.getData('text')
              const parsed = parseGitHubRepoUrl(text)
              if (parsed) {
                e.preventDefault()
                setRepo2Owner(parsed.owner)
                setRepo2Name(parsed.repo)
                if (parsed.branch) setRepo2Branch(parsed.branch)
                e.target.value = ''
              }
            }}
            onChange={handleQuickPaste}
          />
          <div className="lk-fusion-attach-row">
            <input className="lk-input" placeholder="owner" value={repo2Owner}
              onChange={e => setRepo2Owner(e.target.value.trim())} />
            <span className="lk-fusion-attach-sep">/</span>
            <input className="lk-input" placeholder="repo" value={repo2Name}
              onChange={e => setRepo2Name(e.target.value.trim())} />
            <input className="lk-input lk-fusion-attach-branch" placeholder="branch" value={repo2Branch}
              onChange={e => setRepo2Branch(e.target.value.trim())} />
          </div>
          <input className="lk-input" type="password" placeholder="Token (optional — reuses primary token)"
            value={repo2Token} onChange={e => setRepo2Token(e.target.value)} autoComplete="off" />

          {shadowStatus2 && (
            <div className="lk-fusion-attach-status">{shadowStatus2}</div>
          )}

          <div className="lk-fusion-attach-actions">
            {hasBothRepos && (
              <button className="lk-btn lk-btn--small" onClick={() => {
                setRepo2Owner(''); setRepo2Name(''); setRepo2Branch('main'); setRepo2Token('')
              }}>Disconnect</button>
            )}
          </div>
        </div>
      </div>

      {/* ── Absorb button ───────────────────────────────────────────────── */}
      <button
        className="lk-fusion-absorb-btn"
        disabled={!hasBothRepos || isRunning}
        onClick={() => onRunRitual(resolvePrompt(ABSORB_PROMPT))}
        title={hasBothRepos ? `Deep absorb — pull the most beneficial material from ${srcLabel} into ${tgtLabel}` : 'Attach a source repo first'}
      >
        <span className="lk-fusion-absorb-icon">⤓</span>
        <span className="lk-fusion-absorb-body">
          <span className="lk-fusion-absorb-label">Absorb</span>
          <span className="lk-fusion-absorb-desc">Deep comparison — pulls the most beneficial material from source into target</span>
        </span>
      </button>

      {/* ── Ritual grid ─────────────────────────────────────────────────── */}
      {hasBothRepos && (
        <>
          <div className="lk-fusion-rituals-hd">Or choose a specific operation</div>
          <div className={`lk-fusion-grid`}>
            {FUSION_RITUALS.map(ritual => (
              <button
                key={ritual.id}
                className={`lk-fusion-btn`}
                onClick={() => onRunRitual(resolvePrompt(ritual.prompt))}
                disabled={isRunning}
                title={ritual.description}
              >
                <span className="lk-fusion-btn-icon">{ritual.icon}</span>
                <span className="lk-fusion-btn-body">
                  <span className="lk-fusion-btn-label">{ritual.label}</span>
                  <span className="lk-fusion-btn-desc">{ritual.description}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}

    </div>
  )
})

export default BluswanFusionPanel
