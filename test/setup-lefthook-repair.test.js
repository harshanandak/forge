const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, expect, setDefaultTimeout, test } = require('bun:test');
const setupCommand = require('../lib/commands/setup');
const { checkLefthookStatus } = require('../lib/lefthook-check');

const tempDirs = [];

// This test shells through the full setup path and can take longer on
// Windows runners when package-manager subprocesses contend with the rest
// of the suite.
setDefaultTimeout(30000);

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-setup-lefthook-'));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
  if (process.platform === 'win32' && path.extname(filePath) === '') {
    const base = path.basename(filePath);
    const cmdPath = `${filePath}.cmd`;
    fs.writeFileSync(cmdPath, `@echo off\r\nbash \"%~dp0\\${base}\" %*\r\n`, { mode: 0o755 });
  }
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
  const commandRunner = (command) => {
    switch (command) {
      case 'git --version':
        return 'git version 2.42.0';
      case 'gh --version':
        return 'gh version 2.81.0';
      case 'gh auth status':
        return 'Logged in';
      case 'bd --version':
        return 'bd 1.0.0';
      case 'jq --version':
        return 'jq-1.8.1';
      default:
        return '';
    }
  };

  fs.mkdirSync(mockBinDir, { recursive: true });
  writeExecutable(path.join(mockBinDir, 'bd'), '#!/usr/bin/env bash\necho "bd 1.0.0"\n');
  writeExecutable(path.join(mockBinDir, 'gh'), '#!/usr/bin/env bash\nif [ "$1" = "auth" ] && [ "$2" = "status" ]; then\n  echo "Logged in"\n  exit 0\nfi\necho "gh version 2.81.0"\n');
  writeExecutable(path.join(mockBinDir, 'jq'), '#!/usr/bin/env bash\necho "jq-1.8.1"\n');

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

    await setupCommand.handler(args, { commandRunner }, cwd);
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

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('setup lefthook repair', () => {
  test('setup repairs a declared lefthook dependency before reporting success', async () => {
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
if [ "$1" = "install" ]; then
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
if [ "$1" = "lefthook" ] && [ "$2" = "install" ]; then
  exit 0
fi
echo "unexpected npx args: $*" >&2
exit 1
`);

    const result = await runSetup(['--agents', 'claude', '--skip-external'], tmpDir, {
      PATH: `${mockBinDir}${path.delimiter}${process.env.PATH || ''}`,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Installing lefthook dependencies (binary missing)');
    expect(checkLefthookStatus(tmpDir).binaryAvailable).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'node_modules', '.bin', 'lefthook'))).toBe(true);
  });

  test('setup emits a hard actionable warning when declared lefthook cannot be repaired in the worktree', async () => {
    const tmpDir = makeTempDir();
    const mockBinDir = path.join(tmpDir, '.mock-bin');
    fs.mkdirSync(mockBinDir, { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      name: 'repair-warning-fixture',
      version: '1.0.0',
      devDependencies: {
        lefthook: '^2.1.4',
      },
    }, null, 2));

    writeExecutable(path.join(mockBinDir, 'npm'), `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "install" ]; then
  echo "install failed" >&2
  exit 1
fi
echo "unexpected npm args: $*" >&2
exit 1
`);

    const result = await runSetup(['--agents', 'claude', '--skip-external'], tmpDir, {
      PATH: `${mockBinDir}${path.delimiter}${process.env.PATH || ''}`,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Installing lefthook dependencies (binary missing)');
    expect(result.stderr).toContain('raw git push remains unsafe in this worktree');
    expect(result.stdout).toContain('Run npm install in this worktree');
  });
});
