// ─── discover-skills tool ───────────────────────────────────────────────────
export const toolMeta = {
  id: 'discover-skills',
  name: 'Discover Skills',
  version: '1.0.0',
  description: 'Discover SKILL.md manifests in the indexed repository and summarize skill package metadata.',
  category: 'analysis',
  author: 'BLUSWAN',
}

function parseFrontmatter(content = '') {
  const text = String(content || '')
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return null

  const out = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*?)\s*$/)
    if (!kv) continue
    out[kv[1]] = kv[2]
  }
  return Object.keys(out).length ? out : null
}

export async function execute(input = {}, config = {}) {
  const { shadowContext } = config
  if (!shadowContext) throw new Error('shadowContext not provided in config')

  const limit = Math.max(1, Math.min(Number(input.limit) || 50, 200))
  const includeFrontmatter = !!input.include_frontmatter

  if (!shadowContext.isReady) {
    return {
      ready: false,
      indexedFiles: shadowContext.indexedFileCount?.() || 0,
      message: 'Codebase index is not ready yet. Try again after indexing completes.',
      skills: [],
    }
  }

  const raw = shadowContext.listSkillFiles?.(limit) || []
  const skills = raw.map(entry => {
    const info = { ...entry }
    if (includeFrontmatter) {
      const full = shadowContext._contentIndex?.[entry.path]?.full || ''
      info.frontmatter = parseFrontmatter(full)
    }
    return info
  })

  return {
    ready: true,
    indexedFiles: shadowContext.indexedFileCount?.() || 0,
    count: skills.length,
    skills,
    recommendations: skills.length
      ? [
          'Use SKILL.md instructions before implementing domain-specific tasks.',
          'Prefer scripts/assets referenced from the selected skill root when present.',
        ]
      : [
          'No SKILL.md files found in index. Add skill packages under .claude/skills/<name>/SKILL.md or a project skills directory.',
        ],
  }
}

export async function test() {
  const fakeShadow = {
    isReady: true,
    indexedFileCount: () => 42,
    listSkillFiles: () => ([
      { path: '.claude/skills/skill-installer/SKILL.md', skillRoot: '.claude/skills/skill-installer', hasScripts: true, hasAssets: false, hasReferences: true },
    ]),
    _contentIndex: {
      '.claude/skills/skill-installer/SKILL.md': {
        full: '---\nname: skill-installer\ndescription: install skills\n---\n# Skill Installer',
      },
    },
  }

  const result = await execute({ include_frontmatter: true }, { shadowContext: fakeShadow })
  if (!result.ready) return { passed: false, message: 'Expected ready=true' }
  if (result.count !== 1) return { passed: false, message: 'Expected one skill' }
  if (result.skills[0]?.frontmatter?.name !== 'skill-installer') return { passed: false, message: 'Expected parsed frontmatter.name' }
  return { passed: true, message: 'discover-skills self-test passed.' }
}
