'use strict';

const { describe, expect, test, afterAll, setDefaultTimeout } = require('bun:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const docGate = require('../../lib/commands/doc-gate');
const { generateBundle } = require('../../lib/doc-gate/okf');
const { isOkfEnabled } = require('../../lib/doc-gate/okf-config');

// Real git fixtures + parallel disk I/O can exceed the 5s default on Windows CI.
setDefaultTimeout(30000);

const createdDirs = [];
function git(dir, args) {
  execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'ignore', 'ignore'] });
}
function makeDocsRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-okf-cmd-'));
  createdDirs.push(dir);
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.mkdirSync(path.join(dir, 'docs', 'guides'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'intro.md'), '# Introduction\n\nWelcome.\n');
  fs.writeFileSync(path.join(dir, 'docs', 'guides', 'setup.md'), '# Setup Guide\n\nSteps.\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

afterAll(() => {
  for (const dir of createdDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('forge doc-gate okf (command wrapper)', () => {
  test('status defaults to disabled', async () => {
    const dir = makeDocsRepo();
    const res = await docGate.handler(['okf', 'status', '--json'], {}, dir, {});
    expect(res.success).toBe(true);
    expect(JSON.parse(res.output)).toEqual({ enabled: false });
  });

  test('generate refuses when disabled (exit 1, no bundle written)', async () => {
    const dir = makeDocsRepo();
    const res = await docGate.handler(['okf', 'generate', '--source', 'docs'], {}, dir, {});
    expect(res.success).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.error).toMatch(/disabled/i);
    expect(fs.existsSync(path.join(dir, '.okf'))).toBe(false);
  });

  test('enable then status reports enabled; disable reverts', async () => {
    const dir = makeDocsRepo();
    const en = await docGate.handler(['okf', 'enable'], {}, dir, {});
    expect(en.success).toBe(true);
    expect(isOkfEnabled(dir)).toBe(true);

    const status = await docGate.handler(['okf', 'status', '--json'], {}, dir, {});
    expect(JSON.parse(status.output)).toEqual({ enabled: true });

    const dis = await docGate.handler(['okf', 'disable'], {}, dir, {});
    expect(dis.success).toBe(true);
    expect(isOkfEnabled(dir)).toBe(false);
  });

  test('generate --json equals the underlying generateBundle result (thin wrapper)', async () => {
    const dir = makeDocsRepo();
    await docGate.handler(['okf', 'enable'], {}, dir, {});
    // Deterministic core: calling the function directly writes the same bundle.
    const direct = generateBundle({ root: dir, source: 'docs', out: '.okf' });
    const res = await docGate.handler(['okf', 'generate', '--source', 'docs', '--out', '.okf', '--json'], {}, dir, {});
    expect(res.success).toBe(true);
    expect(JSON.parse(res.output)).toEqual(direct);
  });

  test('unknown okf action is an error (exit 1)', async () => {
    const dir = makeDocsRepo();
    const res = await docGate.handler(['okf', 'bogus'], {}, dir, {});
    expect(res.success).toBe(false);
    expect(res.exitCode).toBe(1);
  });

  test('link writes AGENTS.md nav (exit 0) when enabled', async () => {
    const dir = makeDocsRepo();
    await docGate.handler(['okf', 'enable'], {}, dir, {});
    await docGate.handler(['okf', 'generate', '--source', 'docs', '--out', '.okf'], {}, dir, {});
    const res = await docGate.handler(['okf', 'link', '--out', '.okf', '--json'], {}, dir, {});
    expect(res.success).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toContain('.okf/index.md');
  });

  test('link refuses when disabled (exit 1)', async () => {
    const dir = makeDocsRepo();
    const res = await docGate.handler(['okf', 'link', '--out', '.okf'], {}, dir, {});
    expect(res.success).toBe(false);
    expect(res.exitCode).toBe(1);
    expect(res.error).toMatch(/disabled/i);
  });
});
