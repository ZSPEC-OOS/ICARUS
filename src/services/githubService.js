import { encodeBase64, decodeBase64 } from '../utils/base64.js'

export { encodeBase64, decodeBase64 }

const GH_API = 'https://api.github.com'

async function ghFetch(token, path, options = {}) {
  const res = await fetch(`${GH_API}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token?.trim()}`,
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
// Compare two refs (branch, tag, or SHA) and return file-level diffs.
// GitHub Docs: GET /repos/{owner}/{repo}/compare/{basehead}
export async function compareCommits(token, owner, repo, base, head) {
  try {
    return await ghFetch(token, `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`)
  } catch (err) {
    throw new Error(`compareCommits failed (${base}...${head}): ${err.message}`)
  }
}

// List commits on a branch, optionally scoped to a file path.
// Returns [{sha, shortSha, message, author, date}]
export async function listCommits(token, owner, repo, branch, path = null, limit = 10) {
  try {
    const params = new URLSearchParams({ sha: branch, per_page: String(Math.min(limit, 50)) })
    if (path) params.set('path', path)
    const data = await ghFetch(token, `/repos/${owner}/${repo}/commits?${params.toString()}`)
    if (!Array.isArray(data)) return []
    return data.map(c => ({
      sha:      c.sha,
      shortSha: c.sha.slice(0, 7),
      message:  c.commit?.message?.split('\n')[0] || '',
      author:   c.commit?.author?.name || c.author?.login || 'unknown',
      date:     c.commit?.author?.date || '',
    }))
  } catch {
    return []
  }
}

// Create a GitHub issue in the repository.
export async function createIssue(token, owner, repo, title, body = '', labels = []) {
  return ghFetch(token, `/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title, body, labels }),
  })
}

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

// ── GitHub Device OAuth Flow ─────────────────────────────────────────────────
// Authenticates a browser-side SPA with GitHub without exposing any client secret.
// Requires a GitHub OAuth App (only the public client_id is used — no secret).
//
// Setup: github.com → Settings → Developer settings → OAuth Apps → New OAuth App
//   • Application name: BLUSWAN
//   • Homepage URL: your app URL
//   • Authorization callback URL: (any value — device flow doesn't redirect)
// Copy the Client ID and paste it into BLUSWAN Settings → GitHub Client ID.
//
// Scopes requested: repo (full repo access) + read:user (display username)

export async function initiateDeviceFlow(clientId) {
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope: 'repo read:user' }),
  })
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`)
  const data = await res.json()
  if (data.error) throw new Error(data.error_description || data.error)
  return data // { device_code, user_code, verification_uri, expires_in, interval }
}

// Polls until the user authorizes at github.com/login/device.
// Resolves with the access_token string; rejects on denial or expiry.
export function pollDeviceToken(clientId, deviceCode, intervalSec = 5) {
  return new Promise((resolve, reject) => {
    let delay = Math.max(intervalSec, 5) * 1000
    const poll = async () => {
      try {
        const res = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: clientId,
            device_code: deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }),
        })
        const data = await res.json()
        if (data.access_token)              { resolve(data.access_token); return }
        if (data.error === 'access_denied') { reject(new Error('Access denied')); return }
        if (data.error === 'expired_token') { reject(new Error('Code expired — try again')); return }
        if (data.error === 'slow_down')     { delay += 5000 }
        // 'authorization_pending' — keep waiting
        setTimeout(poll, delay)
      } catch (err) { reject(err) }
    }
    setTimeout(poll, delay)
  })
}

export async function getAuthenticatedUser(token) {
  return ghFetch(token, '/user')
}

// ── Issues API ────────────────────────────────────────────────────────────────

// List issues (excludes pull requests).  state: 'open' | 'closed' | 'all'
export async function listIssues(token, owner, repo, state = 'open', labels = [], limit = 20) {
  try {
    const params = new URLSearchParams({
      state,
      per_page: String(Math.min(limit, 50)),
      sort: 'updated',
      direction: 'desc',
    })
    if (labels.length) params.set('labels', labels.join(','))
    const data = await ghFetch(token, `/repos/${owner}/${repo}/issues?${params.toString()}`)
    if (!Array.isArray(data)) return []
    return data
      .filter(i => !i.pull_request)
      .map(i => ({
        number:    i.number,
        title:     i.title,
        state:     i.state,
        body:      (i.body || '').slice(0, 1000),
        labels:    (i.labels || []).map(l => l.name),
        assignees: (i.assignees || []).map(a => a.login),
        comments:  i.comments,
        createdAt: i.created_at,
        updatedAt: i.updated_at,
        url:       i.html_url,
      }))
  } catch { return [] }
}

// Fetch a single issue by number (raw GitHub response).
export async function getIssue(token, owner, repo, number) {
  return ghFetch(token, `/repos/${owner}/${repo}/issues/${number}`)
}

// Fetch comments on an issue (newest first, capped at limit).
export async function getIssueComments(token, owner, repo, number, limit = 20) {
  try {
    const data = await ghFetch(token, `/repos/${owner}/${repo}/issues/${number}/comments?per_page=${Math.min(limit, 50)}`)
    if (!Array.isArray(data)) return []
    return data.map(c => ({
      author:    c.user?.login || 'unknown',
      body:      (c.body || '').slice(0, 2000),
      createdAt: c.created_at,
    }))
  } catch { return [] }
}

// Post a comment on an issue.
export async function addIssueComment(token, owner, repo, number, body) {
  return ghFetch(token, `/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  })
}

// Close an issue.
export async function closeIssue(token, owner, repo, number) {
  return ghFetch(token, `/repos/${owner}/${repo}/issues/${number}`, {
    method: 'PATCH',
    body: JSON.stringify({ state: 'closed' }),
  })
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
