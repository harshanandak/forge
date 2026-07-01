'use strict';

const { describe, expect, test, afterAll } = require('bun:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { detect } = require('../../lib/doc-gate/detect');

const createdDirs = [];

/**
 * Build a real, committed git repo in a temp dir.
 * @param {Object<string,string>} files - relative path -> file content.
 * @param {{ gitlink?: { sha: string, name: string } }} [opts]
 * @returns {string} absolute repo root.
 */
function makeRepo(files = {}, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-docgate-'));
  createdDirs.push(dir);
  const g = args => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'ignore', 'ignore'] });
  g(['init', '-q']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  g(['config', 'commit.gpgsign', 'false']);
  g(['config', 'core.autocrlf', 'false']);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  g(['add', '-A']);
  if (opts.gitlink) {
    g(['update-index', '--add', '--cacheinfo', `160000,${opts.gitlink.sha},${opts.gitlink.name}`]);
  }
  g(['commit', '-q', '-m', 'init']);
  return dir;
}

afterAll(() => {
  for (const dir of createdDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('doc-gate detect — source (manifest-first + blocklist)', () => {
  test('Rust single crate → source [src], toolchain cargo (no Cargo.lock)', () => {
    const repo = makeRepo({
      'Cargo.toml': '[package]\nname = "mycrate"\nversion = "0.1.0"\n',
      'src/main.rs': 'fn main() {}\n',
    });
    const r = detect(repo);
    expect(r.source.value).toEqual(['src']);
    expect(r.source.confidence).toBe('high');
    expect(r.source.source).toBe('code');
    expect(r.toolchain.value).toBe('cargo');
    expect(r.toolchain.confidence).toBe('high');
    expect([...r.codeHighConfidence].sort()).toEqual(['source', 'toolchain']);
  });

  test('Rust Cargo workspace → source ESCALATES (monorepo), never pkg', () => {
    const repo = makeRepo({
      'Cargo.toml': '[workspace]\nmembers = ["crates/a"]\n',
      'crates/a/Cargo.toml': '[package]\nname = "a"\nversion = "0.1.0"\n',
      'crates/a/src/lib.rs': 'pub fn a() {}\n',
      'pkg/scratch.rs': '// packaging dir that must never be THE source\n',
    });
    const r = detect(repo);
    expect(r.monorepo.monorepo).toBe(true);
    expect(r.monorepo.reasons).toContain('cargo-workspace');
    expect(r.source.escalate).toBe(true);
    expect(r.source.value).toBeNull();
    expect(r.source.trigger).toContain('monorepo');
    expect(r.codeHighConfidence).not.toContain('source');
    expect(r.escalate.map(e => e.field)).toContain('source');
  });

  test('Go flat-root module (root .go + internal/) → source ["."], never internal', () => {
    const repo = makeRepo({
      'go.mod': 'module example.com/foo\n\ngo 1.21\n',
      'main.go': 'package main\n\nfunc main() {}\n',
      'internal/helper.go': 'package internal\n',
    });
    const r = detect(repo);
    expect(r.source.value).toEqual(['.']);
    expect(r.source.confidence).toBe('high');
    expect(r.source.value).not.toContain('internal');
    expect(r.toolchain.value).toBe('go');
    expect(r.codeHighConfidence).toContain('source');
  });

  test('Python flat-layout (pyproject name + <pkg>/) → source [<pkg>]', () => {
    const repo = makeRepo({
      'pyproject.toml': '[project]\nname = "my-pkg"\nversion = "0.1.0"\n',
      'my_pkg/__init__.py': '',
      'my_pkg/core.py': 'X = 1\n',
    });
    const r = detect(repo);
    expect(r.source.value).toEqual(['my_pkg']);
    expect(r.source.confidence).toBe('high');
    expect(r.codeHighConfidence).toContain('source');
  });

  test('Python src-layout → source [src]', () => {
    const repo = makeRepo({
      'pyproject.toml': '[project]\nname = "my-pkg"\nversion = "0.1.0"\n',
      'src/my_pkg/__init__.py': '',
    });
    const r = detect(repo);
    expect(r.source.value).toEqual(['src']);
    expect(r.source.confidence).toBe('high');
  });

  test('JS single package (lib/ + one lockfile) → source [lib], toolchain from lockfile', () => {
    const repo = makeRepo({
      'package.json': '{"name":"x","version":"1.0.0"}\n',
      'lib/index.js': 'module.exports = {};\n',
      'package-lock.json': '{}\n',
    });
    const r = detect(repo);
    expect(r.source.value).toEqual(['lib']);
    expect(r.source.confidence).toBe('high');
    expect(r.toolchain.value).toBe('npm');
    expect(r.toolchain.confidence).toBe('high');
    expect([...r.codeHighConfidence].sort()).toEqual(['source', 'toolchain']);
  });

  test('JS with secondary root (src/ + convex/) → source ESCALATES', () => {
    const repo = makeRepo({
      'package.json': '{"name":"x","version":"1.0.0"}\n',
      'src/index.js': 'export default 1;\n',
      'convex/schema.ts': 'export default {};\n',
    });
    const r = detect(repo);
    expect(r.source.escalate).toBe(true);
    expect(r.source.trigger).toContain('secondary-roots');
    expect(r.source.trigger).toContain('convex');
    expect(r.codeHighConfidence).not.toContain('source');
    expect(r.escalate.map(e => e.field)).toContain('source');
  });
});

describe('doc-gate detect — toolchain', () => {
  test('multiple conflicting lockfiles → toolchain ESCALATES (no guess)', () => {
    const repo = makeRepo({
      'package.json': '{"name":"x","version":"1.0.0"}\n',
      'lib/index.js': 'module.exports = {};\n',
      'package-lock.json': '{}\n',
      'yarn.lock': '# yarn lockfile\n',
    });
    const r = detect(repo);
    expect(r.toolchain.escalate).toBe(true);
    expect(r.toolchain.value).toBeNull();
    expect(r.toolchain.trigger).toBe('multiple-lockfiles');
    expect(r.codeHighConfidence).not.toContain('toolchain');
    expect(r.escalate.map(e => e.field)).toContain('toolchain');
    // source is still resolvable + correct → only correct fields are high-confidence.
    expect(r.source.value).toEqual(['lib']);
  });
});

describe('doc-gate detect — nested gitlink wrapper', () => {
  test('gitlink-only wrapper → every field ESCALATES', () => {
    const repo = makeRepo({}, {
      gitlink: { sha: '1111111111111111111111111111111111111111', name: 'sub' },
    });
    const r = detect(repo);
    expect(r.nested).toBe(true);
    expect(r.verdict).toBe('ESCALATE-TO-AGENT');
    expect(r.source.escalate).toBe(true);
    expect(r.toolchain.escalate).toBe(true);
    expect(r.changelog.escalate).toBe(true);
    expect(r.ci.escalate).toBe(true);
    expect(r.agents.escalate).toBe(true);
    expect(r.escalate.map(e => e.field)).toContain('whole-repo');
    expect(r.codeHighConfidence).toEqual([]);
  });
});

describe('doc-gate detect — changelog (case-insensitive + broad)', () => {
  test('History.md (case) is detected', () => {
    const repo = makeRepo({ 'History.md': '# History\n\n- 1.0.0 first\n' });
    const r = detect(repo);
    expect(r.changelog.value).toBe('History.md');
    expect(r.changelog.source).toBe('code');
  });

  test('CHANGES.rst (.rst) is detected', () => {
    const repo = makeRepo({ 'CHANGES.rst': 'Changes\n=======\n' });
    const r = detect(repo);
    expect(r.changelog.value).toBe('CHANGES.rst');
  });

  test('docs/**/release-notes.* is detected', () => {
    const repo = makeRepo({
      'package.json': '{"name":"x","version":"1.0.0"}\n',
      'docs/guide/release-notes.md': '# Release notes\n',
    });
    const r = detect(repo);
    expect(r.changelog.value).toBe('docs/guide/release-notes.md');
    expect(r.changelog.format).toBe('docs-changelog');
  });

  test('keep-a-changelog is classified by content', () => {
    const repo = makeRepo({
      'CHANGELOG.md':
        '# Changelog\n\nThe format is based on [Keep a Changelog].\n\n## [Unreleased]\n',
    });
    const r = detect(repo);
    expect(r.changelog.value).toBe('CHANGELOG.md');
    expect(r.changelog.format).toBe('keep-a-changelog');
    expect(r.changelog.confidence).toBe('high');
  });
});

describe('doc-gate detect — codeHighConfidence is never silent-wrong', () => {
  test('only deterministic, correct fields appear as code-high-confidence', () => {
    // A fixture deliberately mixing a resolvable source/toolchain with abstaining
    // changelog/ci: high-confidence must contain ONLY the correct fields.
    const repo = makeRepo({
      'Cargo.toml': '[package]\nname = "x"\nversion = "0.1.0"\n',
      'src/lib.rs': 'pub fn x() {}\n',
    });
    const r = detect(repo);
    for (const field of r.codeHighConfidence) {
      expect(r[field].source).toBe('code');
      expect(r[field].confidence).toBe('high');
      expect(r[field].escalate).toBeFalsy();
    }
    // The two error-prone fields here abstain rather than guess.
    expect(r.changelog.confidence).toBe('abstain');
    expect(r.ci.confidence).toBe('abstain');
  });
});
