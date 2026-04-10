const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { afterEach, describe, expect, setDefaultTimeout, test } = require('bun:test');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'beads-upgrade-smoke.sh');
const GIT_BASH_PATH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const tempDirs = [];

setDefaultTimeout(20000);

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

function makeTempDir(prefix = 'beads-upgrade-smoke-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function createMockBd() {
  const mockBin = makeTempDir('beads-upgrade-smoke-bin-');
  const logPath = path.join(mockBin, 'bd-calls.log');
  const mockBd = path.join(mockBin, 'bd');
  writeExecutable(
    mockBd,
    `#!/usr/bin/env bash
set -euo pipefail
LOG_PATH="\${MOCK_BD_LOG_PATH:?}"
FAIL_STEP="\${MOCK_BD_FAIL_STEP:-}"
CREATE_COUNT_FILE="\${MOCK_BD_CREATE_COUNT_FILE:-}"

printf '%s\\n' "$*" >> "$LOG_PATH"

if [[ -n "$FAIL_STEP" && "$1" == "$FAIL_STEP" ]]; then
  echo "mock bd failure on $1" >&2
  exit 42
fi

case "$1" in
  create)
    if [[ -n "$CREATE_COUNT_FILE" ]]; then
      count=0
      if [[ -f "$CREATE_COUNT_FILE" ]]; then
        count="$(cat "$CREATE_COUNT_FILE")"
      fi
      count=$((count + 1))
      printf '%s' "$count" > "$CREATE_COUNT_FILE"
      echo "Created issue: forge-smoke-$count"
    else
      echo "Created issue: forge-smoke-1"
    fi
    ;;
  list)
    printf '[{"id":"forge-smoke-1"},{"id":"forge-smoke-2"}]\\n'
    ;;
  show)
    printf '{"id":"%s","status":"open"}\\n' "$2"
    ;;
  dep)
    echo "dependency added"
    ;;
  close)
    echo "Closed issue: $2"
    ;;
  sync)
    echo "Synced beads state"
    ;;
  *)
    echo "unexpected mock bd command: $1" >&2
    exit 64
    ;;
esac
`,
  );
  return { mockBd, logPath };
}

function runSmoke(repoDir, env = {}) {
  const mergedEnv = {
    ...process.env,
    ...env,
  };
  if (process.platform === 'win32' && env.PATH) {
    mergedEnv.Path = env.PATH;
  }

  return spawnSync(resolveBashCommand(), [toBashPath(SCRIPT)], {
    cwd: repoDir,
    encoding: 'utf8',
    env: mergedEnv,
    timeout: 30000,
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('beads-upgrade-smoke.sh', () => {
  test('runs the full post-upgrade bd command sequence and records cleanup', () => {
    const repoDir = makeTempDir();
    fs.mkdirSync(path.join(repoDir, '.beads'), { recursive: true });

    const artifactDir = path.join(repoDir, '.artifacts', 'beads-upgrade-smoke');
    const createCountFile = path.join(repoDir, 'create-count.txt');
    const { mockBd, logPath } = createMockBd();

    const result = runSmoke(repoDir, {
      BD_CMD: toBashPath(mockBd),
      BEADS_UPGRADE_SMOKE_ARTIFACT_DIR: toBashPath(artifactDir),
      MOCK_BD_LOG_PATH: toBashPath(logPath),
      MOCK_BD_CREATE_COUNT_FILE: toBashPath(createCountFile),
    });

    expect(result.status).toBe(0);

    const summary = JSON.parse(fs.readFileSync(path.join(artifactDir, 'summary.json'), 'utf8'));
    expect(summary.ok).toBe(true);
    expect(summary.failedStep).toBeNull();
    expect([...summary.cleanup.closedIssueIds].sort()).toEqual(['forge-smoke-1', 'forge-smoke-2']);
    expect(summary.commands.map((command) => command.step)).toEqual([
      'create-primary',
      'create-dependent',
      'list',
      'show-primary',
      'dep-add',
      'close-dependent',
      'close-primary',
      'sync',
    ]);

    const calls = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/);
    expect(calls).toEqual([
      'create --title=Beads upgrade smoke primary --type=task --priority=4',
      'create --title=Beads upgrade smoke dependent --type=task --priority=4',
      'list --json --limit=0',
      'show forge-smoke-1 --json',
      'dep add forge-smoke-1 forge-smoke-2',
      'close forge-smoke-2 --reason=Beads upgrade smoke cleanup',
      'close forge-smoke-1 --reason=Beads upgrade smoke cleanup',
      'sync',
    ]);
  });

  test('fails closed and writes a failure artifact when any bd command errors', () => {
    const repoDir = makeTempDir();
    fs.mkdirSync(path.join(repoDir, '.beads'), { recursive: true });

    const artifactDir = path.join(repoDir, '.artifacts', 'beads-upgrade-smoke');
    const createCountFile = path.join(repoDir, 'create-count.txt');
    const { mockBd, logPath } = createMockBd();

    const result = runSmoke(repoDir, {
      BD_CMD: toBashPath(mockBd),
      BEADS_UPGRADE_SMOKE_ARTIFACT_DIR: toBashPath(artifactDir),
      MOCK_BD_LOG_PATH: toBashPath(logPath),
      MOCK_BD_CREATE_COUNT_FILE: toBashPath(createCountFile),
      MOCK_BD_FAIL_STEP: 'sync',
    });

    expect(result.status).toBe(1);

    const summary = JSON.parse(fs.readFileSync(path.join(artifactDir, 'summary.json'), 'utf8'));
    expect(summary.ok).toBe(false);
    expect(summary.failedStep).toBe('sync');
    expect(summary.commands.map((command) => command.step)).toEqual([
      'create-primary',
      'create-dependent',
      'list',
      'show-primary',
      'dep-add',
      'close-dependent',
      'close-primary',
      'sync',
    ]);
    expect(summary.failureArtifact.replace(/\\/g, '/')).toBe(
      path.join(artifactDir, 'summary.json').replace(/\\/g, '/'),
    );

    const calls = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/);
    expect(calls[calls.length - 1]).toBe('sync');
  });
});
