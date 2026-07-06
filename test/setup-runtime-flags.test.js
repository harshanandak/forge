const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');
const setupCommand = require('../lib/commands/setup');

const tempDirs = [];
let serialQueue = Promise.resolve();

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-setup-runtime-'));
  tempDirs.push(dir);
  return dir;
}

function serialTest(name, callback) {
  test(name, () => {
    const currentRun = serialQueue.then(() => callback());
    serialQueue = currentRun.catch(() => {});
    return currentRun;
  });
}

async function runSetup(args, cwd, env = {}) {
  const originalEnv = {
    INIT_CWD: process.env.INIT_CWD,
    PATH: process.env.PATH,
    Path: process.env.Path,
    CODEX_HOME: process.env.CODEX_HOME,
  };
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const stdout = [];
  const stderr = [];
  const mockBinDir = path.join(cwd, '.mock-bin');
  const disableGh = env.FORGE_TEST_DISABLE_GH === '1';
  const commandRunner = (command) => {
    switch (command) {
      case 'git --version':
        return 'git version 2.42.0';
      case 'gh --version':
        return disableGh ? '' : 'gh version 2.81.0';
      case 'gh auth status':
        return disableGh ? '' : 'Logged in';
      case 'bd --version':
        return 'bd 1.0.0';
      case 'jq --version':
        return 'jq-1.8.1';
      default:
        return '';
    }
  };

  fs.mkdirSync(mockBinDir, { recursive: true });
  writeExecutable(path.join(mockBinDir, 'bd'), '#!/usr/bin/env bash\necho \"bd 1.0.0\"\n');
  if (!disableGh) {
    writeExecutable(path.join(mockBinDir, 'gh'), '#!/usr/bin/env bash\nif [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then\n  echo \"Logged in\"\n  exit 0\nfi\necho \"gh version 2.81.0\"\n');
  }
  writeExecutable(path.join(mockBinDir, 'jq'), '#!/usr/bin/env bash\necho \"jq-1.8.1\"\n');

  for (const [key, value] of Object.entries(env)) {
    originalEnv[key] = process.env[key];
    process.env[key] = value;
  }
  process.env.INIT_CWD = cwd;
  const inheritedPath = process.env.PATH || process.env.Path || originalEnv.PATH || originalEnv.Path || '';
  process.env.PATH = `${mockBinDir}${path.delimiter}${inheritedPath}`;
  process.env.Path = process.env.PATH;

  console.log = (...parts) => stdout.push(parts.join(' '));
  console.warn = (...parts) => stderr.push(parts.join(' '));
  console.error = (...parts) => stderr.push(parts.join(' '));
  process.stdout.write = ((chunk, encoding, callback) => {
    stdout.push(typeof chunk === 'string' ? chunk : chunk.toString(encoding || 'utf8'));
    if (typeof callback === 'function') callback();
    return true;
  });
  process.stderr.write = ((chunk, encoding, callback) => {
    stderr.push(typeof chunk === 'string' ? chunk : chunk.toString(encoding || 'utf8'));
    if (typeof callback === 'function') callback();
    return true;
  });

  try {
    setupCommand._setState({
      projectRoot: cwd,
      FORCE_MODE: false,
      VERBOSE_MODE: false,
      NON_INTERACTIVE: false,
      SYMLINK_ONLY: false,
      SYNC_ENABLED: false,
      PKG_MANAGER: 'npm',
    });

    const commandResult = await setupCommand.handler(args, { commandRunner }, cwd);
    return {
      status: commandResult && commandResult.success === false ? 1 : 0,
      stdout: stdout.join(''),
      stderr: `${stderr.join('')}${commandResult && commandResult.error ? commandResult.error : ''}`,
    };
  } catch (error) {
    return {
      status: 1,
      stdout: stdout.join(''),
      stderr: `${stderr.join('')}${error && error.message ? error.message : String(error)}`,
    };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
  if (process.platform === 'win32' && path.extname(filePath) === '') {
    const base = path.basename(filePath);
    const cmdPath = `${filePath}.cmd`;
    fs.writeFileSync(cmdPath, `@echo off\r\nbash \"%~dp0\\${base}\" %*\r\n`, { mode: 0o755 });
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('setup runtime flags', () => {
  serialTest('--detect auto-selects configured agents on the setup handler path', async () => {
    const tmpDir = makeTempDir();
    fs.mkdirSync(path.join(tmpDir, '.cursor', 'rules'), { recursive: true });

    const result = await runSetup(['--detect', '--dry-run'], tmpDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Auto-detected agents (--detect): cursor');
    expect(result.stdout).toContain('.cursor/skills/');
    expect(result.stdout).not.toContain('.codex/skills/');
    expect(result.stdout).not.toContain('.claude/commands/plan.md');
  });

  serialTest('--minimal delegates to forge init minimal profile without requiring Beads', async () => {
    const tmpDir = makeTempDir();

    const result = await runSetup(['--minimal'], tmpDir, {
      FORGE_TEST_DISABLE_GH: '1',
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, '.forge', 'config.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.beads'))).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, '.forge', 'config.yaml'), 'utf8')).toContain('profile: minimal');
  });

  serialTest('setup rejects conflicting adoption profile flags', async () => {
    const tmpDir = makeTempDir();

    const result = await runSetup(['--minimal', '--full'], tmpDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Conflicting profile flags');
    expect(fs.existsSync(path.join(tmpDir, '.forge', 'config.yaml'))).toBe(false);
  });

  serialTest('--keep preserves existing Claude commands at runtime', async () => {
    const tmpDir = makeTempDir();
    const claudeDir = path.join(tmpDir, '.claude', 'commands');
    fs.mkdirSync(claudeDir, { recursive: true });
    const sentinel = 'keep-this-command\n';
    fs.writeFileSync(path.join(claudeDir, 'plan.md'), sentinel);
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# existing\n');

    const result = await runSetup(['--agents', 'claude', '--keep', '--skip-external'], tmpDir);

    expect(result.status).toBe(0);
    // .claude/commands/ is no longer a forge-managed surface (removed in A0d);
    // the file survives untouched regardless of --keep since setup never writes there.
    expect(fs.readFileSync(path.join(claudeDir, 'plan.md'), 'utf8')).toBe(sentinel);
  });

  serialTest('--agents accepts multiple space-separated values on the setup handler path', async () => {
    const tmpDir = makeTempDir();

    const result = await runSetup(['--agents', 'claude', 'cursor', '--dry-run'], tmpDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('.claude/skills/plan/SKILL.md');
    expect(result.stdout).toContain('.cursor/skills/');
  });

  serialTest('--dry-run shows workflow runtime assets that shipped commands require', async () => {
    const tmpDir = makeTempDir();

    const result = await runSetup(['--agents', 'claude', '--dry-run'], tmpDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('scripts/smart-status.sh');
    expect(result.stdout).toContain('scripts/forge-team/index.sh');
    expect(result.stdout).toContain('.claude/scripts/greptile-resolve.sh');
  });

  serialTest('setup scaffolds workflow runtime assets before reporting success', async () => {
    const tmpDir = makeTempDir();

    const result = await runSetup(['--agents', 'claude', '--skip-external'], tmpDir);

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, 'scripts', 'smart-status.sh'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'scripts', 'lib', 'sanitize.sh'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'scripts', 'forge-team', 'index.sh'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'scripts', 'greptile-resolve.sh'))).toBe(true);
  });

  serialTest('bare setup --sync removes deprecated generated sync files', async () => {
    const tmpDir = makeTempDir();
    const syncFile = path.join(tmpDir, '.github', 'scripts', 'beads-sync', 'index.mjs');
    fs.mkdirSync(path.dirname(syncFile), { recursive: true });
    fs.writeFileSync(syncFile, '# Generated by Forge GitHub-Beads sync\nconsole.log("old");\n', 'utf8');

    const result = await runSetup(['--sync'], tmpDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Beads GitHub sync scaffolding is deprecated (--sync).');
    expect(fs.existsSync(syncFile)).toBe(false);
  });

  serialTest('setup installs Codex stage skills into CODEX_HOME/skills/<stage>/SKILL.md', async () => {
    const tmpDir = makeTempDir();
    const codexHome = path.join(tmpDir, '.codex-home');

    const result = await runSetup(['--agents', 'codex', '--skip-external'], tmpDir, {
      CODEX_HOME: codexHome,
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(codexHome, 'skills', 'plan', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(codexHome, 'skills', 'dev', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'skills', 'plan', 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '$CODEX_HOME', 'skills'))).toBe(false);
    expect(fs.readFileSync(path.join(codexHome, 'skills', 'plan', 'SKILL.md'), 'utf8')).toContain('`forge plan`');
    expect(fs.readFileSync(path.join(codexHome, 'skills', 'plan', 'SKILL.md'), 'utf8')).toContain('# Plan');
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'commands', 'plan.md'))).toBe(false);
    expect(result.stdout).toContain('Installed: Codex stage skills');
    expect(result.stdout).not.toContain('Created: Codex stage skills');
  });

  serialTest('setup reports partial Codex setup when discoverable skills cannot be installed', async () => {
    const tmpDir = makeTempDir();
    const codexHomeFile = path.join(tmpDir, 'codex-home-file');
    fs.writeFileSync(codexHomeFile, 'not-a-directory');

    const result = await runSetup(['--agents', 'codex', '--skip-external'], tmpDir, {
      CODEX_HOME: codexHomeFile,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Forge setup partially complete');
    expect(result.stdout).toContain('Codex repo instructions installed, but skills are not discoverable in this environment');
  });

  serialTest('setup scaffolds Cursor native rules through the real setup path', async () => {
    const tmpDir = makeTempDir();

    const result = await runSetup(['--agents', 'cursor', '--skip-external'], tmpDir);

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'rules', 'forge-workflow.mdc'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'rules', 'tdd-enforcement.mdc'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'rules', 'security-scanning.mdc'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'rules', 'documentation.mdc'))).toBe(true);
  });

  serialTest('checkPrerequisites allows missing gh during local scaffold-only setup', () => {
    const result = setupCommand.checkPrerequisites({
      requireGithubCli: false,
      commandRunner: (command) => {
        if (command === 'git --version') {
          return 'git version 2.42.0';
        }
        return '';
      },
    });

    expect(result.errors).toEqual([]);
    expect(result.warnings).toContain('gh (GitHub CLI) - Install from https://cli.github.com (required later for GitHub-integrated workflow steps)');
  });

  serialTest('checkPrerequisites treats missing jq as a soft warning, not a fatal exit', () => {
    const originalExit = process.exit;
    const originalLog = console.log;
    const logLines = [];
    let exited = false;

    process.exit = () => {
      exited = true;
      throw new Error('process.exit should not be called on the jq path');
    };
    console.log = (...parts) => logLines.push(parts.join(' '));

    let result;
    try {
      result = setupCommand.checkPrerequisites({
        requireGithubCli: false,
        requireJq: true,
        commandRunner: (command) => {
          if (command === 'git --version') {
            return 'git version 2.42.0';
          }
          return '';
        },
      });
    } finally {
      process.exit = originalExit;
      console.log = originalLog;
    }

    expect(exited).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.errors.some(err => /jq/i.test(err))).toBe(false);
    expect(result.warnings.some(warn => /jq/i.test(warn))).toBe(true);
  });

  serialTest('checkPrerequisites reports the kernel issue store without requiring a bd CLI', () => {
    const originalLog = console.log;
    const logLines = [];
    console.log = (...parts) => logLines.push(parts.join(' '));

    let result;
    try {
      result = setupCommand.checkPrerequisites({
        requireBeadsCli: true,
        requireGithubCli: false,
        commandRunner: (command) => {
          if (command === 'git --version') return 'git version 2.42.0';
          if (command === 'jq --version') return 'jq-1.8.1';
          return '';
        },
      });
    } finally {
      console.log = originalLog;
    }

    // No external issue-tracker CLI is required, and no dolt-remote guidance is emitted.
    expect(result.errors).toEqual([]);
    const output = logLines.join('\n');
    expect(output).toContain('Kernel issue store');
    expect(output).not.toMatch(/\bbd\b|\bdolt\b/i);
  });

});
