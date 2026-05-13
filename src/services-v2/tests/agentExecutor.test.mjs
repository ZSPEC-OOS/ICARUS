import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeExecutor } from '../agentExecutor.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFs(files = {}) {
  return {
    fsRead: async (path) => {
      if (path in files) return files[path];
      throw new Error(`ENOENT: ${path}`);
    },
    fsWrite: async (path, content) => { files[path] = content; },
    fsEdit: async (path, oldStr, newStr) => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      files[path] = files[path].replace(oldStr, newStr);
    },
    fsDelete: async (path) => { delete files[path]; },
    fsList: async (dir) => Object.keys(files).filter(k => k.startsWith(dir)),
    fsSearch: async (dir, pattern) => Object.keys(files).filter(k => k.includes(pattern)),
    fsGrep: async (pattern, path) => {
      const content = files[path] ?? '';
      return content.split('\n').filter(l => l.includes(pattern));
    },
  };
}

// ─── makeExecutor tests ───────────────────────────────────────────────────────

describe('makeExecutor', () => {
  it('returns a function', () => {
    const exec = makeExecutor({});
    assert.equal(typeof exec, 'function');
  });

  it('returns ERROR for unknown tool', async () => {
    const exec = makeExecutor({});
    const result = await exec('unknown_tool_xyz', {});
    assert.ok(result.startsWith('ERROR:'));
    assert.ok(result.includes('unknown_tool_xyz'));
  });
});

// ─── read_file tests ──────────────────────────────────────────────────────────

describe('executeTool: read_file', () => {
  it('reads file content', async () => {
    const fs = makeFs({ 'src/foo.js': 'const x = 1;\nconst y = 2;' });
    const exec = makeExecutor(fs);
    const result = await exec('read_file', { path: 'src/foo.js' });
    assert.ok(result.includes('const x = 1;'));
  });

  it('returns ERROR when file not found', async () => {
    const fs = makeFs({});
    const exec = makeExecutor(fs);
    const result = await exec('read_file', { path: 'missing.js' });
    assert.ok(result.startsWith('ERROR:'));
  });

  it('truncates at 500 lines', async () => {
    const longFile = Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n');
    const fs = makeFs({ 'big.js': longFile });
    const exec = makeExecutor(fs);
    const result = await exec('read_file', { path: 'big.js' });
    assert.ok(result.includes('[...truncated at 500 lines]'));
    // Should not include line 500 (0-indexed)
    assert.ok(!result.includes('line 500'));
  });

  it('returns ERROR when not configured', async () => {
    const exec = makeExecutor({});
    const result = await exec('read_file', { path: 'x.js' });
    assert.ok(result.startsWith('ERROR:'));
    assert.ok(result.includes('not configured'));
  });
});

// ─── read_many_files tests ────────────────────────────────────────────────────

describe('executeTool: read_many_files', () => {
  it('reads multiple files', async () => {
    const fs = makeFs({ 'a.js': 'file a', 'b.js': 'file b' });
    const exec = makeExecutor(fs);
    const result = await exec('read_many_files', { paths: ['a.js', 'b.js'] });
    assert.ok(result.includes('file a'));
    assert.ok(result.includes('file b'));
    assert.ok(result.includes('=== a.js ==='));
  });

  it('caps at 5 files', async () => {
    const files = {};
    for (let i = 0; i < 8; i++) files[`f${i}.js`] = `content ${i}`;
    const fs = makeFs(files);
    const exec = makeExecutor(fs);
    const paths = Object.keys(files);
    const result = await exec('read_many_files', { paths });
    // Only 5 files processed — count "=== f" occurrences
    const count = (result.match(/=== f/g) || []).length;
    assert.ok(count <= 5, `Expected at most 5 file headers, got ${count}`);
  });

  it('returns ERROR for missing paths', async () => {
    const exec = makeExecutor({ fsRead: async () => '' });
    const result = await exec('read_many_files', { paths: [] });
    assert.ok(result.startsWith('ERROR:'));
  });

  it('includes error inline for unreadable file', async () => {
    const fs = makeFs({ 'ok.js': 'ok' });
    const exec = makeExecutor(fs);
    const result = await exec('read_many_files', { paths: ['ok.js', 'missing.js'] });
    assert.ok(result.includes('ok'));
    assert.ok(result.includes('ERROR:'));
  });
});

// ─── write_file tests ─────────────────────────────────────────────────────────

describe('executeTool: write_file', () => {
  it('writes content and returns confirmation', async () => {
    const files = {};
    const fs = makeFs(files);
    const exec = makeExecutor(fs);
    const result = await exec('write_file', { path: 'out.js', content: 'const a = 1;' });
    assert.ok(result.includes('out.js'));
    assert.equal(files['out.js'], 'const a = 1;');
  });

  it('does NOT throw — error becomes ERROR string', async () => {
    const exec = makeExecutor({
      fsWrite: async () => { throw new Error('disk full'); },
    });
    const result = await exec('write_file', { path: 'x.js', content: '' });
    assert.ok(result.startsWith('ERROR:'));
    assert.ok(result.includes('disk full'));
  });
});

// ─── edit_file tests ──────────────────────────────────────────────────────────

describe('executeTool: edit_file', () => {
  it('edits file successfully', async () => {
    const files = { 'src/x.js': 'const a = 1;\nconst b = 2;' };
    const fs = makeFs(files);
    const exec = makeExecutor(fs);
    const result = await exec('edit_file', { path: 'src/x.js', old_str: 'const a = 1;', new_str: 'const a = 99;' });
    assert.ok(result.includes('edited'));
    assert.ok(files['src/x.js'].includes('const a = 99;'));
  });

  it('returns ERROR when old_str not found', async () => {
    const files = { 'src/x.js': 'const a = 1;' };
    const fs = makeFs(files);
    const exec = makeExecutor(fs);
    const result = await exec('edit_file', { path: 'src/x.js', old_str: 'missing string', new_str: 'replacement' });
    assert.ok(result.startsWith('ERROR:'));
    assert.ok(result.includes('not found') || result.includes('old_str'));
  });

  it('returns ERROR when old_str missing from input', async () => {
    const fs = makeFs({ 'x.js': 'content' });
    const exec = makeExecutor(fs);
    const result = await exec('edit_file', { path: 'x.js', new_str: 'x' });
    assert.ok(result.startsWith('ERROR:'));
    assert.ok(result.includes('old_str'));
  });
});

// ─── delete_file tests ────────────────────────────────────────────────────────

describe('executeTool: delete_file', () => {
  it('deletes a file and confirms', async () => {
    const files = { 'tmp.js': 'tmp' };
    const fs = makeFs(files);
    const exec = makeExecutor(fs);
    const result = await exec('delete_file', { path: 'tmp.js' });
    assert.ok(result.includes('deleted'));
    assert.ok(!('tmp.js' in files));
  });
});

// ─── list_directory tests ─────────────────────────────────────────────────────

describe('executeTool: list_directory', () => {
  it('lists files in directory', async () => {
    const fs = makeFs({ 'src/a.js': '', 'src/b.js': '', 'other/c.js': '' });
    const exec = makeExecutor(fs);
    const result = await exec('list_directory', { path: 'src' });
    assert.ok(result.includes('src/a.js'));
    assert.ok(result.includes('src/b.js'));
  });
});

// ─── search_files tests ───────────────────────────────────────────────────────

describe('executeTool: search_files', () => {
  it('returns matching file paths', async () => {
    const fs = makeFs({ 'src/auth.js': '', 'src/auth.test.js': '', 'src/utils.js': '' });
    const exec = makeExecutor(fs);
    const result = await exec('search_files', { path: 'src', pattern: 'auth' });
    assert.ok(result.includes('auth'));
  });

  it('caps at 20 results', async () => {
    const files = {};
    for (let i = 0; i < 30; i++) files[`src/file-${i}.js`] = '';
    const exec = makeExecutor({
      fsSearch: async () => Object.keys(files),
    });
    const result = await exec('search_files', { path: 'src', pattern: 'file' });
    const count = result.split('\n').filter(Boolean).length;
    assert.ok(count <= 20, `Expected ≤20 results, got ${count}`);
  });

  it('returns ERROR when not configured', async () => {
    const exec = makeExecutor({});
    const result = await exec('search_files', { path: 'src', pattern: 'x' });
    assert.ok(result.startsWith('ERROR:'));
  });
});

// ─── grep tests ───────────────────────────────────────────────────────────────

describe('executeTool: grep', () => {
  it('returns matching lines', async () => {
    const fs = makeFs({ 'src/x.js': 'function foo() {}\nfunction bar() {}\nconst baz = 1;' });
    const exec = makeExecutor(fs);
    const result = await exec('grep', { pattern: 'function', path: 'src/x.js' });
    assert.ok(result.includes('function foo'));
    assert.ok(result.includes('function bar'));
    assert.ok(!result.includes('const baz'));
  });

  it('caps at 50 results', async () => {
    const lines = Array.from({ length: 80 }, (_, i) => `match line ${i}`).join('\n');
    const fs = makeFs({ 'big.js': lines });
    const exec = makeExecutor(fs);
    const result = await exec('grep', { pattern: 'match', path: 'big.js' });
    const matchCount = (result.match(/match line/g) || []).length;
    assert.ok(matchCount <= 50, `Expected ≤50 results, got ${matchCount}`);
  });
});

// ─── run_command tests ────────────────────────────────────────────────────────

describe('executeTool: run_command', () => {
  it('returns command output', async () => {
    const exec = makeExecutor({
      runCommand: async () => 'all tests passed',
    });
    const result = await exec('run_command', { command: 'npm test' });
    assert.ok(result.includes('all tests passed'));
  });

  it('truncates at 2000 chars', async () => {
    const longOutput = 'x'.repeat(3000);
    const exec = makeExecutor({
      runCommand: async () => longOutput,
    });
    const result = await exec('run_command', { command: 'cmd' });
    assert.ok(result.includes('[...truncated at 2000 chars]'));
    assert.ok(result.length < 3000);
  });

  it('returns ERROR string on command failure (no throw)', async () => {
    const exec = makeExecutor({
      runCommand: async () => { throw new Error('command not found'); },
    });
    const result = await exec('run_command', { command: 'badcmd' });
    assert.ok(result.startsWith('ERROR:'));
    assert.ok(result.includes('command not found'));
  });
});

// ─── web_fetch tests ──────────────────────────────────────────────────────────

describe('executeTool: web_fetch', () => {
  it('strips HTML tags', async () => {
    const exec = makeExecutor({
      webFetch: async () => '<html><body><p>Hello world</p></body></html>',
    });
    const result = await exec('web_fetch', { url: 'https://example.com' });
    assert.ok(!result.includes('<p>'));
    assert.ok(result.includes('Hello world'));
  });

  it('truncates at 15000 chars', async () => {
    const exec = makeExecutor({
      webFetch: async () => 'a'.repeat(20000),
    });
    const result = await exec('web_fetch', { url: 'https://example.com' });
    assert.ok(result.includes('[...truncated at 15000 chars]'));
  });
});

// ─── web_search tests ─────────────────────────────────────────────────────────

describe('executeTool: web_search', () => {
  it('returns JSON string of results', async () => {
    const exec = makeExecutor({
      webSearch: async () => [
        { title: 'Result 1', url: 'https://r1.com' },
        { title: 'Result 2', url: 'https://r2.com' },
      ],
    });
    const result = await exec('web_search', { query: 'test' });
    const parsed = JSON.parse(result);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].title, 'Result 1');
  });

  it('caps at 8 results', async () => {
    const results = Array.from({ length: 12 }, (_, i) => ({ title: `r${i}` }));
    const exec = makeExecutor({
      webSearch: async () => results,
    });
    const result = await exec('web_search', { query: 'q' });
    const parsed = JSON.parse(result);
    assert.ok(parsed.length <= 8, `Expected ≤8 results, got ${parsed.length}`);
  });
});

// ─── update_memory tests ──────────────────────────────────────────────────────

describe('executeTool: update_memory', () => {
  it('calls updateMemory and returns confirmation', async () => {
    let stored = {};
    const exec = makeExecutor({
      updateMemory: async (key, value) => { stored[key] = value; },
    });
    const result = await exec('update_memory', { key: 'foo', value: 'bar' });
    assert.ok(result.includes('foo'));
    assert.equal(stored['foo'], 'bar');
  });
});

// ─── error isolation tests ────────────────────────────────────────────────────

describe('error isolation', () => {
  it('never throws — all errors become ERROR: strings', async () => {
    const exec = makeExecutor({
      fsRead: async () => { throw new Error('catastrophic failure'); },
      fsWrite: async () => { throw new Error('write failed'); },
      runCommand: async () => { throw new Error('exec failed'); },
    });
    const tools = ['read_file', 'write_file', 'run_command'];
    for (const tool of tools) {
      let threw = false;
      let result;
      try {
        result = await exec(tool, { path: 'x.js', content: '', command: 'cmd' });
      } catch {
        threw = true;
      }
      assert.equal(threw, false, `${tool} should not throw`);
      assert.ok(result.startsWith('ERROR:'), `${tool} should return ERROR: string`);
    }
  });
});
