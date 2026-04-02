const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { afterEach, describe, expect, test } = require('bun:test');

const repoRoot = path.resolve(__dirname, '..');
const forgeBin = path.join(repoRoot, 'bin', 'forge.js');

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-setup-runtime-'));
  tempDirs.push(dir);
  return dir;
}

function runSetup(args, cwd) {
  return spawnSync(process.execPath, [forgeBin, 'setup', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      INIT_CWD: cwd,
    },
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('setup runtime flags', () => {
  test('--detect auto-selects configured agents on the live CLI path', () => {
    const tmpDir = makeTempDir();
    fs.mkdirSync(path.join(tmpDir, '.cursor', 'rules'), { recursive: true });

    const result = runSetup(['--detect', '--dry-run'], tmpDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Auto-detected agents (--detect): cursor');
    expect(result.stdout).toContain('.cursor/commands/');
    expect(result.stdout).not.toContain('.roo/commands/');
    expect(result.stdout).not.toContain('.claude/commands/plan.md');
  });

  test('--keep preserves existing Claude commands at runtime', () => {
    const tmpDir = makeTempDir();
    const claudeDir = path.join(tmpDir, '.claude', 'commands');
    fs.mkdirSync(claudeDir, { recursive: true });
    const sentinel = 'keep-this-command\n';
    fs.writeFileSync(path.join(claudeDir, 'plan.md'), sentinel);
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# existing\n');

    const result = runSetup(['--agents', 'claude', '--keep', '--skip-external'], tmpDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Keeping existing .claude/commands/ (--keep)');
    expect(fs.readFileSync(path.join(claudeDir, 'plan.md'), 'utf8')).toBe(sentinel);
  });

  test('--agents accepts multiple space-separated values on the live CLI path', () => {
    const tmpDir = makeTempDir();

    const result = runSetup(['--agents', 'claude', 'cursor', '--dry-run'], tmpDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('.claude/commands/plan.md');
    expect(result.stdout).toContain('.cursor/commands/');
  });

  test('--dry-run shows workflow runtime assets that shipped commands require', () => {
    const tmpDir = makeTempDir();

    const result = runSetup(['--agents', 'claude', '--dry-run'], tmpDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('scripts/smart-status.sh');
    expect(result.stdout).toContain('scripts/forge-team/index.sh');
    expect(result.stdout).toContain('.claude/scripts/greptile-resolve.sh');
  });

  test('setup scaffolds workflow runtime assets before reporting success', () => {
    const tmpDir = makeTempDir();

    const result = runSetup(['--agents', 'claude', '--skip-external'], tmpDir);

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, 'scripts', 'smart-status.sh'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'scripts', 'lib', 'sanitize.sh'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'scripts', 'forge-team', 'index.sh'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'scripts', 'greptile-resolve.sh'))).toBe(true);
  });
});
