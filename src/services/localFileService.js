// ─── localFileService.js ──────────────────────────────────────────────────────
// File System Access API utilities for reading and writing local repo folders.
// Requires a browser that supports window.showDirectoryPicker (Chrome / Edge).

const SKIP = new Set(['.git', 'node_modules', 'dist', '.next', 'build', '__pycache__', '.cache'])

function supported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

// ── Pick a local folder ───────────────────────────────────────────────────────

export async function pickDirectory() {
  if (!supported()) {
    throw new Error('File System Access API is not available. Use Chrome or Edge.')
  }
  return window.showDirectoryPicker({ mode: 'readwrite' })
}

// ── Navigate to a sub-path within a handle ────────────────────────────────────

async function resolve(dirHandle, path) {
  if (!path) return dirHandle
  let cur = dirHandle
  for (const part of path.split('/').filter(Boolean)) {
    cur = await cur.getDirectoryHandle(part)
  }
  return cur
}

// ── List directory ────────────────────────────────────────────────────────────

export async function listLocalDir(dirHandle, path = '') {
  const cur = await resolve(dirHandle, path)
  const entries = []
  for await (const [name, handle] of cur) {
    if (SKIP.has(name)) continue
    entries.push({
      name,
      type: handle.kind === 'directory' ? 'dir' : 'file',
      path: path ? `${path}/${name}` : name,
    })
  }
  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

// ── Read a file ───────────────────────────────────────────────────────────────

export async function readLocalFile(dirHandle, path) {
  const parts = path.split('/').filter(Boolean)
  let cur = dirHandle
  for (const part of parts.slice(0, -1)) {
    cur = await cur.getDirectoryHandle(part)
  }
  const fh   = await cur.getFileHandle(parts[parts.length - 1])
  const file = await fh.getFile()
  return file.text()
}

// ── Write a file ──────────────────────────────────────────────────────────────

export async function writeLocalFile(dirHandle, path, content) {
  const parts = path.split('/').filter(Boolean)
  let cur = dirHandle
  for (const part of parts.slice(0, -1)) {
    cur = await cur.getDirectoryHandle(part, { create: true })
  }
  const fh       = await cur.getFileHandle(parts[parts.length - 1], { create: true })
  const writable = await fh.createWritable()
  await writable.write(content)
  await writable.close()
}

// ── Count files (fast crawl) ──────────────────────────────────────────────────

export async function countFiles(dirHandle, max = 500) {
  let count = 0
  async function crawl(handle) {
    for await (const [name, child] of handle) {
      if (SKIP.has(name)) continue
      if (count >= max) return
      if (child.kind === 'directory') {
        await crawl(child)
      } else {
        count++
      }
    }
  }
  await crawl(dirHandle)
  return count
}
