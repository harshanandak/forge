const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setDefaultTimeout } = require('bun:test');

setDefaultTimeout(15000);

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'dep-guard.sh');
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const GIT_BASH_PATH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const MOCK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-guard-mocks-'));
let cachedBashCommand;
let mockFileSequence = 0;

function resolveBashCommand() {
  if (cachedBashCommand) {
    return cachedBashCommand;
  }
  if (process.env.BASH_CMD) {
    cachedBashCommand = process.env.BASH_CMD;
    return cachedBashCommand;
  }

  if (process.platform === 'win32' && fs.existsSync(GIT_BASH_PATH)) {
    cachedBashCommand = GIT_BASH_PATH;
    return cachedBashCommand;
  }

  cachedBashCommand = 'bash';
  return cachedBashCommand;
}

function runDepGuard(args = [], env = {}, cwd = PROJECT_ROOT) {
  const result = spawnSync(resolveBashCommand(), [SCRIPT, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 15000,
    env: {
      ...process.env,
      ...env,
    },
  });

  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error,
  };
}

function createMockBd(scriptContent) {
  mockFileSequence += 1;
  const mockPath = path.join(MOCK_ROOT, `mock-bd-${process.pid}-${mockFileSequence}.sh`);
  fs.writeFileSync(mockPath, `#!/usr/bin/env bash\n${scriptContent}\n`, { mode: 0o755 });

  try {
    fs.chmodSync(mockPath, 0o755);
  } catch (_error) {}

  return mockPath;
}

function createTempRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-guard-script-'));

  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, contents, 'utf8');
  }

  return root;
}

module.exports = {
  createMockBd,
  createTempRepo,
  PROJECT_ROOT,
  runDepGuard,
  SCRIPT,
};
