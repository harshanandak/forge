const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { afterEach, describe, expect, test } = require('bun:test');

const tempDirs = [];
const SCRIPT = path.join(__dirname, '..', 'scripts', 'sync-utils.sh');
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

function toBashPath(filePath) {
  if (process.platform !== 'win32') {
    return filePath;
  }
  return filePath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
}

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sync-utils-'));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function runSyncUtils(command, env = {}, cwd = process.cwd()) {
  const mergedEnv = {
    ...process.env,
    ...env,
  };
  if (process.platform === 'win32' && env.PATH) {
    mergedEnv.Path = env.PATH;
  }

  return spawnSync(resolveBashCommand(), [toBashPath(SCRIPT), command], {
    cwd,
    encoding: 'utf8',
    env: mergedEnv,
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('sync-utils.sh', () => {
  test('auto-sync warns clearly when the Beads Dolt origin remote is missing', () => {
    const repoDir = makeTempDir();
    fs.mkdirSync(path.join(repoDir, '.beads'), { recursive: true });

    const mockBin = makeTempDir();
    const mockBd = path.join(mockBin, 'bd');
    writeExecutable(mockBd, `#!/usr/bin/env bash
if [[ "$1 $2 $3" == "dolt remote list" ]]; then
  echo "No remotes configured."
  exit 0
fi
exit 0
`);

    const result = runSyncUtils('auto-sync', {
      BD_CMD: toBashPath(mockBd),
    }, repoDir);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("sync skipped, Beads Dolt remote 'origin' is not configured");
  });

  test('auto-sync warns clearly when bd is unavailable', () => {
    const repoDir = makeTempDir();
    fs.mkdirSync(path.join(repoDir, '.beads'), { recursive: true });

    const result = runSyncUtils('auto-sync', {
      BD_CMD: toBashPath(path.join(repoDir, 'definitely-missing-bd')),
    }, repoDir);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("sync skipped, unable to inspect Beads Dolt remotes");
  });

  test('auto-sync reports inspect failure when bd remote listing exits non-zero', () => {
    const repoDir = makeTempDir();
    fs.mkdirSync(path.join(repoDir, '.beads'), { recursive: true });

    const mockBin = makeTempDir();
    const mockBd = path.join(mockBin, 'bd');
    writeExecutable(mockBd, `#!/usr/bin/env bash
if [[ "$1 $2 $3" == "dolt remote list" ]]; then
  exit 2
fi
exit 0
`);

    const result = runSyncUtils('auto-sync', {
      BD_CMD: toBashPath(mockBd),
    }, repoDir);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("sync skipped, unable to inspect Beads Dolt remotes");
    expect(result.stderr).not.toContain("is not configured");
  });

  test('auto-sync honors the configured sync remote name', () => {
    const repoDir = makeTempDir();
    fs.mkdirSync(path.join(repoDir, '.beads'), { recursive: true });

    const mockBin = makeTempDir();
    const mockBd = path.join(mockBin, 'bd');
    writeExecutable(mockBd, `#!/usr/bin/env bash
if [[ "$1 $2 $3" == "dolt remote list" ]]; then
  echo "upstream file:///tmp/forge-beads"
  exit 0
fi
if [[ "$1 $2" == "dolt pull" || "$1 $2" == "dolt push" ]]; then
  exit 0
fi
exit 0
`);

    const result = runSyncUtils('auto-sync', {
      BD_CMD: toBashPath(mockBd),
      BD_SYNC_REMOTE: 'upstream',
      BD_SYNC_CMD: 'true',
    }, repoDir);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(fs.existsSync(path.join(repoDir, '.beads', '.last-sync'))).toBe(true);
  });
});
