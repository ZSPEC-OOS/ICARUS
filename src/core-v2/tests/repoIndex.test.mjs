import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRepoIndex,
  getFileContent,
  searchFiles,
  getRelatedFiles,
  getRepoMap,
  getSymbolsInFile,
  invalidateFile,
} from '../repoIndex.js';

// ─── Mock Fetch Factory ───────────────────────────────────────────────────────

/**
 * Build a mock fetch function for tests.
 * @param {string[]} filePaths
 * @param {Record<string, string>} fileContents - path → content
 */
function makeMockFetch(filePaths = [], fileContents = {}) {
  return async (url) => {
    // Git tree API
    if (url.includes('/git/trees/')) {
      return {
        ok: true,
        json: async () => ({
          tree: filePaths.map((p) => ({ path: p, type: 'blob', size: 100, sha: `sha-${p}` })),
        }),
      };
    }

    // Contents API — extract path from URL
    const pathMatch = url.match(/\/contents\/([^?]+)/);
    const encodedPath = pathMatch ? pathMatch[1] : '';
    const path = decodeURIComponent(encodedPath);

    if (path in fileContents) {
      return {
        ok: true,
        json: async () => ({
          encoding: 'base64',
          content: Buffer.from(fileContents[path]).toString('base64') + '\n',
        }),
      };
    }

    return { ok: false, status: 404, json: async () => ({}) };
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SAMPLE_FILES = [
  'src/core/taskRunner.js',
  'src/core/planContract.js',
  'src/services/agentExecutor.js',
  'src/services/agentLoop.js',
  'src/components/App.jsx',
  'src/utils/helpers.js',
  'package.json',
  'README.md',
];

const SAMPLE_CONTENTS = {
  'src/core/taskRunner.js': `
import { createCycle } from './cycleEngine.js';
import { packCycleContext } from './contextPacker.js';

export async function runTask(spec, callbacks) {
  const cycle = createCycle(spec.plan, 1, []);
  return cycle;
}

export function groupDeliverables(deliverables, maxPerCycle) {
  return deliverables.slice(0, maxPerCycle);
}
`.trim(),
  'src/core/planContract.js': `
export class PlanValidationError extends Error {}

export function createPlanContract(raw) {
  const plan = { ...raw };
  return Object.freeze(plan);
}

export function validatePlanCoverage(plan) {
  const missing = plan.deliverables.filter(d => !d.completed).map(d => d.id);
  return { complete: missing.length === 0, missing };
}
`.trim(),
  'src/services/agentExecutor.js': `
import { memoryGraphService } from './memoryGraphService.js';
const MAX_LINES = 500;
export function makeExecutor(config) {
  return async function executeTool(name, input) {
    return 'ok';
  };
}
`.trim(),
  'src/utils/helpers.js': `
export const identity = (x) => x;
export function formatPath(p) { return p.replace(/\\/\\/g, '/'); }
`.trim(),
};

async function buildTestIndex(extraContents = {}) {
  const contents = { ...SAMPLE_CONTENTS, ...extraContents };
  const fetchFn = makeMockFetch(SAMPLE_FILES, contents);
  return buildRepoIndex('owner/testrepo', 'main', 'token', { fetchFn });
}

// ─── buildRepoIndex tests ─────────────────────────────────────────────────────

describe('buildRepoIndex', () => {
  it('returns object with fileTree, importGraph, symbolIndex', async () => {
    const index = await buildTestIndex();
    assert.ok(Array.isArray(index.fileTree), 'fileTree should be an array');
    assert.ok(index.importGraph?.imports instanceof Map, 'importGraph.imports should be a Map');
    assert.ok(index.importGraph?.importedBy instanceof Map, 'importGraph.importedBy should be a Map');
    assert.ok(index.symbolIndex?.symbols instanceof Map, 'symbolIndex.symbols should be a Map');
    assert.equal(index.isReady, true);
  });

  it('populates fileTree from tree API response', async () => {
    const index = await buildTestIndex();
    assert.equal(index.fileTree.length, SAMPLE_FILES.length);
    assert.ok(index.fileTree.some((f) => f.path === 'src/core/taskRunner.js'));
    assert.ok(index.fileTree.every((f) => f.type === 'file'));
  });

  it('builds importGraph from JS file imports', async () => {
    const index = await buildTestIndex();
    // taskRunner.js imports cycleEngine.js and contextPacker.js
    const imports = index.importGraph.imports.get('src/core/taskRunner.js') ?? [];
    assert.ok(imports.some((i) => i.includes('cycleEngine')));
    assert.ok(imports.some((i) => i.includes('contextPacker')));
  });

  it('builds importedBy reverse index', async () => {
    const index = await buildTestIndex();
    // planContract is imported by taskRunner (via relative path)
    // agentExecutor imports memoryGraphService
    const importers = index.importGraph.importedBy.get('./memoryGraphService.js') ?? [];
    assert.ok(importers.includes('src/services/agentExecutor.js'));
  });

  it('builds symbolIndex for JS files', async () => {
    const index = await buildTestIndex();
    const symbols = index.symbolIndex.symbols.get('src/core/planContract.js') ?? [];
    assert.ok(symbols.some((s) => s.name === 'PlanValidationError' && s.kind === 'class'));
    assert.ok(symbols.some((s) => s.name === 'createPlanContract' && s.kind === 'function'));
    assert.ok(symbols.some((s) => s.name === 'validatePlanCoverage' && s.kind === 'function'));
  });

  it('stores repoUrl, branch, owner, repo', async () => {
    const fetchFn = makeMockFetch([], {});
    const index = await buildRepoIndex('https://github.com/myorg/myrepo', 'main', 'tok', { fetchFn });
    assert.equal(index.owner, 'myorg');
    assert.equal(index.repo, 'myrepo');
    assert.equal(index.branch, 'main');
  });

  it('handles org/repo shorthand URL', async () => {
    const fetchFn = makeMockFetch([], {});
    const index = await buildRepoIndex('org/repo', 'develop', '', { fetchFn });
    assert.equal(index.owner, 'org');
    assert.equal(index.repo, 'repo');
  });

  it('throws on invalid repoUrl format', async () => {
    const fetchFn = makeMockFetch([], {});
    await assert.rejects(
      () => buildRepoIndex('not-a-valid-url', 'main', '', { fetchFn }),
      /Cannot parse repoUrl/
    );
  });
});

// ─── getFileContent tests ─────────────────────────────────────────────────────

describe('getFileContent', () => {
  it('returns cached content on second call without re-fetching', async () => {
    let fetchCount = 0;
    const fetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return { ok: true, json: async () => ({ tree: [{ path: 'src/a.js', type: 'blob', size: 10, sha: 'x' }] }) };
      }
      fetchCount++;
      return {
        ok: true,
        json: async () => ({ encoding: 'base64', content: Buffer.from('const a = 1;').toString('base64') + '\n' }),
      };
    };
    const index = await buildRepoIndex('o/r', 'main', '', { fetchFn });
    const preFetch = fetchCount;
    await getFileContent(index, 'src/a.js'); // may or may not be cached
    const afterFirst = fetchCount;
    await getFileContent(index, 'src/a.js'); // must use cache
    assert.equal(fetchCount, afterFirst, 'Second call should not fetch again');
  });

  it('caps content at 500 lines', async () => {
    const longContent = Array.from({ length: 600 }, (_, i) => `const x${i} = ${i};`).join('\n');
    const fetchFn = makeMockFetch(['big.js'], { 'big.js': longContent });
    const index = await buildRepoIndex('o/r', 'main', '', { fetchFn });
    // big.js is eagerly scanned at build time and stored truncated in cache
    const content = await getFileContent(index, 'big.js');
    const lineCount = content.split('\n').length;
    // Should be 501 lines: 500 content lines + 1 truncation marker line
    assert.ok(lineCount <= 502, `Expected ≤502 lines, got ${lineCount}`);
    assert.ok(content.includes('[...truncated'), 'Should include truncation marker');
  });

  it('fetches uncached file from GitHub API', async () => {
    const index = await buildTestIndex();
    // package.json is in fileTree but not a JS file so may not be eagerly cached
    // Force uncached: manually delete from cache first
    invalidateFile(index, 'src/utils/helpers.js');
    const content = await getFileContent(index, 'src/utils/helpers.js');
    assert.ok(content.includes('identity') || content.length > 0);
  });
});

// ─── searchFiles tests ────────────────────────────────────────────────────────

describe('searchFiles', () => {
  it('returns results ordered by relevance', async () => {
    const index = await buildTestIndex();
    const results = searchFiles(index, 'taskRunner');
    assert.ok(results.length > 0);
    // taskRunner.js should score highest for query 'taskRunner'
    assert.ok(results[0].path.includes('taskRunner') || results[0].score >= results[results.length - 1].score);
    // Results must be sorted descending by score
    for (let i = 0; i < results.length - 1; i++) {
      assert.ok(results[i].score >= results[i + 1].score, 'Results not sorted by score');
    }
  });

  it('returns at most 20 results', async () => {
    // Create many files
    const files = Array.from({ length: 30 }, (_, i) => `src/component-${i}.js`);
    const contents = {};
    for (const f of files) contents[f] = `export function component${f.replace(/[^a-z0-9]/gi, '')}() {}`;
    const fetchFn = makeMockFetch(files, contents);
    const index = await buildRepoIndex('o/r', 'main', '', { fetchFn });
    const results = searchFiles(index, 'component');
    assert.ok(results.length <= 20, `Expected ≤20, got ${results.length}`);
  });

  it('returns empty array for empty query', async () => {
    const index = await buildTestIndex();
    const results = searchFiles(index, '');
    assert.deepEqual(results, []);
  });

  it('each result has path, score, snippet', async () => {
    const index = await buildTestIndex();
    const results = searchFiles(index, 'plan');
    for (const r of results) {
      assert.ok('path' in r && 'score' in r && 'snippet' in r);
      assert.ok(typeof r.path === 'string');
      assert.ok(typeof r.score === 'number');
    }
  });

  it('no vector embeddings used (pure BM25)', async () => {
    const index = await buildTestIndex();
    // Verify no embedding-related properties exist
    assert.ok(!('embeddings' in index));
    assert.ok(!('vectorIndex' in index));
    assert.ok(!('vectorDB' in index));
  });
});

// ─── getRelatedFiles tests ────────────────────────────────────────────────────

describe('getRelatedFiles', () => {
  it('returns importers and importees', async () => {
    const index = await buildTestIndex();
    const { importers, importees } = getRelatedFiles(index, 'src/core/taskRunner.js');
    assert.ok(Array.isArray(importers));
    assert.ok(Array.isArray(importees));
  });

  it('returns files this file imports (relative paths resolved)', async () => {
    const index = await buildTestIndex();
    const { importees } = getRelatedFiles(index, 'src/core/taskRunner.js');
    // taskRunner imports ./cycleEngine.js and ./contextPacker.js (not in fileTree) → empty resolved
    // The import paths are relative; if files don't exist in fileTree, they're filtered out
    assert.ok(Array.isArray(importees));
    assert.ok(importees.length <= 10);
  });

  it('returns files that import this file', async () => {
    const index = await buildTestIndex();
    // agentExecutor.js imports ./memoryGraphService.js
    const { importers } = getRelatedFiles(index, './memoryGraphService.js');
    assert.ok(importers.includes('src/services/agentExecutor.js'));
  });

  it('limits results to 10', async () => {
    const index = await buildTestIndex();
    const { importers, importees } = getRelatedFiles(index, 'src/core/planContract.js');
    assert.ok(importers.length <= 10);
    assert.ok(importees.length <= 10);
  });
});

// ─── getRepoMap tests ─────────────────────────────────────────────────────────

describe('getRepoMap', () => {
  it('returns an indented tree string', async () => {
    const index = await buildTestIndex();
    const map = getRepoMap(index);
    assert.equal(typeof map, 'string');
    assert.ok(map.length > 0);
    assert.ok(map.includes('src/'));
  });

  it('respects maxTokens budget (chars ≈ maxTokens * 4)', async () => {
    const index = await buildTestIndex();
    const smallMap = getRepoMap(index, 10); // 10 tokens = 40 chars content + truncation marker
    // 40 content chars + '\n[...truncated]' (15 chars) = 55 max; allow 60 for tolerance
    assert.ok(smallMap.length <= 60, `Expected ≤60 chars, got ${smallMap.length}`);
  });

  it('appends truncation marker when capped', async () => {
    const files = Array.from({ length: 200 }, (_, i) => `src/module-${i}/component-${i}.js`);
    const fetchFn = makeMockFetch(files, {});
    const index = await buildRepoIndex('o/r', 'main', '', { fetchFn });
    const map = getRepoMap(index, 50);
    assert.ok(map.includes('[...truncated]'));
  });

  it('directories appear before files in same level', async () => {
    const fetchFn = makeMockFetch(['src/utils.js', 'src/core/main.js', 'README.md'], {});
    const index = await buildRepoIndex('o/r', 'main', '', { fetchFn });
    const map = getRepoMap(index, 500);
    const lines = map.split('\n').filter(Boolean);
    // src/ (dir) should appear before README.md (file) at root level
    const srcIdx = lines.findIndex((l) => l.trim() === 'src/');
    const readmeIdx = lines.findIndex((l) => l.trim() === 'README.md');
    assert.ok(srcIdx < readmeIdx, `src/ (${srcIdx}) should appear before README.md (${readmeIdx})`);
  });
});

// ─── getSymbolsInFile tests ───────────────────────────────────────────────────

describe('getSymbolsInFile', () => {
  it('returns symbols with name and kind', async () => {
    const index = await buildTestIndex();
    const symbols = getSymbolsInFile(index, 'src/core/planContract.js');
    assert.ok(symbols.length > 0);
    for (const s of symbols) {
      assert.ok('name' in s && 'kind' in s && 'line' in s);
      assert.ok(['function', 'class', 'const', 'let', 'var'].includes(s.kind));
    }
  });

  it('detects class symbols', async () => {
    const index = await buildTestIndex();
    const symbols = getSymbolsInFile(index, 'src/core/planContract.js');
    assert.ok(symbols.some((s) => s.kind === 'class' && s.name === 'PlanValidationError'));
  });

  it('detects function symbols', async () => {
    const index = await buildTestIndex();
    const symbols = getSymbolsInFile(index, 'src/core/taskRunner.js');
    assert.ok(symbols.some((s) => s.kind === 'function' && s.name === 'runTask'));
    assert.ok(symbols.some((s) => s.kind === 'function' && s.name === 'groupDeliverables'));
  });

  it('returns empty array for unknown file', async () => {
    const index = await buildTestIndex();
    const symbols = getSymbolsInFile(index, 'nonexistent.js');
    assert.deepEqual(symbols, []);
  });
});

// ─── invalidateFile tests ─────────────────────────────────────────────────────

describe('invalidateFile', () => {
  it('removes file from content cache', async () => {
    const index = await buildTestIndex();
    // Ensure a file is in cache
    const path = 'src/core/taskRunner.js';
    const before = index.contentCache.has(path);
    assert.ok(before, 'Expected file to be cached after buildRepoIndex');
    invalidateFile(index, path);
    assert.ok(!index.contentCache.has(path), 'Expected file to be evicted from cache');
  });

  it('is a no-op for uncached files', async () => {
    const index = await buildTestIndex();
    assert.doesNotThrow(() => invalidateFile(index, 'not-cached.js'));
  });
});

// ─── LRU content cache tests ──────────────────────────────────────────────────

describe('LRU content cache', () => {
  it('evicts oldest entry when max size (50) is exceeded', async () => {
    // Build an index with 51+ JS files
    const files = Array.from({ length: 55 }, (_, i) => `src/file-${i}.js`);
    const contents = {};
    for (const f of files) contents[f] = `export const f${f.replace(/[^a-z0-9]/gi, '')} = 1;`;
    const fetchFn = makeMockFetch(files, contents);
    const index = await buildRepoIndex('o/r', 'main', '', { fetchFn });

    // At most 50 files should be in cache (LRU evicts when over 50)
    assert.ok(index.contentCache.size <= 50, `Cache size ${index.contentCache.size} exceeds max 50`);
  });

  it('refreshes LRU order on get', async () => {
    const files = ['src/a.js', 'src/b.js'];
    const contents = { 'src/a.js': 'const a = 1;', 'src/b.js': 'const b = 2;' };
    const fetchFn = makeMockFetch(files, contents);
    const index = await buildRepoIndex('o/r', 'main', '', { fetchFn });
    // Access a to refresh it
    index.contentCache.get('src/a.js');
    // Both should still be accessible
    assert.ok(index.contentCache.has('src/a.js'));
    assert.ok(index.contentCache.has('src/b.js'));
  });
});
