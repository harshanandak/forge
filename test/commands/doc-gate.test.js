'use strict';

const { describe, expect, test, afterAll, setDefaultTimeout } = require('bun:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const docGate = require('../../lib/commands/doc-gate');
const { detect } = require('../../lib/doc-gate/detect');

// Real git fixtures + parallel disk I/O can exceed the 5s default on Windows CI.
setDefaultTimeout(30000);

const createdDirs = [];

function makeRustRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-docgate-cmd-'));
  createdDirs.push(dir);
  const g = args => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'ignore', 'ignore'] });
  g(['init', '-q']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  g(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.1.0"\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'main.rs'), 'fn main() {}\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'init']);
  return dir;
}

function makeNonGitDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-docgate-nogit-'));
  createdDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('forge doc-gate command', () => {
  test('exposes the registry contract', () => {
    expect(docGate.name).toBe('doc-gate');
    expect(typeof docGate.description).toBe('string');
    expect(typeof docGate.handler).toBe('function');
  });

  test('detect (default subcommand) prints a human summary and exits 0', async () => {
    const repo = makeRustRepo();
    const res = await docGate.handler([], {}, repo, {});
    expect(res.success).toBe(true);
    expect(res.exitCode).toBeUndefined();
    expect(res.output).toContain('doc-gate detect');
    expect(res.output).toContain('verdict:');
    expect(res.output).toContain('source');
  });

  test('--json emits a structured object equal to the detector result', async () => {
    const repo = makeRustRepo();
    const res = await docGate.handler(['detect', '--json'], {}, repo, {});
    expect(res.success).toBe(true);
    const parsed = JSON.parse(res.output);
    expect(parsed.source.value).toEqual(['src']);
    expect(parsed.toolchain.value).toBe('cargo');
    expect(parsed).toEqual(detect(repo)); // thin-wrapper: CLI --json equals detect() exactly
  });

  test('--json also honored via parsed flags object', async () => {
    const repo = makeRustRepo();
    const res = await docGate.handler(['detect'], { json: true }, repo, {});
    expect(() => JSON.parse(res.output)).not.toThrow();
  });

  test('unknown subcommand is a real error (exit 1)', async () => {
    const repo = makeRustRepo();
    const res = await docGate.handler(['bogus'], {}, repo, {});
    expect(res.success).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.error).toContain('Unknown doc-gate subcommand');
  });

  test('non-git directory is a real error (exit 1)', async () => {
    const dir = makeNonGitDir();
    const res = await docGate.handler(['detect'], {}, dir, {});
    expect(res.success).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.error).toContain('git repository');
  });
});

// --- forge doc-gate check ----------------------------------------------------
function initRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  const g = args => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'ignore', 'ignore'] });
  g(['init', '-q']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  g(['config', 'commit.gpgsign', 'false']);
  g(['config', 'core.autocrlf', 'false']);
  return { dir, g };
}
function writeAll(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}
function headSha(dir) {
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}
// A fully CODE-RESOLVED single-package repo (source + toolchain + changelog + ci).
const RESOLVED_BASE = {
  'package.json': '{"name":"x","version":"1.0.0"}\n',
  'package-lock.json': '{}\n',
  'lib/index.js': 'module.exports = 1;\n',
  'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n',
  '.github/workflows/ci.yml': 'name: ci\non: [push]\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps: []\n',
};
function makeResolvedRepo(mutations) {
  const { dir, g } = initRepo('forge-docgate-check-');
  writeAll(dir, RESOLVED_BASE);
  g(['add', '-A']); g(['commit', '-q', '-m', 'base']);
  const base = headSha(dir);
  if (!mutations) return { dir, base, head: base };
  writeAll(dir, mutations);
  g(['add', '-A']); g(['commit', '-q', '-m', 'head']);
  return { dir, base, head: headSha(dir) };
}
function makeMonorepo(mutations) {
  const { dir, g } = initRepo('forge-docgate-mono-');
  writeAll(dir, {
    'package.json': '{"name":"root","private":true,"workspaces":["packages/*"]}\n',
    'packages/a/package.json': '{"name":"a","version":"1.0.0"}\n',
    'packages/a/index.js': 'module.exports = 1;\n',
  });
  g(['add', '-A']); g(['commit', '-q', '-m', 'base']);
  const base = headSha(dir);
  writeAll(dir, mutations);
  g(['add', '-A']); g(['commit', '-q', '-m', 'head']);
  return { dir, base, head: headSha(dir) };
}

describe('forge doc-gate check', () => {
  test('code change with no doc → exit 1 (fail)', async () => {
    const { dir, base, head } = makeResolvedRepo({ 'lib/index.js': 'module.exports = 2;\n' });
    const res = await docGate.handler(['check', '--base', base, '--head', head], {}, dir, {});
    expect(res.success).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.output).toContain('FAIL');
    expect(res.error).toContain('doc-gate');
  });

  test('code change with a CHANGELOG update → exit 0 (pass)', async () => {
    const { dir, base, head } = makeResolvedRepo({
      'lib/index.js': 'module.exports = 2;\n',
      'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n- change\n',
    });
    const res = await docGate.handler(['check', '--base', base, '--head', head], {}, dir, {});
    expect(res.success).toBe(true);
    expect(res.exitCode).toBeUndefined();
    expect(res.output).toContain('PASS');
  });

  test('monorepo / escalate verdict → exit 0 (abstain)', async () => {
    const { dir, base, head } = makeMonorepo({ 'packages/a/index.js': 'module.exports = 2;\n' });
    const res = await docGate.handler(['check', '--base', base, '--head', head], {}, dir, {});
    expect(res.success).toBe(true);
    expect(res.output).toContain('ABSTAIN');
    expect(res.output).toContain('ESCALATE-TO-AGENT');
  });

  test('--skip forces a pass even with an offending change', async () => {
    const { dir, base, head } = makeResolvedRepo({ 'lib/index.js': 'module.exports = 2;\n' });
    const res = await docGate.handler(['check', '--base', base, '--head', head, '--skip'], {}, dir, {});
    expect(res.success).toBe(true);
    expect(res.output).toContain('PASS');
  });

  test('--json on a fail emits parseable JSON and still exits 1', async () => {
    const { dir, base, head } = makeResolvedRepo({ 'lib/index.js': 'module.exports = 2;\n' });
    const res = await docGate.handler(['check', '--base', base, '--head', head, '--json'], {}, dir, {});
    expect(res.success).toBe(false);
    expect(res.exitCode).toBe(1);
    const parsed = JSON.parse(res.output);
    expect(parsed.decision).toBe('fail');
    expect(parsed.offendingCodeFiles).toContain('lib/index.js');
  });

  test('missing --base/--head is a real usage error (exit 1)', async () => {
    const { dir } = makeResolvedRepo();
    const res = await docGate.handler(['check'], {}, dir, {});
    expect(res.success).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.error).toContain('requires --base');
  });
});
