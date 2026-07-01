'use strict';

const { describe, expect, test, afterAll, setDefaultTimeout } = require('bun:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { evaluateGate, isDocPath } = require('../../lib/doc-gate/gate');
const { detect } = require('../../lib/doc-gate/detect');

// Each test spins up real git fixtures; raise the default so parallel disk I/O
// on slower/Windows CI does not trip the 5s default.
setDefaultTimeout(30000);

const createdDirs = [];

function gitq(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'ignore', 'ignore'] });
}
function gitOut(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}
function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}
function makeGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gate-'));
  createdDirs.push(dir);
  gitq(dir, ['init', '-q']);
  gitq(dir, ['config', 'user.email', 'test@example.com']);
  gitq(dir, ['config', 'user.name', 'Test']);
  gitq(dir, ['config', 'commit.gpgsign', 'false']);
  gitq(dir, ['config', 'core.autocrlf', 'false']);
  return dir;
}
function commitAll(dir, msg) {
  gitq(dir, ['add', '-A']);
  gitq(dir, ['commit', '-q', '-m', msg]);
  return gitOut(dir, ['rev-parse', 'HEAD']);
}
/** Build a base commit, then a head commit that applies { write, remove }. */
function twoCommit(baseFiles, mutations = {}) {
  const dir = makeGitRepo();
  writeFiles(dir, baseFiles);
  const base = commitAll(dir, 'base');
  if (mutations.write) writeFiles(dir, mutations.write);
  if (mutations.remove) {
    for (const rel of mutations.remove) fs.rmSync(path.join(dir, rel), { force: true });
  }
  const head = commitAll(dir, 'head');
  return { dir, base, head };
}
/** Build a single base commit (for changedFiles-driven tests). */
function baseOnly(baseFiles) {
  const dir = makeGitRepo();
  writeFiles(dir, baseFiles);
  commitAll(dir, 'base');
  return dir;
}

// A fixture that the detector resolves fully (source + toolchain + changelog + ci)
// so the gate reaches an enforce (CODE-RESOLVED) decision rather than abstaining.
const RESOLVED_JS_BASE = {
  'package.json': '{"name":"x","version":"1.0.0"}\n',
  'package-lock.json': '{}\n',
  'lib/index.js': 'module.exports = 1;\n',
  'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n',
  '.github/workflows/ci.yml': 'name: ci\non: [push]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: []\n',
};
const RESOLVED_GO_BASE = {
  'go.mod': 'module example.com/foo\n\ngo 1.21\n',
  'go.sum': '\n',
  'main.go': 'package main\n\nfunc main() {}\n',
  'internal/helper.go': 'package internal\n',
  'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n',
  '.github/workflows/ci.yml': 'name: ci\non: [push]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: []\n',
};

afterAll(() => {
  for (const dir of createdDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('evaluateGate — real git diff (base...head) path', () => {
  test('sanity: the resolved JS fixture is CODE-RESOLVED', () => {
    const dir = baseOnly(RESOLVED_JS_BASE);
    expect(detect(dir).verdict).toBe('CODE-RESOLVED');
  });

  test('(a) code change under source with NO doc → fail', () => {
    const { dir, base, head } = twoCommit(RESOLVED_JS_BASE, {
      write: { 'lib/index.js': 'module.exports = 2;\n' },
    });
    const r = evaluateGate({ root: dir, base, head });
    expect(r.decision).toBe('fail');
    expect(r.verdict).toBe('CODE-RESOLVED');
    expect(r.offendingCodeFiles).toContain('lib/index.js');
    expect(r.docChangesSeen).toEqual([]);
  });

  test('(b) code change + CHANGELOG update → pass', () => {
    const { dir, base, head } = twoCommit(RESOLVED_JS_BASE, {
      write: {
        'lib/index.js': 'module.exports = 2;\n',
        'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n- change\n',
      },
    });
    const r = evaluateGate({ root: dir, base, head });
    expect(r.decision).toBe('pass');
    expect(r.docChangesSeen).toContain('CHANGELOG.md');
    expect(r.offendingCodeFiles).toEqual([]);
  });

  test('(b2) code change + new docs/ file → pass', () => {
    const { dir, base, head } = twoCommit(RESOLVED_JS_BASE, {
      write: {
        'lib/index.js': 'module.exports = 2;\n',
        'docs/guide.md': '# Guide\n',
      },
    });
    const r = evaluateGate({ root: dir, base, head });
    expect(r.decision).toBe('pass');
    expect(r.docChangesSeen).toContain('docs/guide.md');
  });

  test('(c) doc-only change → pass', () => {
    const { dir, base, head } = twoCommit(RESOLVED_JS_BASE, {
      write: { 'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n- only docs\n' },
    });
    const r = evaluateGate({ root: dir, base, head });
    expect(r.decision).toBe('pass');
    expect(r.offendingCodeFiles).toEqual([]);
  });

  test('rename of a source file (R100) counts as a code change → fail', () => {
    const dir = makeGitRepo();
    writeFiles(dir, RESOLVED_JS_BASE);
    const base = commitAll(dir, 'base');
    gitq(dir, ['mv', 'lib/index.js', 'lib/renamed.js']);
    const head = commitAll(dir, 'rename');
    const r = evaluateGate({ root: dir, base, head });
    expect(r.decision).toBe('fail');
    expect(r.offendingCodeFiles).toContain('lib/renamed.js');
  });

  test('deleting a source file (no A/M) → pass (deletions do not require docs)', () => {
    // Keep lib/index.js so the source surface still resolves on HEAD; only the
    // extra file is deleted, so the diff carries a D (never an A/M) code entry.
    const { dir, base, head } = twoCommit(
      { ...RESOLVED_JS_BASE, 'lib/extra.js': 'module.exports = 9;\n' },
      { remove: ['lib/extra.js'] },
    );
    const r = evaluateGate({ root: dir, base, head });
    expect(r.decision).toBe('pass');
  });
});

describe('evaluateGate — flat-root source:["."] (top-level, non-config only)', () => {
  test('sanity: the resolved Go fixture is CODE-RESOLVED with source ["."]', () => {
    const dir = baseOnly(RESOLVED_GO_BASE);
    const d = detect(dir);
    expect(d.verdict).toBe('CODE-RESOLVED');
    expect(d.source.value).toEqual(['.']);
  });

  test('top-level .go change with no doc → fail', () => {
    const { dir, base, head } = twoCommit(RESOLVED_GO_BASE, {
      write: { 'main.go': 'package main\n\nfunc main() { _ = 1 }\n' },
    });
    const r = evaluateGate({ root: dir, base, head });
    expect(r.decision).toBe('fail');
    expect(r.offendingCodeFiles).toContain('main.go');
  });

  test('only a nested (non-top-level) source change → pass (spec: top-level file)', () => {
    const { dir, base, head } = twoCommit(RESOLVED_GO_BASE, {
      write: { 'internal/helper.go': 'package internal\n\nvar X = 1\n' },
    });
    const r = evaluateGate({ root: dir, base, head });
    expect(r.decision).toBe('pass');
  });

  test('doc-only change (new README) → pass', () => {
    const { dir, base, head } = twoCommit(RESOLVED_GO_BASE, {
      write: { 'README.md': '# Foo\n' },
    });
    const r = evaluateGate({ root: dir, base, head });
    expect(r.decision).toBe('pass');
  });

  test('top-level config change (go.mod) with no doc → pass (config excluded)', () => {
    const { dir, base, head } = twoCommit(RESOLVED_GO_BASE, {
      write: { 'go.mod': 'module example.com/foo\n\ngo 1.22\n' },
    });
    const r = evaluateGate({ root: dir, base, head });
    expect(r.decision).toBe('pass');
  });
});

describe('evaluateGate — abstain + skip', () => {
  test('(d) monorepo / escalate verdict → abstain', () => {
    const { dir, base, head } = twoCommit(
      {
        'package.json': '{"name":"root","private":true,"workspaces":["packages/*"]}\n',
        'packages/a/package.json': '{"name":"a","version":"1.0.0"}\n',
        'packages/a/index.js': 'module.exports = 1;\n',
      },
      { write: { 'packages/a/index.js': 'module.exports = 2;\n' } },
    );
    const r = evaluateGate({ root: dir, base, head });
    expect(r.decision).toBe('abstain');
    expect(r.verdict).toBe('ESCALATE-TO-AGENT');
    expect(r.offendingCodeFiles).toEqual([]);
  });

  test('(e) skip flag → pass with reason "skipped" (even with an offending change)', () => {
    const { dir, base, head } = twoCommit(RESOLVED_JS_BASE, {
      write: { 'lib/index.js': 'module.exports = 2;\n' },
    });
    const r = evaluateGate({ root: dir, base, head, skip: true });
    expect(r.decision).toBe('pass');
    expect(r.reason).toBe('skipped');
  });
});

describe('evaluateGate — explicit changedFiles classification', () => {
  test('anchored doc prefixes: NEWSLETTER.js is code, NEWS.md is a doc', () => {
    const dir = baseOnly(RESOLVED_GO_BASE); // source ["."]
    const fail = evaluateGate({
      root: dir,
      changedFiles: [{ status: 'ADDED', path: 'NEWSLETTER.js' }],
    });
    expect(fail.decision).toBe('fail');
    expect(fail.offendingCodeFiles).toContain('NEWSLETTER.js');

    const pass = evaluateGate({
      root: dir,
      changedFiles: [{ status: 'ADDED', path: 'NEWS.md' }],
    });
    expect(pass.decision).toBe('pass');
  });

  test('string entries default to MODIFIED and are classified against the source surface', () => {
    const dir = baseOnly(RESOLVED_JS_BASE); // source ["lib"]
    const r = evaluateGate({ root: dir, changedFiles: ['lib/index.js'] });
    expect(r.decision).toBe('fail');
    expect(r.offendingCodeFiles).toContain('lib/index.js');
  });

  test('a file outside the source surface is not a code change', () => {
    const dir = baseOnly(RESOLVED_JS_BASE); // source ["lib"]
    const r = evaluateGate({
      root: dir,
      changedFiles: [{ status: 'MODIFIED', path: 'scripts/tool.js' }],
    });
    expect(r.decision).toBe('pass');
  });
});

describe('isDocPath', () => {
  test.each([
    ['README.md', true],
    ['README', true],
    ['README.rst', true],
    ['CHANGELOG.md', true],
    ['HISTORY.txt', true],
    ['docs/anything.txt', true],
    ['.changeset/foo.md', true],
    ['pkg/guide.mdx', true],
    ['LICENSE', true],
    ['AGENTS.md', true],
    ['NEWSLETTER.js', false],
    ['LICENSEMANAGER.go', false],
    ['src/index.js', false],
    ['main.go', false],
  ])('isDocPath(%p) === %p', (p, expected) => {
    expect(isDocPath(p)).toBe(expected);
  });
});
