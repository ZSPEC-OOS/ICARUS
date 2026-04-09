// ─── selfImproveService.js ────────────────────────────────────────────────────
// Manages the self-improvement cycle between two Bluswan repositories.
// Each full cycle runs two agent phases plus two clone operations.
//
// Phase A (steps 1–7):
//   1-2: Agent analyzes bluswan2, implements ONE enhancement IN bluswan2
//   3-4: bluswan2 auto-committed (by agent writes), re-index bluswan2
//   5-7: Clone bluswan2 → bluswan, re-index bluswan
//
// Phase B (steps 8–14):
//   8-9:  Agent analyzes bluswan, implements ONE enhancement IN bluswan
//   10-11: bluswan auto-committed, re-index bluswan
//   12-14: Clone bluswan → bluswan2, re-index bluswan2
//
// → Loop (up to maxCycles)

import { runAgentLoop }         from './agentLoop.js'
import { makeExecutor }         from './agentExecutor.js'
import { AGENT_TOOLS, buildAgentSystemPrompt } from './agentTools.js'
import { listDirectory, getFileContent, createOrUpdateFile } from './githubService.js'
import { decodeBase64, encodeBase64 } from '../utils/base64.js'
import { shadowContext, shadowContext2 } from './shadowContext.js'

// ── Prompts ───────────────────────────────────────────────────────────────────

const PHASE_A_PROMPT = cycle => `You are running self-improvement cycle #${cycle}.
Your task: improve the BLUSWAN2 repository (the secondary instance).

STEP 1 — Explore bluswan2 using list_directory and read_file (bluswan2 is your write target).
STEP 2 — Optionally read the primary bluswan repo using read_source_file and list_source_directory for reference/inspiration.
STEP 3 — Choose EXACTLY ONE specific, focused improvement:
  • Affect 1–3 files maximum
  • Improve real functionality, robustness, clarity, or user experience
  • Must be compatible with the existing architecture
STEP 4 — Implement the improvement now using write_file or edit_file.
STEP 5 — Output a one-line summary: "Enhancement: <what you implemented>"`

const PHASE_B_PROMPT = cycle => `You are running self-improvement cycle #${cycle}, Phase B.
Your task: improve the primary BLUSWAN repository.

STEP 1 — Explore bluswan using list_directory and read_file (bluswan is your write target).
STEP 2 — Optionally read bluswan2 using read_source_file and list_source_directory for reference.
STEP 3 — Choose EXACTLY ONE specific, focused improvement:
  • Affect 1–3 files maximum
  • Improve real functionality, robustness, clarity, or user experience
  • Must be compatible with the existing architecture
STEP 4 — Implement the improvement now using write_file or edit_file.
STEP 5 — Output a one-line summary: "Enhancement: <what you implemented>"`

// ── Clone operation ───────────────────────────────────────────────────────────
// Copies all files from src repo to dst repo.
// src/dst: { token, owner, repo, branch }

async function cloneRepo(src, dst, onProgress, signal) {
  const files = []

  async function crawl(path) {
    if (signal?.aborted) throw new Error('Aborted')
    let entries
    try {
      entries = await listDirectory(src.token, src.owner, src.repo, path, src.branch)
    } catch { return }

    for (const entry of entries) {
      if (signal?.aborted) throw new Error('Aborted')
      if (entry.type === 'dir') {
        await crawl(entry.path || `${path ? path + '/' : ''}${entry.name}`)
      } else {
        files.push(entry.path || `${path ? path + '/' : ''}${entry.name}`)
      }
    }
  }

  onProgress?.({ msg: 'Listing source files…', filesTotal: 0 })
  await crawl('')
  onProgress?.({ msg: `Copying ${files.length} files…`, filesTotal: files.length, filesDone: 0 })

  // Cap at 80 files to avoid API rate limits
  const toClone = files.slice(0, 80)
  let done = 0

  for (const filePath of toClone) {
    if (signal?.aborted) throw new Error('Aborted')
    try {
      const raw = await getFileContent(src.token, src.owner, src.repo, filePath, src.branch)
      if (!raw?.content) continue
      const content = decodeBase64(raw.content)
      await createOrUpdateFile(
        dst.token, dst.owner, dst.repo, filePath, content,
        `sync: ${src.owner}/${src.repo} → ${dst.owner}/${dst.repo}`,
        dst.branch,
      )
    } catch { /* skip files that fail */ }
    done++
    onProgress?.({ msg: `Copied ${done}/${toClone.length} files`, filesTotal: toClone.length, filesDone: done })
  }

  return { filesCopied: done, filesTotal: toClone.length }
}

// ── Reindex helper ────────────────────────────────────────────────────────────

async function reindex(ctx, token, owner, repo, branch, onStatus) {
  return new Promise(resolve => {
    ctx.startIndexing(token, owner, repo, branch, () => {
      onStatus?.(ctx.statusSummary())
      if (!ctx.isIndexing) resolve()
    })
    // Also resolve after 30s if indexing never finishes
    setTimeout(resolve, 30000)
  })
}

// ── Main cycle runner ─────────────────────────────────────────────────────────

/**
 * @param {object} config
 *   .mainRepo       { token, owner, repo, branch }
 *   .repo2          { token, owner, repo, branch }
 *   .modelConfig    { model, apiKey, … }
 *   .webSearchApiKey string | null
 *   .maxCycles      number (default 100)
 * @param {object} callbacks
 *   .onStep(info)   Called at each step change: { cycle, step, phase, msg }
 *   .onEvent(e)     Called for each agent event (text_delta, tool_start, etc.)
 *   .onLog(entry)   Called when an enhancement is logged: { cycle, phase, description, timestamp }
 *   .onCloneProgress(info)  { msg, filesTotal, filesDone }
 *   .onCycleEnd(cycle)
 *   .onAbortCheck() → boolean — return true to abort
 */
export async function runSelfImproveLoop(config, callbacks) {
  const {
    mainRepo, repo2,
    modelConfig, webSearchApiKey,
    maxCycles = 100,
  } = config

  const {
    onStep, onEvent, onLog, onCloneProgress,
    onCycleEnd, onAbortCheck,
  } = callbacks

  const signal = config.signal

  function step(cycle, stepNum, phase, msg) {
    onStep?.({ cycle, step: stepNum, phase, msg })
  }

  function aborted() {
    return signal?.aborted || onAbortCheck?.()
  }

  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    if (aborted()) break

    // ── Phase A: bluswan's agent improves bluswan2 ────────────────────────────

    step(cycle, 1, 'A', 'Analyzing bluswan2 for an enhancement…')

    // executor: writes to bluswan2, reads bluswan as source
    const executorA = makeExecutor({
      token:         repo2.token || mainRepo.token,
      owner:         repo2.owner,
      repo:          repo2.repo,
      branch:        repo2.branch,
      webSearchApiKey,
      sourceRepoConfig: {
        token:  mainRepo.token,
        owner:  mainRepo.owner,
        repo:   mainRepo.repo,
        branch: mainRepo.branch,
      },
    })

    const sysPromptA = buildAgentSystemPrompt(
      shadowContext2.getConventions?.() || {},
      shadowContext2.getBluswanMd?.() || '',
      repo2.owner, repo2.repo,
      false,
      { token: mainRepo.token, owner: mainRepo.owner, repo: mainRepo.repo, branch: mainRepo.branch },
      false, !!webSearchApiKey,
    )

    let phaseAOutput = ''
    try {
      await runAgentLoop({
        task:        PHASE_A_PROMPT(cycle),
        systemPrompt: sysPromptA,
        tools:       AGENT_TOOLS,
        executeTool: executorA,
        modelConfig,
        onEvent: e => {
          if (e.type === 'text_delta') phaseAOutput += e.text
          onEvent?.({ ...e, phase: 'A', cycle, step: 2 })
        },
        signal,
      })
    } catch (e) {
      if (aborted()) break
      onEvent?.({ type: 'error', text: `Phase A error: ${e.message}`, phase: 'A', cycle })
    }

    // Extract enhancement description from output
    const descA = phaseAOutput.match(/Enhancement:\s*(.+)/)?.[1]?.trim() || 'Enhancement applied to bluswan2'
    onLog?.({ cycle, phase: 'A', description: descA, timestamp: Date.now(), target: 'bluswan2' })
    step(cycle, 3, 'A', 'bluswan2 changes committed (via agent writes)')

    if (aborted()) break

    // Re-index bluswan2
    step(cycle, 4, 'A', 'Re-indexing bluswan2…')
    await reindex(shadowContext2, repo2.token || mainRepo.token, repo2.owner, repo2.repo, repo2.branch, null)

    if (aborted()) break

    // Clone bluswan2 → bluswan
    step(cycle, 5, 'A', 'Cloning bluswan2 → bluswan…')
    try {
      await cloneRepo(
        { ...repo2, token: repo2.token || mainRepo.token },
        mainRepo,
        info => { onCloneProgress?.({ ...info, phase: 'A' }); onEvent?.({ type: 'text_delta', text: `\n${info.msg}`, phase: 'A', step: 5 }) },
        signal,
      )
    } catch (e) {
      if (aborted()) break
      onEvent?.({ type: 'error', text: `Clone A→main error: ${e.message}`, phase: 'A', cycle })
    }

    step(cycle, 6, 'A', 'bluswan updated (clone complete)')
    step(cycle, 7, 'A', 'Re-indexing bluswan…')
    await reindex(shadowContext, mainRepo.token, mainRepo.owner, mainRepo.repo, mainRepo.branch, null)

    if (aborted()) break

    // ── Phase B: bluswan2's agent improves bluswan ────────────────────────────

    step(cycle, 8, 'B', 'Analyzing bluswan for an enhancement…')

    const executorB = makeExecutor({
      token:  mainRepo.token,
      owner:  mainRepo.owner,
      repo:   mainRepo.repo,
      branch: mainRepo.branch,
      webSearchApiKey,
      sourceRepoConfig: {
        token:  repo2.token || mainRepo.token,
        owner:  repo2.owner,
        repo:   repo2.repo,
        branch: repo2.branch,
      },
    })

    const sysPromptB = buildAgentSystemPrompt(
      shadowContext.getConventions?.() || {},
      shadowContext.getBluswanMd?.() || '',
      mainRepo.owner, mainRepo.repo,
      false,
      { token: repo2.token || mainRepo.token, owner: repo2.owner, repo: repo2.repo, branch: repo2.branch },
      false, !!webSearchApiKey,
    )

    let phaseBOutput = ''
    try {
      await runAgentLoop({
        task:         PHASE_B_PROMPT(cycle),
        systemPrompt: sysPromptB,
        tools:        AGENT_TOOLS,
        executeTool:  executorB,
        modelConfig,
        onEvent: e => {
          if (e.type === 'text_delta') phaseBOutput += e.text
          onEvent?.({ ...e, phase: 'B', cycle, step: 9 })
        },
        signal,
      })
    } catch (e) {
      if (aborted()) break
      onEvent?.({ type: 'error', text: `Phase B error: ${e.message}`, phase: 'B', cycle })
    }

    const descB = phaseBOutput.match(/Enhancement:\s*(.+)/)?.[1]?.trim() || 'Enhancement applied to bluswan'
    onLog?.({ cycle, phase: 'B', description: descB, timestamp: Date.now(), target: 'bluswan' })
    step(cycle, 10, 'B', 'bluswan changes committed (via agent writes)')

    if (aborted()) break

    step(cycle, 11, 'B', 'Re-indexing bluswan…')
    await reindex(shadowContext, mainRepo.token, mainRepo.owner, mainRepo.repo, mainRepo.branch, null)

    if (aborted()) break

    // Clone bluswan → bluswan2
    step(cycle, 12, 'B', 'Cloning bluswan → bluswan2…')
    try {
      await cloneRepo(
        mainRepo,
        { ...repo2, token: repo2.token || mainRepo.token },
        info => { onCloneProgress?.({ ...info, phase: 'B' }); onEvent?.({ type: 'text_delta', text: `\n${info.msg}`, phase: 'B', step: 12 }) },
        signal,
      )
    } catch (e) {
      if (aborted()) break
      onEvent?.({ type: 'error', text: `Clone main→B error: ${e.message}`, phase: 'B', cycle })
    }

    step(cycle, 13, 'B', 'bluswan2 updated (clone complete)')
    step(cycle, 14, 'B', 'Re-indexing bluswan2…')
    await reindex(shadowContext2, repo2.token || mainRepo.token, repo2.owner, repo2.repo, repo2.branch, null)

    onCycleEnd?.(cycle)
    if (aborted()) break
  }
}

// ── Repo validator ────────────────────────────────────────────────────────────

export async function validateRepo(token, owner, repo, branch = 'main') {
  try {
    const entries = await listDirectory(token, owner, repo, '', branch)
    return { valid: true, fileCount: entries.length }
  } catch (e) {
    return { valid: false, error: e.message }
  }
}
