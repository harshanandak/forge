'use strict';

const { describe, expect, test, afterAll, setDefaultTimeout } = require('bun:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const docGate = require('../../lib/commands/doc-gate');
const { detect } = require('../../lib/doc-gate/detect');
const { scaffoldDeclaration, loadDeclaration } = require('../../lib/doc-gate/declaration');

// Real git fixtures + parallel disk I/O can exceed the 5s default on Windows CI.
setDefaultTimeout(30000);

const createdDirs = [];

function makeJsRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-docgate-init-'));
  createdDirs.push(dir);
  const g = args => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'ignore', 'ignore'] });
  g(['init', '-q']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  g(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}\n');
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), 'module.exports = 1;\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'init']);
  return dir;
}
function makeNonGitDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-docgate-init-nogit-'));
  createdDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of createdDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('forge doc-gate init', () => {
  test('scaffolds a .docgate.json from the current detect() result', async () => {
    const dir = makeJsRepo();
    const res = await docGate.handler(['init'], {}, dir, {});
    expect(res.success).toBe(true);
    expect(res.exitCode).toBeUndefined();
    const written = path.join(dir, '.docgate.json');
    expect(fs.existsSync(written)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(written, 'utf8'));
    expect(parsed).toEqual(scaffoldDeclaration(detect(dir)));
    expect(parsed.source).toEqual(['lib']);
  });

  test('--json output equals the scaffold written to disk (thin-wrapper contract)', async () => {
    const dir = makeJsRepo();
    // The scaffold is written UNTRACKED, so detect(dir) is unaffected by it.
    const expectedDecl = scaffoldDeclaration(detect(dir));
    const res = await docGate.handler(['init', '--json'], {}, dir, {});
    expect(res.success).toBe(true);
    const payload = JSON.parse(res.output);
    expect(payload.path).toBe('.docgate.json');
    expect(payload.overwritten).toBe(false);
    expect(payload.declaration).toEqual(expectedDecl);
    // And the file on disk matches the reported declaration exactly.
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.docgate.json'), 'utf8'))).toEqual(payload.declaration);
  });

  test('refuses to overwrite an existing .docgate.json without --force (exit 1)', async () => {
    const dir = makeJsRepo();
    fs.writeFileSync(path.join(dir, '.docgate.json'), '{"version":1,"source":["custom"]}\n');
    const res = await docGate.handler(['init'], {}, dir, {});
    expect(res.success).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.error).toMatch(/already exists/i);
    // The existing file must be untouched.
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.docgate.json'), 'utf8')).source).toEqual(['custom']);
  });

  test('--force overwrites and reports overwritten: true', async () => {
    const dir = makeJsRepo();
    fs.writeFileSync(path.join(dir, '.docgate.json'), '{"version":1,"source":["custom"]}\n');
    const res = await docGate.handler(['init', '--force', '--json'], {}, dir, {});
    expect(res.success).toBe(true);
    const payload = JSON.parse(res.output);
    expect(payload.overwritten).toBe(true);
    expect(payload.declaration.source).toEqual(['lib']);
  });

  test('--force also honored via parsed flags object', async () => {
    const dir = makeJsRepo();
    fs.writeFileSync(path.join(dir, '.docgate.json'), '{"version":1,"source":["custom"]}\n');
    const res = await docGate.handler(['init'], { force: true }, dir, {});
    expect(res.success).toBe(true);
  });

  test('a committed init scaffold is loadable as a valid declaration (round-trip)', async () => {
    const dir = makeJsRepo();
    await docGate.handler(['init'], {}, dir, {});
    execFileSync('git', ['-C', dir, 'add', '.docgate.json'], { stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'add declaration'], { stdio: ['ignore', 'ignore', 'ignore'] });
    const { declaration, errors } = loadDeclaration(dir);
    expect(errors).toEqual([]);
    expect(declaration.source).toEqual(['lib']);
    // Once committed + tracked, the declaration flips the verdict to DECLARED.
    expect(detect(dir).verdict).toBe('DECLARED');
  });

  test('non-git directory is a real error (exit 1)', async () => {
    const dir = makeNonGitDir();
    const res = await docGate.handler(['init'], {}, dir, {});
    expect(res.success).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.error).toContain('git repository');
  });
});
