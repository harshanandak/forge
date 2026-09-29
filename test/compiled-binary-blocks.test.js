'use strict';

// forge-test-resource: exclusive

// The compiled binary (`bun build --compile`, see package.json build:binary)
// must carry the contracts, flow and memory building blocks inside itself.
// Build it from a throwaway copy of the tracked tree, delete that copy, then
// run the binary: any block still resolved from source on disk fails here.

const { afterAll, describe, expect, test } = require('bun:test');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'forge-compiled-blocks-'));
const source = path.join(temporary, 'src');
const binary = path.join(temporary, process.platform === 'win32' ? 'forge-bin.exe' : 'forge-bin');

function copyTrackedTree() {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0').filter(Boolean);
  for (const file of tracked) {
    const from = path.join(ROOT, file);
    if (!fs.existsSync(from) || !fs.statSync(from).isFile()) continue;
    const to = path.join(source, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

function run(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, FORGE_SHEPHERD_DISABLE: '1', NO_COLOR: '1' },
  });
}

afterAll(() => {
  fs.rmSync(temporary, { recursive: true, force: true });
});

describe('compiled binary carries the internal building blocks', () => {
  test('runs contracts, flow and memory after the source tree is deleted', () => {
    copyTrackedTree();
    // Link, never copy, the installed dependencies; unlinked before deleting the copy.
    const linkedModules = path.join(source, 'node_modules');
    fs.symlinkSync(path.join(ROOT, 'node_modules'), linkedModules, process.platform === 'win32' ? 'junction' : 'dir');

    const assets = run(process.execPath, ['scripts/gen-embedded-assets.mjs'], source);
    expect(assets.status, assets.stderr).toBe(0);
    const build = run(process.execPath, [
      'build', '--compile', '--define', 'FORGE_COMPILED=true', './bin/forge.js', '--outfile', binary,
    ], source);
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

    fs.unlinkSync(linkedModules);
    expect(fs.existsSync(path.join(ROOT, 'node_modules'))).toBe(true);
    fs.rmSync(source, { recursive: true, force: true });
    expect(fs.existsSync(path.join(source, 'lib', 'contracts'))).toBe(false);

    const project = path.join(temporary, 'project');
    fs.mkdirSync(project);
    expect(run('git', ['init', '-q'], project).status).toBe(0);

    const version = run(binary, ['--version'], project);
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout).toContain(`Forge v${require('../package.json').version}`);

    // lib/commands/shepherd.js loads lib/pr-monitor/flow-monitor.js at module
    // scope, which requires lib/flow and lib/contracts.
    const shepherd = run(binary, ['shepherd', '--help'], project);
    expect(shepherd.status, `${shepherd.stdout}\n${shepherd.stderr}`).toBe(0);
    expect(shepherd.stdout).toContain(require('../lib/commands/shepherd').description);

    // remember/recall go through lib/memory/router.js, which requires lib/memory-core
    // (and lib/memory-core requires lib/contracts).
    const remember = run(binary, ['remember', 'compiled block probe'], project);
    expect(remember.status, `${remember.stdout}\n${remember.stderr}`).toBe(0);
    const recall = run(binary, ['recall', 'probe'], project);
    expect(recall.status, `${recall.stdout}\n${recall.stderr}`).toBe(0);
    expect(recall.stdout).toContain('compiled block probe');
  }, 180000);
});
