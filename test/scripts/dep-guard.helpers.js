const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setDefaultTimeout } = require('bun:test');

setDefaultTimeout(15000);

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'dep-guard.sh');
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const GIT_BASH_PATH = 'C:\\Program Files\\Git\\bin\\bash.exe';

function resolveBashCommand() {
  if (process.env.BASH_CMD) {
    return process.env.BASH_CMD;
  }

  if (process.platform === 'win32' && fs.existsSync(GIT_BASH_PATH)) {
    return GIT_BASH_PATH;
  }

  return 'bash';
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
  const mockPath = path.join(
    os.tmpdir(),
    `mock-bd-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`,
  );
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
