import { encodeBase64, decodeBase64 } from '../utils/base64.js'

export { encodeBase64, decodeBase64 }

const GH_API = 'https://api.github.com'

async function ghFetch(token, path, options = {}) {
  const res = await fetch(`${GH_API}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })
  if (!res.ok) {
    let errMsg
    try { errMsg = (await res.json()).message } catch { errMsg = await res.text() }
    const err = new Error(`GitHub API ${res.status}: ${errMsg}`)
    err.status = res.status
    throw err
  }
  // 204 No Content has no body
  if (res.status === 204) return null
  return res.json()
}

export async function getRepo(token, owner, repo) {
  return ghFetch(token, `/repos/${owner}/${repo}`)
}

// List all repos accessible to the authenticated user, sorted by recent push.
// Fetches up to maxPages*100 repos (default: 300).
export async function listUserRepos(token, maxPages = 3) {
  const all = []
  for (let page = 1; page <= maxPages; page++) {
    const batch = await ghFetch(token, `/user/repos?sort=pushed&per_page=100&page=${page}&type=all`)
    if (!Array.isArray(batch) || batch.length === 0) break
    all.push(...batch)
    if (batch.length < 100) break
  }
  return all
}

export async function getBranch(token, owner, repo, branch) {
  return ghFetch(token, `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`)
}

export async function createBranch(token, owner, repo, newBranch, fromSha) {
  return ghFetch(token, `/repos/${owner}/${repo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({
      ref: `refs/heads/${newBranch}`,
      sha: fromSha,
    }),
  })
}

export async function getFileContent(token, owner, repo, path, ref) {
  try {
    return await ghFetch(token, `/repos/${owner}/${repo}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`)
  } catch (err) {
    if (err.status === 404) return null
    throw err
  }
}

// encodeBase64 imported from utils/base64.js above

export async function createOrUpdateFile(token, owner, repo, path, content, message, branch, sha) {
  const body = {
    message,
    content: encodeBase64(content),
    branch,
  }
  if (sha) body.sha = sha
  return ghFetch(token, `/repos/${owner}/${repo}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export async function deleteFile(token, owner, repo, path, sha, message, branch) {
  return ghFetch(token, `/repos/${owner}/${repo}/contents/${path}`, {
    method: 'DELETE',
    body: JSON.stringify({ message, sha, branch }),
  })
}

export async function createPullRequest(token, owner, repo, title, head, base, body) {
  return ghFetch(token, `/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    body: JSON.stringify({ title, head, base, body }),
  })
}

export async function listBranches(token, owner, repo) {
  return ghFetch(token, `/repos/${owner}/${repo}/branches?per_page=50`)
}

// Returns the last N commit SHAs that touched a specific file path (Claude Code-style revert).
// Uses the GitHub Commits API with path filtering.
export async function listFileCommits(token, owner, repo, path, branch, n = 2) {
  try {
    const encoded = encodeURIComponent(branch)
    const data = await ghFetch(token, `/repos/${owner}/${repo}/commits?path=${encodeURIComponent(path)}&sha=${encoded}&per_page=${Math.min(n, 10)}`)
    if (!Array.isArray(data)) return []
    return data.map(c => ({ sha: c.sha, message: c.commit?.message?.split('\n')[0] || '' }))
  } catch {
    return []
  }
}

// List files in a directory (skips binaries and large files)
export async function getDirectoryContents(token, owner, repo, dirPath, branch = 'main') {
  try {
    const encodedRef = encodeURIComponent(branch)
    const apiPath = dirPath
      ? `/repos/${owner}/${repo}/contents/${dirPath}?ref=${encodedRef}`
      : `/repos/${owner}/${repo}/contents?ref=${encodedRef}`
    const items = await ghFetch(token, apiPath)
    if (!Array.isArray(items)) return []
    return items.filter(f => f.type === 'file' && f.size < 60000)
  } catch {
    return []
  }
}

// List a directory's contents (files + subdirectories), sorted dirs-first.
// Paginates through all pages (GitHub returns ≤100 items per request by default).
export async function listDirectory(token, owner, repo, dirPath, branch = 'main') {
  try {
    const base = dirPath
      ? `/repos/${owner}/${repo}/contents/${dirPath}`
      : `/repos/${owner}/${repo}/contents`
    const ref = encodeURIComponent(branch)

    const all = []
    let page = 1
    while (true) {
      const items = await ghFetch(token, `${base}?ref=${ref}&per_page=100&page=${page}`)
      if (!Array.isArray(items) || items.length === 0) break
      all.push(...items.filter(f => f.type === 'file' || f.type === 'dir'))
      if (items.length < 100) break   // last page
      page++
    }

    return all
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      .map(f => ({ name: f.name, path: f.path, type: f.type, size: f.size ?? null }))
  } catch {
    return []
  }
}

// Fetch sibling files in the same directory as targetPath for codebase context
export async function fetchContextFiles(token, owner, repo, targetPath, branch = 'main', maxFiles = 4) {
  const parts = targetPath.replace(/^\//, '').split('/')
  const fileName = parts.pop()
  const dirPath = parts.join('/')

  const siblings = await getDirectoryContents(token, owner, repo, dirPath, branch)
  const codeExts = /\.(js|jsx|ts|tsx|py|go|rs|java|rb|css|json)$/
  const relevant = siblings
    .filter(f => f.name !== fileName && codeExts.test(f.name))
    .slice(0, maxFiles)

  const results = await Promise.allSettled(
    relevant.map(f =>
      getFileContent(token, owner, repo, f.path, branch).then(c => {
        if (!c?.content) return null
        try {
          const content = atob(c.content.replace(/\n/g, ''))
          return { path: f.path, content: content.slice(0, 4000) }
        } catch {
          return null
        }
      })
    )
  )
  return results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value)
}

// ── GitHub Actions CI monitoring ─────────────────────────────────────────────
// Returns the most recent workflow runs for a branch (requires actions:read, usually
// included in repo-scoped PATs). Returns null on any error (e.g. no Actions enabled).
export async function getWorkflowRuns(token, owner, repo, branch, perPage = 3, workflowId) {
  try {
    const params = new URLSearchParams({ branch, per_page: String(perPage), event: 'push' })
    if (workflowId) params.set('workflow_id', String(workflowId))
    return await ghFetch(token, `/repos/${owner}/${repo}/actions/runs?${params.toString()}`)
  } catch { return null }
}

// Returns a single workflow run by id (for polling)
export async function getWorkflowRun(token, owner, repo, runId) {
  try {
    return await ghFetch(token, `/repos/${owner}/${repo}/actions/runs/${runId}`)
  } catch { return null }
}

// List workflows in this repo (requires actions:read)
export async function listWorkflows(token, owner, repo) {
  try {
    return await ghFetch(token, `/repos/${owner}/${repo}/actions/workflows`)
  } catch { return null }
}

// Dispatch a workflow run (requires actions:write on workflow_dispatch–enabled workflow)
export async function dispatchWorkflow(token, owner, repo, workflowId, ref, inputs = {}) {
  try {
    return await ghFetch(token, `/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({ ref, inputs }),
    })
  } catch { return null }
}

// Rerun an existing workflow run (requires actions:write)
export async function rerunWorkflow(token, owner, repo, runId) {
  try {
    return await ghFetch(token, `/repos/${owner}/${repo}/actions/runs/${runId}/rerun`, {
      method: 'POST',
    })
  } catch { return null }
}

// Generate a branch name: bluswan/{timestamp}-{slug}-{shortId}
export function generateBranchName(prompt) {
  const ts = Date.now()
  const shortId = Math.random().toString(36).slice(2, 7)
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join('-')
  return `bluswan/${ts}-${slug}-${shortId}`
}
