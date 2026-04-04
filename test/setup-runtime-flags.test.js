const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, test } = require('bun:test');
const setupCommand = require('../lib/commands/setup');
const { checkLefthookStatus } = require('../lib/lefthook-check');
const { detectHusky } = require('../lib/husky-migration');

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
  const originalEnv = { INIT_CWD: process.env.INIT_CWD, PATH: process.env.PATH, Path: process.env.Path };
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const stdout = [];
  const stderr = [];
  const mockBinDir = path.join(cwd, '.mock-bin');

  fs.mkdirSync(mockBinDir, { recursive: true });
  writeExecutable(path.join(mockBinDir, 'bd'), '#!/usr/bin/env bash\necho \"bd 0.49.1\"\n');
  writeExecutable(path.join(mockBinDir, 'gh'), '#!/usr/bin/env bash\nif [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then\n  echo \"Logged in\"\n  exit 0\nfi\necho \"gh version 2.81.0\"\n');
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

    await setupCommand.handler(args, {}, cwd);
    return {
      status: 0,
      stdout: stdout.join(''),
      stderr: stderr.join(''),
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
    expect(result.stdout).toContain('.cursor/commands/');
    expect(result.stdout).not.toContain('.roo/commands/');
    expect(result.stdout).not.toContain('.claude/commands/plan.md');
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
    expect(result.stdout).toContain('Keeping existing .claude/commands/ (--keep)');
    expect(fs.readFileSync(path.join(claudeDir, 'plan.md'), 'utf8')).toBe(sentinel);
  });

  serialTest('--agents accepts multiple space-separated values on the setup handler path', async () => {
    const tmpDir = makeTempDir();

    const result = await runSetup(['--agents', 'claude', 'cursor', '--dry-run'], tmpDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('.claude/commands/plan.md');
    expect(result.stdout).toContain('.cursor/commands/');
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

  serialTest('setup scaffolds Codex stage skills under .codex/skills/<stage>/SKILL.md', async () => {
    const tmpDir = makeTempDir();

    const result = await runSetup(['--agents', 'codex', '--skip-external'], tmpDir);

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'skills', 'plan', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'skills', 'dev', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.codex', 'skills', 'SKILL.md'))).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, '.codex', 'skills', 'plan', 'SKILL.md'), 'utf8')).toContain('`forge plan`');
    expect(fs.readFileSync(path.join(tmpDir, '.codex', 'skills', 'plan', 'SKILL.md'), 'utf8')).toContain('# Plan');
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'commands', 'plan.md'))).toBe(false);
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

  serialTest('setup scaffolds Kilo native surfaces through the real setup path', async () => {
    const tmpDir = makeTempDir();

    const result = await runSetup(['--agents', 'kilocode', '--skip-external'], tmpDir);

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, '.kilocode', 'workflows', 'forge-workflow.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.kilocode', 'rules', 'workflow.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.kilocode', 'skills', 'forge-workflow', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.kilo.md'))).toBe(false);
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

  serialTest('checkPrerequisites requires jq when setup is preparing workflow-capable installs', () => {
    const originalExit = process.exit;
    const originalLog = console.log;
    const logLines = [];

    process.exit = (code) => {
      throw new Error(`process.exit:${code}`);
    };
    console.log = (...parts) => logLines.push(parts.join(' '));

    try {
      expect(() => setupCommand.checkPrerequisites({
        requireGithubCli: false,
        requireJq: true,
        commandRunner: (command) => {
          if (command === 'git --version') {
            return 'git version 2.42.0';
          }
          return '';
        },
      })).toThrow(/process\.exit:1/);
    } finally {
      process.exit = originalExit;
      console.log = originalLog;
    }

    expect(logLines.join('\n')).toContain('jq - Install from https://jqlang.org/download/');
  });

  serialTest('checkPrerequisites requires bd when setup is preparing workflow-capable installs', () => {
    const originalExit = process.exit;
    const originalLog = console.log;
    const logLines = [];

    process.exit = (code) => {
      throw new Error(`process.exit:${code}`);
    };
    console.log = (...parts) => logLines.push(parts.join(' '));

    try {
      expect(() => setupCommand.checkPrerequisites({
        requireBeadsCli: true,
        requireGithubCli: false,
        commandRunner: (command) => {
          if (command === 'git --version') {
            return 'git version 2.42.0';
          }
          return '';
        },
      })).toThrow(/process\.exit:1/);
    } finally {
      process.exit = originalExit;
      console.log = originalLog;
    }

    expect(logLines.join('\n')).toContain('bd (Beads CLI) - Install from https://github.com/steveyegge/beads');
  });

  serialTest('workflow-backed setup requires an executable Git Bash runtime on Windows', () => {
    expect(() => setupCommand.ensureWorkflowShellPolicy(['claude'], {
      platform: 'win32',
      candidates: [],
      _exists: () => false,
    })).toThrow(/Git Bash/i);
  });

  serialTest('setup repairs a declared lefthook dependency before reporting success', async () => {
    const tmpDir = makeTempDir();
    const mockBinDir = path.join(tmpDir, '.mock-bin');
    fs.mkdirSync(mockBinDir, { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      name: 'repair-fixture',
      version: '1.0.0',
      devDependencies: {
        lefthook: '^2.1.4',
      },
    }, null, 2));

    writeExecutable(path.join(mockBinDir, 'npm'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "install" ]]; then
  mkdir -p "$INIT_CWD/node_modules/.bin"
  printf '#!/usr/bin/env bash\\necho lefthook\\n' > "$INIT_CWD/node_modules/.bin/lefthook"
  printf '@echo off\\r\\necho lefthook\\r\\n' > "$INIT_CWD/node_modules/.bin/lefthook.cmd"
  chmod +x "$INIT_CWD/node_modules/.bin/lefthook"
  exit 0
fi
echo "unexpected npm args: $*" >&2
exit 1
`);

    writeExecutable(path.join(mockBinDir, 'npx'), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "lefthook" && "$2" == "install" ]]; then
  exit 0
fi
echo "unexpected npx args: $*" >&2
exit 1
`);

    const result = await runSetup(['--agents', 'claude', '--skip-external'], tmpDir, {
      PATH: `${mockBinDir}${path.delimiter}${process.env.PATH}`,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Installing lefthook dependencies (binary missing)');
    expect(checkLefthookStatus(tmpDir).binaryAvailable).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'node_modules', '.bin', 'lefthook'))).toBe(true);
  });

  serialTest('detectHusky resolves worktree gitdir pointer files when checking hooksPath', () => {
    const tmpDir = makeTempDir();
    const gitDir = path.join(tmpDir, '.git-data', 'worktrees', 'feature-a');

    fs.mkdirSync(path.join(tmpDir, '.husky'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.husky', 'pre-commit'), '#!/bin/sh\nnpx lint-staged\n');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'config'), '[core]\n\thooksPath = .husky\n');
    fs.writeFileSync(path.join(tmpDir, '.git'), 'gitdir: .git-data/worktrees/feature-a\n');

    const result = detectHusky(tmpDir);

    expect(result.found).toBe(true);
    expect(result.hasHooksPath).toBe(true);
  });
});
