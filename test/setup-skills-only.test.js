'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { afterEach, describe, expect, test } = require('bun:test');

const FORGE_BIN = path.join(__dirname, '..', 'bin', 'forge.js');
const tempDirs = [];
const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

function makeTempRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-skills-only-'));
  tempDirs.push(repo);
  spawnSync('git', ['init'], { cwd: repo, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.email', 'forge@test.invalid'], { cwd: repo });
  spawnSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repo });
  return repo;
}

function runSetup(repo, ...args) {
  return spawnSync(
    process.execPath,
    [FORGE_BIN, 'setup', '--agents', 'claude', '--skip-external', ...args, '--path', repo],
    {
      cwd: repo,
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, INIT_CWD: repo },
    },
  );
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('forge setup --skills-only', () => {
  test('installs skills while leaving Git, Forge-native, and Claude hooks absent', () => {
    if (!gitAvailable) return;
    const repo = makeTempRepo();
    const result = runSetup(repo, '--skills-only');
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    const settingsPath = path.join(repo, '.claude', 'settings.json');

    expect(result.status).toBe(0);
    expect(output).not.toContain('Installing git hooks');
    expect(fs.existsSync(path.join(repo, '.claude', 'skills', 'plan', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(repo, 'lefthook.yml'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.forge', 'hooks', 'check-tdd.js'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.forge', 'hooks', 'forge-native-hook.js'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.git', 'hooks', 'pre-commit'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks).toBeUndefined();
  }, 120000);

  test('keeps default setup hook installation unchanged and reruns safely', () => {
    if (!gitAvailable) return;
    const repo = makeTempRepo();
    const first = runSetup(repo);
    const second = runSetup(repo);
    const output = `${first.stdout || ''}${first.stderr || ''}${second.stdout || ''}${second.stderr || ''}`;

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(output).toContain('Native git hooks installed');
    expect(fs.existsSync(path.join(repo, '.forge', 'hooks', 'check-tdd.js'))).toBe(true);
    expect(fs.existsSync(path.join(repo, '.git', 'hooks', 'pre-commit'))).toBe(true);
    expect(fs.readFileSync(path.join(repo, '.claude', 'settings.json'), 'utf8')).toContain('hooks');
  }, 120000);

  test('accepts --no-hooks as an alias for --skills-only', () => {
    if (!gitAvailable) return;
    const repo = makeTempRepo();
    const result = runSetup(repo, '--no-hooks');

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(repo, '.claude', 'skills', 'plan', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(repo, '.git', 'hooks', 'pre-commit'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.forge', 'hooks'))).toBe(false);
  }, 120000);
});
