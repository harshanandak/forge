'use strict';

const { describe, expect, test, afterAll, setDefaultTimeout } = require('bun:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadDeclaration, validateDeclaration, scaffoldDeclaration } = require('../../lib/doc-gate/declaration');
const { detect } = require('../../lib/doc-gate/detect');
const { evaluateGate } = require('../../lib/doc-gate/gate');

// Real git fixtures + parallel disk I/O can exceed the 5s default on Windows CI.
setDefaultTimeout(30000);

const createdDirs = [];

function gitq(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'ignore', 'ignore'] });
}
function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}
function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-docgate-decl-'));
  createdDirs.push(dir);
  gitq(dir, ['init', '-q']);
  gitq(dir, ['config', 'user.email', 'test@example.com']);
  gitq(dir, ['config', 'user.name', 'Test']);
  gitq(dir, ['config', 'commit.gpgsign', 'false']);
  gitq(dir, ['config', 'core.autocrlf', 'false']);
  return dir;
}
/** Commit a files map; returns the repo dir. */
function makeRepo(files = {}) {
  const dir = initRepo();
  writeFiles(dir, files);
  gitq(dir, ['add', '-A']);
  gitq(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}
function headSha(dir) {
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

// A monorepo the detector ESCALATES on (npm workspaces) — the perfect subject to
// show a committed declaration flips it to an enforceable DECLARED verdict.
const MONOREPO_BASE = {
  'package.json': '{"name":"root","private":true,"workspaces":["packages/*"]}\n',
  'packages/a/package.json': '{"name":"a","version":"1.0.0"}\n',
  'packages/a/index.js': 'module.exports = 1;\n',
  'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n',
};
const DECL = source => `${JSON.stringify({ version: 1, source }, null, 2)}\n`;

afterAll(() => {
  for (const dir of createdDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('loadDeclaration — tracked-files-only + strict schema', () => {
  test('valid TRACKED .docgate.json → parsed declaration, no errors', () => {
    const dir = makeRepo({ '.docgate.json': DECL(['packages/a']), 'packages/a/index.js': 'module.exports = 1;\n' });
    const { declaration, errors } = loadDeclaration(dir);
    expect(errors).toEqual([]);
    expect(declaration).toEqual({ version: 1, source: ['packages/a'] });
  });

  test('UNTRACKED .docgate.json → ignored (tracked-files-only)', () => {
    const dir = makeRepo({ 'packages/a/index.js': 'module.exports = 1;\n' });
    // Present on disk but never `git add`ed → must be ignored.
    fs.writeFileSync(path.join(dir, '.docgate.json'), DECL(['packages/a']));
    const { declaration, errors } = loadDeclaration(dir);
    expect(declaration).toBeNull();
    expect(errors).toEqual([]);
  });

  test('missing .docgate.json → { declaration: null, errors: [] }', () => {
    const dir = makeRepo({ 'packages/a/index.js': 'module.exports = 1;\n' });
    expect(loadDeclaration(dir)).toEqual({ declaration: null, errors: [] });
  });

  test('invalid JSON → errors non-empty, declaration null', () => {
    const dir = makeRepo({ '.docgate.json': '{ not json ]\n' });
    const { declaration, errors } = loadDeclaration(dir);
    expect(declaration).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/invalid JSON/i);
  });

  test('wrong types → errors non-empty', () => {
    const dir = makeRepo({ '.docgate.json': `${JSON.stringify({ version: 1, source: 'lib', toolchain: 5 })}\n` });
    const { declaration, errors } = loadDeclaration(dir);
    expect(declaration).toBeNull();
    expect(errors.some(e => /"source"/.test(e))).toBe(true);
    expect(errors.some(e => /"toolchain"/.test(e))).toBe(true);
  });

  test('unknown top-level key → error', () => {
    const dir = makeRepo({ '.docgate.json': `${JSON.stringify({ version: 1, source: ['lib'], bogus: true })}\n` });
    const { errors } = loadDeclaration(dir);
    expect(errors.some(e => /unknown top-level key "bogus"/.test(e))).toBe(true);
  });

  test('version !== 1 → error', () => {
    const dir = makeRepo({ '.docgate.json': `${JSON.stringify({ version: 2, source: ['lib'] })}\n` });
    const { errors } = loadDeclaration(dir);
    expect(errors.some(e => /"version" must be 1/.test(e))).toBe(true);
  });
});

describe('validateDeclaration — pure schema checks', () => {
  test('a well-formed declaration with all fields validates', () => {
    const decl = {
      version: 1,
      source: ['packages/a'],
      toolchain: 'npm',
      excludeFromGate: ['packages/a/generated/**'],
      rules: [{ when: 'packages/a/api/**', requires: 'openapi.yaml' }],
    };
    expect(validateDeclaration(decl)).toEqual({ declaration: decl, errors: [] });
  });

  test('a malformed rule entry is rejected with a precise message', () => {
    const { errors } = validateDeclaration({ version: 1, source: ['lib'], rules: [{ when: 'a/**' }] });
    expect(errors.some(e => /rules\[0\]\.requires/.test(e))).toBe(true);
  });

  test('non-object → error', () => {
    expect(validateDeclaration(['nope']).errors.length).toBeGreaterThan(0);
    expect(validateDeclaration(null).errors.length).toBeGreaterThan(0);
  });
});

describe('detect() honors a committed declaration', () => {
  test('a monorepo (would ESCALATE) with a tracked declaration → verdict DECLARED', () => {
    const dir = makeRepo({ ...MONOREPO_BASE, '.docgate.json': DECL(['packages/a']) });
    // Sanity: without the declaration this layout escalates.
    const bare = makeRepo(MONOREPO_BASE);
    expect(detect(bare).verdict).toBe('ESCALATE-TO-AGENT');

    const r = detect(dir);
    expect(r.verdict).toBe('DECLARED');
    expect(r.declared).toBe(true);
    expect(r.source.value).toEqual(['packages/a']);
    expect(r.source.source).toBe('declared');
    expect(r.source.confidence).toBe('high');
    expect(r.escalate.map(e => e.field)).not.toContain('source');
  });

  test('declared toolchain overrides inference too', () => {
    const decl = `${JSON.stringify({ version: 1, source: ['packages/a'], toolchain: 'pnpm' }, null, 2)}\n`;
    const dir = makeRepo({ ...MONOREPO_BASE, '.docgate.json': decl });
    const r = detect(dir);
    expect(r.toolchain.value).toBe('pnpm');
    expect(r.toolchain.source).toBe('declared');
  });

  test('overriding an already CODE-RESOLVED field drops it from codeHighConfidence', () => {
    // A single JS package resolves source+toolchain as code/high; a declaration
    // overriding them makes them 'declared', so they must leave codeHighConfidence
    // (which lists only code-derived, silent-wrong-eligible fields).
    const decl = `${JSON.stringify({ version: 1, source: ['app'], toolchain: 'pnpm' }, null, 2)}\n`;
    const dir = makeRepo({
      'package.json': '{"name":"x","version":"1.0.0"}\n',
      'package-lock.json': '{}\n',
      'lib/index.js': 'module.exports = 1;\n',
      '.docgate.json': decl,
    });
    const r = detect(dir);
    expect(r.verdict).toBe('DECLARED');
    expect(r.codeHighConfidence).not.toContain('source');
    expect(r.codeHighConfidence).not.toContain('toolchain');
    // Invariant preserved: every remaining field is genuinely code-derived + high.
    for (const field of r.codeHighConfidence) {
      expect(r[field].source).toBe('code');
      expect(r[field].confidence).toBe('high');
    }
  });

  test('INVALID declaration → declarationErrors set, detection still runs', () => {
    const dir = makeRepo({ ...MONOREPO_BASE, '.docgate.json': `${JSON.stringify({ version: 9, source: ['packages/a'] })}\n` });
    const r = detect(dir);
    expect(Array.isArray(r.declarationErrors)).toBe(true);
    expect(r.declarationErrors.length).toBeGreaterThan(0);
    // Detection is untouched: the monorepo still escalates, declaration NOT applied.
    expect(r.verdict).toBe('ESCALATE-TO-AGENT');
    expect(r.declared).toBeUndefined();
  });
});

describe('evaluateGate() honors the declaration', () => {
  /** Base commit (with tracked .docgate.json), then a head commit applying mutations. */
  function twoCommit(baseFiles, mutations) {
    const dir = makeRepo(baseFiles);
    const base = headSha(dir);
    writeFiles(dir, mutations);
    gitq(dir, ['add', '-A']);
    gitq(dir, ['commit', '-q', '-m', 'head']);
    return { dir, base, head: headSha(dir) };
  }

  test('DECLARED enforces: code change with NO doc → fail', () => {
    const { dir, base, head } = twoCommit(
      { ...MONOREPO_BASE, '.docgate.json': DECL(['packages/a']) },
      { 'packages/a/index.js': 'module.exports = 2;\n' },
    );
    const r = evaluateGate({ root: dir, base, head });
    expect(r.verdict).toBe('DECLARED');
    expect(r.decision).toBe('fail');
    expect(r.offendingCodeFiles).toContain('packages/a/index.js');
  });

  test('DECLARED enforces: code change + doc update → pass', () => {
    const { dir, base, head } = twoCommit(
      { ...MONOREPO_BASE, '.docgate.json': DECL(['packages/a']) },
      { 'packages/a/index.js': 'module.exports = 2;\n', 'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n- change\n' },
    );
    const r = evaluateGate({ root: dir, base, head });
    expect(r.decision).toBe('pass');
    expect(r.docChangesSeen).toContain('CHANGELOG.md');
  });

  test('excludeFromGate: a change confined to an excluded path is not code → pass', () => {
    const decl = `${JSON.stringify({ version: 1, source: ['packages/a'], excludeFromGate: ['packages/a/generated/**'] }, null, 2)}\n`;
    const { dir, base, head } = twoCommit(
      { ...MONOREPO_BASE, '.docgate.json': decl, 'packages/a/generated/schema.js': 'module.exports = 0;\n' },
      { 'packages/a/generated/schema.js': 'module.exports = 1;\n' },
    );
    const r = evaluateGate({ root: dir, base, head });
    expect(r.decision).toBe('pass');
    expect(r.offendingCodeFiles).toEqual([]);
  });

  test('excludeFromGate: a normal source change still fails', () => {
    const decl = `${JSON.stringify({ version: 1, source: ['packages/a'], excludeFromGate: ['packages/a/generated/**'] }, null, 2)}\n`;
    const { dir, base, head } = twoCommit(
      { ...MONOREPO_BASE, '.docgate.json': decl },
      { 'packages/a/index.js': 'module.exports = 2;\n' },
    );
    const r = evaluateGate({ root: dir, base, head });
    expect(r.decision).toBe('fail');
    expect(r.offendingCodeFiles).toContain('packages/a/index.js');
  });

  test('rules: a triggered rule fails even when a doc update accompanies the change', () => {
    const decl = `${JSON.stringify({ version: 1, source: ['packages/a'], rules: [{ when: 'packages/a/api/**', requires: 'openapi.yaml' }] }, null, 2)}\n`;
    const { dir, base, head } = twoCommit(
      { ...MONOREPO_BASE, '.docgate.json': decl, 'packages/a/api/users.js': 'module.exports = 0;\n', 'openapi.yaml': 'openapi: 3.0.0\n' },
      { 'packages/a/api/users.js': 'module.exports = 1;\n', 'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n- api\n' },
    );
    const r = evaluateGate({ root: dir, base, head });
    expect(r.decision).toBe('fail');
    expect(r.reason).toMatch(/openapi\.yaml/);
  });

  test('rules: satisfying the required path passes', () => {
    const decl = `${JSON.stringify({ version: 1, source: ['packages/a'], rules: [{ when: 'packages/a/api/**', requires: 'openapi.yaml' }] }, null, 2)}\n`;
    const { dir, base, head } = twoCommit(
      { ...MONOREPO_BASE, '.docgate.json': decl, 'packages/a/api/users.js': 'module.exports = 0;\n', 'openapi.yaml': 'openapi: 3.0.0\n' },
      {
        'packages/a/api/users.js': 'module.exports = 1;\n',
        'openapi.yaml': 'openapi: 3.0.1\n',
        'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n- api\n',
      },
    );
    const r = evaluateGate({ root: dir, base, head });
    expect(r.decision).toBe('pass');
  });

  test('INVALID declaration → gate FAILS closed (never a silent pass)', () => {
    const { dir, base, head } = twoCommit(
      { ...MONOREPO_BASE, '.docgate.json': `${JSON.stringify({ version: 1, unknownKey: true })}\n` },
      { 'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n- docs only\n' },
    );
    const r = evaluateGate({ root: dir, base, head });
    expect(r.decision).toBe('fail');
    expect(r.reason).toMatch(/invalid \.docgate\.json/i);
  });
});

describe('scaffoldDeclaration — starter object from a detect() result', () => {
  test('uses detected source/toolchain and is itself schema-valid', () => {
    const dir = makeRepo({
      'package.json': '{"name":"x","version":"1.0.0"}\n',
      'package-lock.json': '{}\n',
      'lib/index.js': 'module.exports = 1;\n',
    });
    const scaffold = scaffoldDeclaration(detect(dir));
    expect(scaffold.version).toBe(1);
    expect(scaffold.source).toEqual(['lib']);
    expect(scaffold.toolchain).toBe('npm');
    expect(validateDeclaration(scaffold).errors).toEqual([]);
  });

  test('falls back to a src placeholder when detection abstained', () => {
    const scaffold = scaffoldDeclaration({ source: { value: null }, toolchain: { value: null } });
    expect(scaffold.source).toEqual(['src']);
    expect(scaffold.toolchain).toBeUndefined();
  });
});
