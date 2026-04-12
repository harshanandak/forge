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
UNPARSEABLE_CREATE_ON="\${MOCK_BD_UNPARSEABLE_CREATE_ON:-}"
LIST_JSON="\${MOCK_BD_LIST_JSON:-}"

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
      title="Beads upgrade smoke primary"
      if [[ "$count" -eq 2 ]]; then
        title="Beads upgrade smoke dependent"
      fi
      if [[ -n "$UNPARSEABLE_CREATE_ON" && "$count" -eq "$UNPARSEABLE_CREATE_ON" ]]; then
        echo "created smoke issue output changed for $title"
      else
        echo "Created issue: forge-smoke-$count"
      fi
    else
      echo "Created issue: forge-smoke-1"
    fi
    ;;
  list)
    if [[ -n "$LIST_JSON" ]]; then
      printf '%s\\n' "$LIST_JSON"
    else
      printf '[{"id":"forge-smoke-1","title":"Beads upgrade smoke primary"},{"id":"forge-smoke-2","title":"Beads upgrade smoke dependent"}]\\n'
    fi
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
      BEADS_UPGRADE_SMOKE_RUN_ID: 'test-run',
      MOCK_BD_LOG_PATH: toBashPath(logPath),
      MOCK_BD_CREATE_COUNT_FILE: toBashPath(createCountFile),
    });

    expect(result.status).toBe(0);

    const summary = JSON.parse(fs.readFileSync(path.join(artifactDir, 'summary.json'), 'utf8'));
    expect(summary.ok).toBe(true);
    expect(summary.failedStep).toBeNull();
    expect([...summary.cleanup.closedIssueIds].sort()).toEqual(['forge-smoke-1', 'forge-smoke-2']);
    expect(summary.commands.every((command) => typeof command.stdoutPath === 'string')).toBe(true);
    expect(summary.commands.every((command) => typeof command.stderrPath === 'string')).toBe(true);
    expect(summary.commands.every((command) => !Object.hasOwn(command, 'stdout'))).toBe(true);
    expect(summary.commands.every((command) => !Object.hasOwn(command, 'stderr'))).toBe(true);
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
      'create --title=Beads upgrade smoke primary (test-run) --type=task --priority=4',
      'create --title=Beads upgrade smoke dependent (test-run) --type=task --priority=4',
      'list --json --limit=50',
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
      BEADS_UPGRADE_SMOKE_RUN_ID: 'test-run',
      MOCK_BD_LOG_PATH: toBashPath(logPath),
      MOCK_BD_CREATE_COUNT_FILE: toBashPath(createCountFile),
      MOCK_BD_FAIL_STEP: 'sync',
    });

    expect(result.status).toBe(1);

    const summary = JSON.parse(fs.readFileSync(path.join(artifactDir, 'summary.json'), 'utf8'));
    expect(summary.ok).toBe(false);
    expect(summary.failedStep).toBe('sync');
    expect(summary.commands.every((command) => typeof command.stdoutPath === 'string')).toBe(true);
    expect(summary.commands.every((command) => typeof command.stderrPath === 'string')).toBe(true);
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

  test('rolls back the created primary issue when create output cannot be parsed', () => {
    const repoDir = makeTempDir();
    fs.mkdirSync(path.join(repoDir, '.beads'), { recursive: true });

    const artifactDir = path.join(repoDir, '.artifacts', 'beads-upgrade-smoke');
    const createCountFile = path.join(repoDir, 'create-count.txt');
    const { mockBd, logPath } = createMockBd();
    const smokeTitle = 'Beads upgrade smoke primary (test-run)';
    const listJson = JSON.stringify([
      { id: 'forge-stale-1', title: 'Beads upgrade smoke primary' },
      { id: 'forge-smoke-1', title: smokeTitle },
    ]);

    const result = runSmoke(repoDir, {
      BD_CMD: toBashPath(mockBd),
      BEADS_UPGRADE_SMOKE_ARTIFACT_DIR: toBashPath(artifactDir),
      BEADS_UPGRADE_SMOKE_RUN_ID: 'test-run',
      MOCK_BD_LOG_PATH: toBashPath(logPath),
      MOCK_BD_CREATE_COUNT_FILE: toBashPath(createCountFile),
      MOCK_BD_LIST_JSON: listJson,
      MOCK_BD_UNPARSEABLE_CREATE_ON: '1',
    });

    expect(result.status).toBe(1);

    const summary = JSON.parse(fs.readFileSync(path.join(artifactDir, 'summary.json'), 'utf8'));
    expect(summary.ok).toBe(false);
    expect(summary.failedStep).toBe('create');
    expect(summary.failureMessage).toContain('Could not parse primary smoke issue ID');
    expect(summary.cleanup.createdIssueIds).toEqual(['forge-smoke-1']);
    expect(summary.cleanup.closedIssueIds).toEqual(['forge-smoke-1']);

    const calls = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/);
    expect(calls).toContain('create --title=Beads upgrade smoke primary (test-run) --type=task --priority=4');
    expect(calls).toContain('list --json --limit=50');
    expect(calls).toContain('close forge-smoke-1 --reason=Beads upgrade smoke cleanup');
    expect(calls).not.toContain('close forge-stale-1 --reason=Beads upgrade smoke cleanup');
  });
});
