// ─── docsCrawlerService ────────────────────────────────────────────────────────
// On-demand docs site crawler: fetches pages, strips HTML, chunks text, and
// ingests chunks into the memory graph as searchable RAG nodes.
//
// Design goals:
//   • Non-blocking: every fetch is best-effort; failures silently skip pages
//   • Browser-safe: no Node.js APIs; plain fetch() only
//   • Idempotent: re-crawling the same domain overwrites existing nodes
//   • Cheap: caps at maxPages pages and maxCharsPerPage chars per page

const CRAWLER_DEFAULTS = {
  maxPages: 20,
  maxCharsPerPage: 8000,
  requestTimeout: 12000,
}

// ── HTML → plain text ─────────────────────────────────────────────────────────

/**
 * Strip HTML tags and decode common entities from a raw HTML string.
 * Returns readable plain text suitable for chunking.
 * @param {string} html
 * @returns {string}
 */
export function extractTextFromHtml(html) {
  if (!html) return ''
  let text = String(html)
  // Remove script, style, nav, and boilerplate blocks
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  text = text.replace(/<(nav|footer|header|aside|menu)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  // Convert block-level tags to newlines so paragraphs are preserved
  text = text.replace(/<\/(p|div|section|article|h[1-6]|li|tr|td|th|pre|blockquote)>/gi, '\n')
  text = text.replace(/<br\s*\/?>/gi, '\n')
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, ' ')
  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ')
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

// ── Text chunking ─────────────────────────────────────────────────────────────

/**
 * Split text into overlapping chunks of ~chunkSize chars, preferring paragraph
 * boundaries for cleaner RAG retrieval.
 *
 * @param {string} text
 * @param {string} url    — page URL used to build chunk IDs
 * @param {number} [chunkSize=500]
 * @returns {{ id: string, url: string, text: string }[]}
 */
export function chunkText(text, url, chunkSize = 500) {
  if (!text?.trim()) return []
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 20)
  const chunks = []
  let current = ''
  let idx = 0

  for (const para of paragraphs) {
    if (current.length + para.length > chunkSize && current.length > 0) {
      chunks.push({ id: `${url}#chunk-${idx}`, url, text: current.trim() })
      idx++
      // Overlap: carry the last sentence of the previous chunk for context continuity
      const sentences = current.split(/(?<=[.!?])\s+/)
      const lastSentence = sentences[sentences.length - 1]?.trim() || ''
      current = lastSentence ? `${lastSentence} ` : ''
    }
    current += `${para}\n\n`
  }
  if (current.trim().length > 20) {
    chunks.push({ id: `${url}#chunk-${idx}`, url, text: current.trim() })
  }
  return chunks
}

// ── Link extraction ───────────────────────────────────────────────────────────

function extractLinks(html, baseUrl) {
  const links = []
  try {
    const base = new URL(baseUrl)
    const re = /href=["']([^"'#?][^"']*?)["']/gi
    let match
    while ((match = re.exec(html)) !== null) {
      try {
        const resolved = new URL(match[1], base)
        // Only follow links on the same origin
        if (resolved.origin === base.origin) {
          links.push(resolved.href.split('#')[0].split('?')[0])
        }
      } catch {
        // Malformed URL — skip
      }
    }
  } catch {
    // Bad baseUrl — skip link extraction
  }
  return [...new Set(links)]
}

// ── Main crawl function ───────────────────────────────────────────────────────

/**
 * Crawl a documentation site starting at startUrl.
 * Fetches pages breadth-first (same domain only), strips HTML, chunks text,
 * and ingests all chunks as nodes into the memory graph.
 *
 * @param {string} startUrl      — root URL, e.g. https://axios-http.com/docs
 * @param {object} memoryGraph   — memoryGraphService singleton
 * @param {{
 *   maxPages?:        number,
 *   maxCharsPerPage?: number,
 *   requestTimeout?:  number,
 *   onProgress?:      (fetched: number, total: number, url: string) => void
 * }} [options]
 * @returns {Promise<{ domain: string, pagesFetched: number, chunksIngested: number, errors: string[] }>}
 */
export async function crawlDocsSite(startUrl, memoryGraph, options = {}) {
  const cfg = { ...CRAWLER_DEFAULTS, ...options }
  const onProgress = options.onProgress || null

  let domain
  try {
    domain = new URL(startUrl).hostname
  } catch {
    return { domain: startUrl, pagesFetched: 0, chunksIngested: 0, errors: [`Invalid URL: ${startUrl}`] }
  }

  const queue   = [startUrl]
  const visited = new Set()
  const errors  = []
  let chunkCount = 0

  while (queue.length > 0 && visited.size < cfg.maxPages) {
    const url = queue.shift()
    if (visited.has(url)) continue
    visited.add(url)
    onProgress?.(visited.size, Math.min(queue.length + visited.size, cfg.maxPages), url)

    let html
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), cfg.requestTimeout)
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'BLUSWAN-DocsCrawler/1.0', 'Accept': 'text/html' },
      })
      clearTimeout(timer)
      if (!res.ok) { errors.push(`${url}: HTTP ${res.status}`); continue }
      html = await res.text()
    } catch (err) {
      errors.push(`${url}: ${err.message}`)
      continue
    }

    const text  = extractTextFromHtml(html).slice(0, cfg.maxCharsPerPage)
    const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1]?.trim() || url
    const chunks = chunkText(text, url)

    // Ingest each text chunk as a searchable RAG node
    for (const chunk of chunks) {
      memoryGraph.upsertNode({
        id:      `docs:${chunk.id}`,
        type:    'docs',
        title:   `${title.slice(0, 60)} — ${chunk.text.slice(0, 40).replace(/\s+/g, ' ')}…`,
        path:    null,
        summary: chunk.text.slice(0, 300),
        tags:    ['docs', domain, 'crawled'],
        metadata: { url: chunk.url, domain, crawledAt: new Date().toISOString() },
        evidence: [`Crawled from ${chunk.url}`],
      })
      chunkCount++
    }

    // Page-level sentinel node lets isAlreadyCrawled() detect domain coverage
    memoryGraph.upsertNode({
      id:      `docs:page:${url}`,
      type:    'docs_page',
      title,
      path:    null,
      summary: text.slice(0, 200),
      tags:    ['docs', domain, 'crawled'],
      metadata: { url, domain, crawledAt: new Date().toISOString() },
      evidence: [`Page fetched at ${new Date().toISOString()}`],
    })

    // Enqueue same-domain links (cap fan-out per page to avoid crawling entire sites)
    const links = extractLinks(html, url).filter(l => !visited.has(l))
    queue.push(...links.slice(0, 25))
  }

  return { domain, pagesFetched: visited.size, chunksIngested: chunkCount, errors }
}

// ── Utility queries ───────────────────────────────────────────────────────────

/**
 * Returns true if docs for this domain are already in the memory graph index.
 * @param {object} memoryGraph
 * @param {string} domain — e.g. 'axios-http.com'
 */
export function isAlreadyCrawled(memoryGraph, domain) {
  try {
    const results = memoryGraph.querySemantic({ query: `docs ${domain}`, limit: 3 })
    return results.some(r => r?.tags?.includes(domain))
  } catch { return false }
}

/**
 * Return all crawled documentation domains with chunk counts and crawl timestamps.
 * @param {object} memoryGraph
 * @returns {{ domain: string, chunks: number, lastCrawled: string }[]}
 */
export function listCrawledSites(memoryGraph) {
  try {
    const allNodes = memoryGraph.snapshot().nodes
    const domainMap = new Map()
    for (const node of allNodes) {
      if (node.type !== 'docs' && node.type !== 'docs_page') continue
      const d = node.metadata?.domain
      if (!d) continue
      const entry = domainMap.get(d) || { domain: d, chunks: 0, lastCrawled: '' }
      if (node.type === 'docs') entry.chunks++
      const ts = node.metadata?.crawledAt || ''
      if (ts > entry.lastCrawled) entry.lastCrawled = ts
      domainMap.set(d, entry)
    }
    return [...domainMap.values()].sort((a, b) => b.lastCrawled.localeCompare(a.lastCrawled))
  } catch { return [] }
}
